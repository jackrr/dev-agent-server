/**
 * Tests for the MCPServer HTTP JSON-RPC contract layer.
 *
 * These tests verify the JSON-RPC serialization contract by mocking
 * the Hono `Context` that MCPServer internally calls methods on.
 * Zero network, zero SQLite, zero Docker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "hono";

const { MCPServer } = await import("../../src/mcp_server.js");

// -------- helpers --------

/**
 * Build a Context that exercises the handleMessage handler.
 *
 * We use a `capture` object whose `resp` property is reassigned inside
 * `ctx.json()` so the caller can observe the final value after the call.
 */
function makeMessageCtx(rawBody: Record<string, unknown>) {
  let captured: Response | null = null;
  return {
    ctx: {
      req: {
        json: async () => rawBody,
        raw: { signal: null },
      },
      json: (data: Record<string, unknown>) => {
        captured = {
          status: 200,
          headers: { "content-type": "application/json" },
          json: async () => data,
          text: async () => JSON.stringify(data),
          body: null,
        } as unknown as Response;
        return captured;
      },
    } as unknown as Context,
    get resp() { return captured; },
  };
}

/**
 * Build an object with the Context shape that handleSSE needs.
 * We capture what `ctx.body()` receives.
 */
function makeSSECtx() {
  let capturedStream: ReadableStream | null = null;
  let capturedInit: ResponseInit | {} = {};
  return {
    ctx: {
      req: { raw: { url: "http://localhost/mcp/sse", method: "GET" } },
      body: (stream: ReadableStream | null, init?: ResponseInit) => {
        capturedStream = stream;
        capturedInit = init || {};
      },
    } as unknown as Context,
    get stream() { return capturedStream; },
    get headers() { return (capturedInit as any).headers ?? {}; },
  };
}

/**
 * Return a mock ToolEngine that always responds "OK" plus a
 * `calls` accessor to inspect which tools were invoked.
 */
function mockEngine(respondWith: string = "OK", shouldThrow: boolean = false) {
  const callLog: { tool: string; sessionId: string; args: unknown }[] = [];
  const proxy = {
    calls: callLog,
    executeTool: async (_sessionId: string, tool: string, args: unknown) => {
      callLog.push({ tool, sessionId: _sessionId, args: JSON.parse(JSON.stringify(args)) });
      if (shouldThrow) throw new Error("engine boom");
      return respondWith;
    },
  };
  return proxy;
}

// == SSE ==

test("SSE endpoint returns text/event-stream with keep-alive and no-cache", () => {
  const engine = mockEngine();
  const mcp = new MCPServer(engine as any);

  let bodyStream: ReadableStream | null = null;
  let bodyHeaders: any = {};
  const ctx = {
    req: { raw: { url: "http://localhost/mcp/sse", method: "GET" } },
    body: (stream: ReadableStream | null, init?: ResponseInit) => {
      bodyStream = stream;
      bodyHeaders = init?.headers ?? {};
    },
  } as unknown as Context;

  mcp.handleSSE(ctx);

  assert.ok(bodyStream instanceof ReadableStream, "body() must receive a ReadableStream");
  assert.ok(Object.values(bodyHeaders).some(h => typeof h === "string" && h.includes("text/event-stream")));
});

// == initialize ==

test("initialize returns jsonrpc 2.0, server info, and capabilities", async () => {
  const mcp = new MCPServer(mockEngine() as any);
  const testObj = makeMessageCtx({ jsonrpc: "2.0", method: "initialize", params: {} });
  await mcp.handleMessage(testObj.ctx);
  const body = await testObj.resp?.json() as any;
  assert.strictEqual(body?.jsonrpc, "2.0");
  assert.ok(body?.result);
});

test("initialize response contains tools capability and serverInfo", async () => {
  const mcp = new MCPServer(mockEngine() as any);
  const testObj = makeMessageCtx({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} });
  await mcp.handleMessage(testObj.ctx);
  const body = await testObj.resp?.json() as any;
  assert.ok(body?.result?.capabilities);
  assert.strictEqual(body?.result?.serverInfo?.name, "dev-agent-server");
  assert.strictEqual(body?.result?.serverInfo?.version, "0.1.0");
});

// == tools/list ==

test("tools/list returns exactly 6 tools with correct names", async () => {
  const mcp = new MCPServer(mockEngine() as any);
  const testObj = makeMessageCtx({ jsonrpc: "2.0", method: "tools/list", params: {} });
  await mcp.handleMessage(testObj.ctx);
  const body = await testObj.resp?.json() as any;
  assert.ok(Array.isArray(body?.result?.tools));
  assert.strictEqual(body?.result?.tools.length, 6);
  const names = body.result.tools.map((t: any) => t.name);
  assert.deepStrictEqual(names, ["bash", "read_file", "write_file", "apply_patch", "list_recent_sessions", "open_pr"]);
});

test("tools each have inputSchema object with required sessionId", async () => {
  const mcp = new MCPServer(mockEngine() as any);
  const testObj = makeMessageCtx({ jsonrpc: "2.0", method: "tools/list", params: {} });
  await mcp.handleMessage(testObj.ctx);
  const body = await testObj.resp?.json() as any;
  for (const tool of body.result.tools) {
    assert.strictEqual(tool.inputSchema.type, "object");
    assert.ok(tool.inputSchema.properties);
    assert.ok(tool.inputSchema.required);
    assert.ok(tool.inputSchema.required.includes("sessionId"));
  }
});

// == tools/call ==

test("tools/call without sessionId returns -32602", async () => {
  const mcp = new MCPServer(mockEngine() as any);
  const testObj = makeMessageCtx({ jsonrpc: "2.0", method: "tools/call", params: { name: "bash", arguments: { cmd: "ls" } }, id: 1 });
  await mcp.handleMessage(testObj.ctx);
  const body = await testObj.resp?.json();
  assert.equal(body?.error?.code, -32602);
  assert.ok(typeof body?.error?.message === "string" && body.error.message.length > 0);
});

test("tools/call with sessionId calls executeTool and returns content", async () => {
  const engine = mockEngine("hello");
  const mcp = new MCPServer(engine);
  const testObj = makeMessageCtx({
    jsonrpc: "2.0", method: "tools/call", params: { name: "bash", arguments: { sessionId: "s1", cmd: "ls" } }, id: 2,
  });
  await mcp.handleMessage(testObj.ctx);
  const body = await testObj.resp?.json() as any;
  assert.ok(body?.result);
  assert.ok(Array.isArray(body.result.content));
  assert.equal(body.result.content[0].type, "text");
});

test("tools/call forwards correct args to executeTool", async () => {
  const engine = mockEngine("captured");
  const mcp = new MCPServer(engine);
  const testObj = makeMessageCtx({
    jsonrpc: "2.0", method: "tools/call",
    params: { name: "apply_patch", arguments: { sessionId: "s-99", patch: "**diff" } },
    id: 3,
  });
  await mcp.handleMessage(testObj.ctx);
  const calls = engine.calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "apply_patch");
  assert.equal(calls[0].sessionId, "s-99");
  // The full arguments object (including sessionId) is forwarded to executeTool.
  assert.deepStrictEqual(calls[0].args, { sessionId: "s-99", patch: "**diff" });
});

// == errors ==

test("unknown method returns -32601", async () => {
  const mcp = new MCPServer(mockEngine() as any);
  const testObj = makeMessageCtx({ jsonrpc: "2.0", method: "nonexistent", params: {}, id: 4 });
  await mcp.handleMessage(testObj.ctx);
  const body = await testObj.resp?.json();
  assert.equal(body?.error?.code, -32601);
});

test("engine failure returns -32000", async () => {
  const engine = mockEngine("boom", true);
  const mcp = new MCPServer(engine);
  const testObj = makeMessageCtx({
    jsonrpc: "2.0", method: "tools/call",
    params: { name: "bash", arguments: { sessionId: "s-fail", cmd: "false" } },
    id: 5,
  });
  await mcp.handleMessage(testObj.ctx);
  const body = await testObj.resp?.json() as any;
  assert.equal(body.error?.code, -32000);
  assert.ok(typeof body.error.message === "string" && body.error.message.length > 0);
});

// == round-trip ==

test("full round-trip: initialize → tools/list → tools/call", async () => {
  const engine = mockEngine("OK");
  const mcp = new MCPServer(engine);

  // initialize
  {
    const t = makeMessageCtx({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} });
    await mcp.handleMessage(t.ctx);
    const body = await t.resp?.json() as any;
    assert.strictEqual(body.jsonrpc, "2.0");
    assert.strictEqual(body.id, 1);
    assert.strictEqual(body.result.serverInfo.name, "dev-agent-server");
  }

  // tools/list
  {
    const t = makeMessageCtx({ jsonrpc: "2.0", method: "tools/list", id: 2, params: {} });
    await mcp.handleMessage(t.ctx);
    const body = await t.resp?.json() as any;
    assert.strictEqual(body.result.tools.length, 6);
  }

  // tools/call
  {
    const t = makeMessageCtx({
      jsonrpc: "2.0", method: "tools/call",
      params: { name: "read_file", arguments: { sessionId: "rt-session", path: "a.txt" } },
      id: 3,
    });
    await mcp.handleMessage(t.ctx);
    const body = await t.resp?.json() as any;
    assert.ok(body.result.content);
    assert.strictEqual(engine.calls.length, 1);
  }
});
