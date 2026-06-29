import { test } from "node:test";
import assert from "node:assert/strict";
import { MCPServer } from "../../src/mcp_server.js";

function makeCtx(
  bodyData: Record<string, any>,
  init = { method: "GET", url: "http://localhost/mcp/test" } as RequestInit,
) {
  const body = bodyData;
  return {
    req: {
      json: async () => body,
    },
    json: (data: any) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } }),
  } as any;
}

test("initialize returns correct JSON-RPC response", async () => {
  const mockEngine = {
    executeTool: async (sessionId: string, tool: string, args: any) => {
      return JSON.stringify({ ok: true });
    }
  };

  const mcp = new MCPServer(mockEngine as any);

  const ctx = makeCtx({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }, { method: "POST" });
  const res = await mcp.handleMessage(ctx);
  const initBody = await res.json();
  assert.equal(initBody.jsonrpc, "2.0");
  assert.equal(initBody.id, 1);
  assert.ok(initBody.result);
  assert.ok(initBody.result.capabilities);
});

test("tools/list returns valid tool list", async () => {
  const mockEngine = {
    executeTool: async (sessionId: string, tool: string, args: any) => {
      return JSON.stringify({ ok: true });
    }
  };

  const mcp = new MCPServer(mockEngine as any);

  const ctx = makeCtx({ jsonrpc: "2.0", method: "tools/list", id: 2, params: {} }, { method: "POST" });
  const res = await mcp.handleMessage(ctx);
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.ok(Array.isArray(body.result.tools));
  assert.equal(body.result.tools.length, 6);
});

test("tools/call returns error when sessionId missing", async () => {
  const mockEngine = {
    executeTool: async (sessionId: string, tool: string, args: any) => {
      return JSON.stringify({ ok: true });
    }
  };

  const mcp = new MCPServer(mockEngine as any);

  const ctx = makeCtx({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "bash", arguments: {} },
    id: 3,
  }, { method: "POST" });

  const res = await mcp.handleMessage(ctx);
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.ok(body.error);
  assert.equal(body.error.code, -32602);
});

test("unknown method returns -32601", async () => {
  const mockEngine = {
    executeTool: async (sessionId: string, tool: string, args: any) => {
      return JSON.stringify({ ok: true });
    }
  };

  const mcp = new MCPServer(mockEngine as any);

  const ctx = makeCtx({
    jsonrpc: "2.0",
    method: "nonexistent_method",
    params: {},
    id: 4,
  }, { method: "POST" });

  const res = await mcp.handleMessage(ctx);
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 4);
  assert.ok(body.error);
  assert.equal(body.error.code, -32601);
});
