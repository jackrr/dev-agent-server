import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DB } from "./db.js";
import { Workspace } from "./workspace.js";
import { SandboxManager } from "./sandbox.js";
import { GitHub } from "./github.js";
import { ToolEngine } from "./tool_engine.js";
import { MCPServer } from "./mcp_server.js";
import { loadProjectConfig, type ProjectConfig } from "./project_config.js";
import { syncProxyAllowlist } from "./proxy.js";
import { apiKeyAuth } from "./api_auth.js";

// ---------- env ----------
function envRequired(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

const PORT = Number(process.env.PORT || 3000);
const TARGET_REPO = envRequired("TARGET_REPO");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.resolve("./workspaces");
const WORKSPACE_DIR_HOST = process.env.WORKSPACE_DIR_HOST || undefined;
const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");
const SANDBOX_NETWORK = process.env.SANDBOX_NETWORK || "agent_egress";
const PROXY_URL = process.env.PROXY_URL || "http://proxy:8888";
const PROXY_PROJECT_FILE = process.env.PROXY_PROJECT_FILE || path.resolve("./proxy/project.txt");
const FALLBACK_IMAGE = process.env.FALLBACK_SANDBOX_IMAGE || "dev-agent/sandbox-base:latest";
const SECCOMP_PROFILE = process.env.SECCOMP_PROFILE || path.resolve("./sandbox/seccomp.json");
const SECCOMP_PROFILE_HOST = process.env.SECCOMP_PROFILE_HOST || undefined;
const ENGINE_CLI = process.env.ENGINE_CLI || "docker";
const PROXY_CONTAINER = process.env.PROXY_CONTAINER || "dev-agent-proxy";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 24 * 60 * 60 * 1000;
const REAPER_INTERVAL_MS = Number(process.env.REAPER_INTERVAL_MS) || 60 * 60 * 1000;

// ---------- bootstrap ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

const db = new DB(path.join(DATA_DIR, "dev-agent.sqlite"));
const workspace = new Workspace({
  root: WORKSPACE_DIR,
  targetRepo: TARGET_REPO,
  githubToken: GITHUB_TOKEN,
});

console.log(`[boot] cloning/fetching target repo: ${TARGET_REPO}`);
workspace.ensureMainClone();

const projectConfig: ProjectConfig | null = loadProjectConfig(workspace.mainDir);
if (projectConfig) {
  console.log(`[boot] project: ${projectConfig.name}${projectConfig.ship ? " (ship enabled)" : " (tool-only)"}`);
} else {
  console.log("[boot] no .dev-agent/config.yaml — running in generic mode");
}

const proxySyncConfig = {
  proxyProjectFile: PROXY_PROJECT_FILE,
  proxyContainer: PROXY_CONTAINER,
  engineCli: ENGINE_CLI,
};

const syncProxy = () => syncProxyAllowlist(proxySyncConfig, workspace.mainDir);
syncProxy();

const sandbox = new SandboxManager({
  network: SANDBOX_NETWORK,
  proxyUrl: PROXY_URL,
  githubToken: GITHUB_TOKEN,
  seccompProfile: SECCOMP_PROFILE,
  seccompProfileHost: SECCOMP_PROFILE_HOST,
  workspaceDir: WORKSPACE_DIR,
  workspaceDirHost: WORKSPACE_DIR_HOST,
  fallbackImage: FALLBACK_IMAGE,
  userns: process.env.SANDBOX_USERNS || undefined,
  userSpec: process.env.SANDBOX_USER ?? undefined,
  engineCli: ENGINE_CLI,
  imageMaxAgeDays: process.env.SANDBOX_IMAGE_MAX_AGE_DAYS
    ? Number(process.env.SANDBOX_IMAGE_MAX_AGE_DAYS)
    : undefined,
});

try { sandbox.pruneOldImages(); } catch (e) { console.error("[sandbox] prune error:", e); }
setInterval(() => {
  try { sandbox.pruneOldImages(); } catch (e) { console.error("[sandbox] prune error:", e); }
}, 24 * 60 * 60 * 1000).unref();

// session reaper: clean up idle sessions
setInterval(() => {
  try {
    const expiryDate = new Date(Date.now() - SESSION_TTL_MS).toISOString();
    const expiredIds = db.getExpiredSessions(expiryDate);
    
    if (expiredIds.length === 0) return;
    
    console.log(`[reaper] cleaning up ${expiredIds.length} expired sessions`);
    for (const id of expiredIds) {
      sandbox.destroy(id);
      workspace.removeSessionWorktree(id);
      db.deleteSession(id);
    }
  } catch (e) {
    console.error("[reaper] error:", e);
  }
}, REAPER_INTERVAL_MS).unref();

const github = GITHUB_TOKEN ? new GitHub(TARGET_REPO, GITHUB_TOKEN) : null;

const toolEngine = new ToolEngine({
  db,
  workspace,
  sandbox,
  github,
  projectConfig,
  mainWorktree: workspace.mainDir,
  syncProxy,
});

const mcp = new MCPServer(toolEngine);

// ---------- app ----------
const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

// Use API Key auth for all MCP and API endpoints.
app.use("/mcp/*", apiKeyAuth());
app.use("/api/*", apiKeyAuth());

// MCP SSE transport
app.get("/mcp/sse", (c) => mcp.handleSSE(c));
app.post("/mcp/messages", (c) => mcp.handleMessage(c));

// Basic API for session management (optional, but useful for cleanup)
const api = new Hono();

api.get("/project", (c) =>
  c.json({
    name: projectConfig?.name ?? TARGET_REPO,
    description: projectConfig?.description ?? null,
    shipEnabled: !!projectConfig?.ship,
    targetRepo: TARGET_REPO,
  }),
);

api.get("/sessions", (c) => {
  const rows = db.listSessions().map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    created_at: s.created_at,
    last_active: s.last_message_at,
  }));
  return c.json(rows);
});

api.delete("/sessions/:id", (c) => {
  const id = c.req.param("id");
  const session = db.getSession(id);
  if (!session) return c.json({ error: "not found" }, 404);

  sandbox.destroy(id);
  workspace.removeSessionWorktree(id);
  db.deleteSession(id);

  return c.json({ deleted: true });
});

app.route("/api", api);

// ---------- listen ----------
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[ready] dev-agent-server (MCP) listening on :${info.port}`);
});

process.on("SIGTERM", () => {
  console.log("[shutdown] destroying sandbox containers");
  sandbox.destroyAll();
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[shutdown] destroying sandbox containers");
  sandbox.destroyAll();
  process.exit(0);
});
