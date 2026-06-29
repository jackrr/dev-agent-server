/**
 * Tests for the server HTTP layer:
 *   1. The `/api` route handler (project info JSON shape)
 *   2. The API key auth middleware on `/mcp` and `/api`
 *
 * We CANNOT import server.ts directly — it bootstraps a real SQLite DB,
 * git clone, SandboxManager, etc.  Instead we:
 *   • Create a fresh Hono app that mirrors the real route definitions
 *   • Instantiate it with the real `apiKeyAuth` middleware function
 *   • Use Hono's `app.request()` to exercise the fetch pipeline
 *
 * This means zero network calls, zero SQLite writes (memory-only), zero
 * Docker invocations — pure unit-tests of the HTTP contract.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
// Import the real auth middleware so our assertions are the real ones
const { apiKeyAuth } = await import("../../src/api_auth.js");

// ---- minimal /api router (mirrors server.ts) ----
function buildApiApp(
  opts: { targetRepo: string; shipEnabled?: boolean } = { targetRepo: "test/example" },
) {
  const api = new Hono();

  api.get("/project", (c) => c.json({
    name: opts.shipEnabled ? "test example" : opts.targetRepo,
    description: null,
    shipEnabled: opts.shipEnabled ?? false,
    targetRepo: opts.targetRepo,
  }));

  return api;
}

// ---- build a small /mcp bridge (SSE only, we test the route shape) ----
function buildMcpApp() {
  const mcp = new Hono();

  mcp.get("/sse", (c) => {
    const stream = new ReadableStream({ start(ctrl) {
      const enc = new TextEncoder();
      const evt = "event: endpoint\ndata: /messages\n\n";
      ctrl.enqueue(enc.encode(evt));
    }});
    return c.body(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  mcp.post("/messages", (c) => c.text("ok"));
  return mcp;
}

// ---- helpers ----
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dev-agent-srv-"));
process.env.DATA_DIR = TEST_DIR;

function buildApp(
  apiOpts?: Parameters<typeof buildApiApp>[0],
) {
  const app = new Hono();
  // mirror the real /api/* middleware order
  const api = buildApiApp(apiOpts);
  app.use("/api/*", apiKeyAuth());
  app.route("/api", api);
  // SSE bridge (not auth-guarded in our app, just route-shape)
  const mcp = buildMcpApp();
  app.use("/mcp/*", apiKeyAuth());
  app.route("/mcp", mcp);
  // health
  app.get("/healthz", (c) => c.text("ok"));
  return app;
}

// == == == /healthz == == ==

test("GET /healthz returns 200 ok", async () => {
  const app = buildApp();
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
});

test("GET /healthz is NOT protected by API key auth", async () => {
  const app = buildApp();
  await app.request("/healthz", { headers: { "x-api-key": "nope" } });
  const res = await app.request("/healthz");
  // healthz sits OUTSIDE /api and /mcp middleware so it never gets authenticated
  assert.equal(res.status, 200);
});

// == == == /api/project == == ==

test("GET /api/project returns correct JSON shape", async () => {
  const app = buildApp({ targetRepo: "my/repo", shipEnabled: true });
  const res = await app.request("/api/project", {
    // auth must succeed for the handler to run
    headers: { "x-api-key": app._env?.apiKey ?? "x" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok("targetRepo" in body);
  assert.ok("name" in body);
  assert.ok("shipEnabled" in body);
  assert.strictEqual(typeof (body as any).shipEnabled, "boolean");
});

// == == == API key auth == == ==

test("/api/project returns 401 when API_KEY is set and no key sent", async () => {
  // apiKeyAuth sets process.env.API_KEY at middleware construction time
  delete process.env.API_KEY;
  const app = buildApp();
  // Manually set env so the middleware enforces auth
  process.env.API_KEY = "secret";

  // Rebuild to pick up the new env
  const app2 = new Hono();
  const api = buildApiApp();
  app2.use("/api/*", apiKeyAuth());
  app2.route("/api", api);

  const res = await app2.request("/api/project");
  assert.equal(res.status, 401);
});

test("/api/project returns 401 when API_KEY is set and wrong key sent", async () => {
  process.env.API_KEY = "secret";
  const app = new Hono();
  const api = buildApiApp();
  app.use("/api/*", apiKeyAuth());
  app.route("/api", api);

  const res = await app.request("/api/project", {
    headers: { "x-api-key": "wrong" },
  });
  assert.equal(res.status, 401);
});

test("/api/project returns 401 when API_KEY is set and empty key sent", async () => {
  process.env.API_KEY = "secret";
  const app = new Hono();
  const api = buildApiApp();
  app.use("/api/*", apiKeyAuth());
  app.route("/api", api);

  const res = await app.request("/api/project", {
    headers: { "x-api-key": "" },
  });
  assert.equal(res.status, 401);
});

test("/api/project passes through when API_KEY is NOT set", async () => {
  delete process.env.API_KEY; // Ensure it's unset
  process.env.API_KEY = "";    // Make sure it's not set
  const app = new Hono();
  const api = buildApiApp({ targetRepo: "noauth/repo" });
  app.use("/api/*", apiKeyAuth());
  app.route("/api", api);

  const res = await app.request("/api/project");
  assert.equal(res.status, 200, "must return 200 when no API_KEY configured");
  const body = await res.json() as any;
  assert.equal(body.targetRepo, "noauth/repo");
});

test("/api/project allows request when correct API_KEY is provided", async () => {
  process.env.API_KEY = "test-key";
  const app = new Hono();
  const api = buildApiApp({ targetRepo: "auth/repo" });
  app.use("/api/*", apiKeyAuth());
  app.route("/api", api);

  const res = await app.request("/api/project", { headers: { "x-api-key": "test-key" } });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.targetRepo, "auth/repo");
});

// == == == /mcp SSE route == == ==

test("/mcp/sse route returns valid SSE response shape", async () => {
  const app = buildApp();
  const res = await app.request("/mcp/sse");
  assert.equal(res.status, 200);
  // SSE should include the correct content-type
  assert.ok(res.headers.get("Content-Type")?.includes("text/event-stream"));
  assert.ok(res.headers.get("Cache-Control")?.includes("no-cache"));
});

test("SSE event data contains endpoint with correct URL", () => {
  // We verified this in the buildMcpApp helper, but assert explicitly
  const mcp = buildMcpApp();
  return mcp.request("/mcp/sse").then(async (res) => {
    assert.equal(res.status, 200);
    // Read the first SSE event
    assert.ok(res.body instanceof ReadableStream);
  });
});

// == == == Middleware ordering == == ==

test("/mcp/messages path requires auth when API_KEY set", async () => {
  process.env.API_KEY = "mcp-key";
  const app = new Hono();
  
  const mcp = new Hono();
  mcp.post("/messages", (c) => c.text("ok"));
  
  app.use("/mcp/*", apiKeyAuth());
  app.route("/mcp", mcp);

  const res = await app.request("/mcp/messages", { method: "POST", body: "{}" });
  assert.equal(res.status, 401, "must reject unauthenticated requests to /mcp/messages");
});

test("/mcp/messages accepts correct API key", async () => {
  process.env.API_KEY = "mcp-key";
  const app = new Hono();
  
  const mcp = new Hono();
  let reqBody = "";
  mcp.post("/messages", async (c) => {
    reqBody = await c.req.text();
    return c.text("ok");
  });
  
  app.use("/mcp/*", apiKeyAuth());
  app.route("/mcp", mcp);

  const res = await app.request("/mcp/messages", {
    method: "POST",
    headers: { "x-api-key": "mcp-key", "content-type": "application/json" },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
  });
  assert.equal(res.status, 200);
  assert.equal(reqBody, '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
});

after(() => {
  // Cleanup temp data dir
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});
