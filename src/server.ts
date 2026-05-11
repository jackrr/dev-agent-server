import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { DB } from "./db.js";
import { Workspace } from "./workspace.js";
import { SandboxManager } from "./sandbox.js";
import { GitHub } from "./github.js";
import { Agent, type AgentEvent } from "./agent.js";
import { loadProjectConfig, type ProjectConfig } from "./project_config.js";
import { parseReport } from "./report_parser.js";
import { cfAccessAuth } from "./auth.js";
import { ArtifactPoller } from "./poller.js";

// ---------- env ----------
function envRequired(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

const PORT = Number(process.env.PORT || 3000);
const TARGET_REPO = envRequired("TARGET_REPO");
const ANTHROPIC_API_KEY = envRequired("ANTHROPIC_API_KEY");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.resolve("./workspaces");
const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");
const TRUST_LOCAL = process.env.DEV_AGENT_TRUST_LOCAL === "1";
const CF_TEAM = process.env.CF_ACCESS_TEAM_DOMAIN || "";
const CF_AUD = process.env.CF_ACCESS_AUD || "";
const SANDBOX_NETWORK = process.env.SANDBOX_NETWORK || "agent_egress";
const PROXY_URL = process.env.PROXY_URL || "http://proxy:8888";
const FALLBACK_IMAGE = process.env.FALLBACK_SANDBOX_IMAGE || "dev-agent/sandbox-base:latest";
const SECCOMP_PROFILE = process.env.SECCOMP_PROFILE || path.resolve("./sandbox/seccomp.json");
// Path as the engine (docker/podman daemon on the host) sees it. Only differs
// from SECCOMP_PROFILE when the server itself runs in a container.
const SECCOMP_PROFILE_HOST = process.env.SECCOMP_PROFILE_HOST || undefined;

// `ANTHROPIC_API_KEY` is read by the SDK directly; just ensure it's set.
void ANTHROPIC_API_KEY;

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
  console.log(`[boot] project: ${projectConfig.name}${projectConfig.ship ? " (ship enabled)" : " (chat-only)"}`);
} else {
  console.log("[boot] no .dev-agent/config.yaml — running in generic mode");
}

const sandbox = new SandboxManager({
  network: SANDBOX_NETWORK,
  proxyUrl: PROXY_URL,
  githubToken: GITHUB_TOKEN,
  seccompProfile: SECCOMP_PROFILE,
  seccompProfileHost: SECCOMP_PROFILE_HOST,
  fallbackImage: FALLBACK_IMAGE,
  userns: process.env.SANDBOX_USERNS || undefined,
  userSpec: process.env.SANDBOX_USER ?? undefined,
  engineCli: process.env.ENGINE_CLI || undefined,
  imageMaxAgeDays: process.env.SANDBOX_IMAGE_MAX_AGE_DAYS
    ? Number(process.env.SANDBOX_IMAGE_MAX_AGE_DAYS)
    : undefined,
});

// Prune stale sandbox images on boot and then daily. Best-effort; failures
// are swallowed inside pruneOldImages so they can't crash the server.
try { sandbox.pruneOldImages(); } catch (e) { console.error("[sandbox] prune error:", e); }
setInterval(() => {
  try { sandbox.pruneOldImages(); } catch (e) { console.error("[sandbox] prune error:", e); }
}, 24 * 60 * 60 * 1000).unref();

const github = GITHUB_TOKEN ? new GitHub(TARGET_REPO, GITHUB_TOKEN) : null;

const agent = new Agent({
  db,
  workspace,
  sandbox,
  github,
  projectConfig,
  mainWorktree: workspace.mainDir,
});

if (projectConfig?.ship && github) {
  const poller = new ArtifactPoller(db, github, projectConfig);
  poller.start();
}

// ---------- app ----------
const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

const auth = cfAccessAuth({
  teamDomain: CF_TEAM,
  audience: CF_AUD,
  trustLocal: TRUST_LOCAL,
});

const api = new Hono();
api.use("*", auth);

api.get("/project", (c) =>
  c.json({
    name: projectConfig?.name ?? TARGET_REPO,
    description: projectConfig?.description ?? null,
    shipEnabled: !!projectConfig?.ship,
    targetRepo: TARGET_REPO,
  }),
);

api.post("/sessions", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    initial_report?: string;
    title?: string;
  };
  const sessionId = newSessionId();
  const parsed = body.initial_report ? parseReport(body.initial_report) : null;
  const title =
    (body.title && body.title.trim()) ||
    deriveTitle(parsed?.description) ||
    `Session ${sessionId.slice(0, 8)}`;

  // Create the worktree.
  let worktreePath: string;
  if (projectConfig?.ship) {
    worktreePath = workspace.createSessionWorktree({
      sessionId,
      baseBranch: projectConfig.ship.baseBranch,
      branchPrefix: projectConfig.ship.branchPrefix,
    });
  } else {
    worktreePath = workspace.createGenericWorktree(sessionId);
  }

  const session = db.createSession({
    id: sessionId,
    title,
    description: parsed?.description,
    device: parsed?.device,
    worktreePath,
  });

  // Persist app contexts verbatim.
  if (parsed) {
    for (const ac of parsed.appContexts) {
      db.putAppContext(sessionId, ac.name, ac.content, ac.attrs);
    }
  }

  // Seed the conversation with the raw report wrapped in <report>...</report>.
  if (body.initial_report) {
    db.appendMessage({
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content: `<report>\n${body.initial_report}\n</report>`,
    });
  }

  return c.json({
    id: session.id,
    title: session.title,
    created_at: session.created_at,
  });
});

api.get("/sessions", (c) => {
  const rows = db.listSessions().map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    created_at: s.created_at,
    last_message_at: s.last_message_at,
  }));
  return c.json(rows);
});

api.get("/sessions/:id", (c) => {
  const id = c.req.param("id");
  const session = db.getSession(id);
  if (!session) return c.json({ error: "not found" }, 404);
  const messages = db.listMessages(id).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
  }));
  const app_contexts = db.listAppContexts(id);
  return c.json({ session, messages, app_contexts });
});

api.get("/sessions/:id/pr", (c) => {
  const id = c.req.param("id");
  const link = db.getPrLink(id);
  if (!link) return c.json({});
  return c.json({
    pr_number: link.pr_number,
    pr_url: link.pr_url,
    artifact_url: link.artifact_url,
    qr_url: link.qr_url,
  });
});

api.post("/sessions/:id/messages", (c) => {
  const id = c.req.param("id");
  const session = db.getSession(id);
  if (!session) return c.json({ error: "not found" }, 404);

  return streamSSE(c, async (stream) => {
    const send = async (event: string, data: unknown) => {
      await stream.writeSSE({ event, data: JSON.stringify(data) });
    };

    try {
      const body = (await c.req.json()) as { content: string };
      if (!body.content || typeof body.content !== "string") {
        await send("error", { message: "content is required" });
        return;
      }
      db.appendMessage({
        id: crypto.randomUUID(),
        sessionId: id,
        role: "user",
        content: body.content,
      });
      const history = db.listMessages(id);
      await agent.runTurn({
        sessionId: id,
        history,
        emit: (e: AgentEvent) => {
          // Fire-and-forget; SSE writes are async but ordering is preserved within the queue.
          void send(e.type, e);
        },
      });
    } catch (e) {
      await send("error", { message: (e as Error).message });
    }
  });
});

app.route("/api", api);

// Static UI.
const publicDir = path.resolve("./public");
if (fs.existsSync(publicDir)) {
  const appJsPath = path.join(publicDir, "app.js");
  const indexHtmlPath = path.join(publicDir, "index.html");

  /**
   * Content-hash of app.js. Rewriting the <script src="/app.js?v=HASH"> in
   * index.html guarantees browsers fetch the new JS whenever its content
   * changes — even past aggressive mobile caches — and never re-fetch when
   * nothing changed. Re-read per-request so `npm run dev` (no server restart)
   * still picks up edits to public/. Cost: one sha256 over a small file.
   */
  function readAppJs(): { body: string; version: string } {
    const body = fs.readFileSync(appJsPath, "utf8");
    const version = crypto.createHash("sha256").update(body).digest("hex").slice(0, 12);
    return { body, version };
  }

  app.get("/", (c) => {
    const { version } = readAppJs();
    const html = fs.readFileSync(indexHtmlPath, "utf8").replace(
      /(<script[^>]*\bsrc=["']\/app\.js)(\?[^"']*)?(["'])/,
      `$1?v=${version}$3`,
    );
    // no-cache on HTML so the latest ?v= hash always reaches the client.
    return c.html(html, 200, { "cache-control": "no-cache, must-revalidate" });
  });
  app.use(
    "/static/*",
    serveStatic({ root: "./public", rewriteRequestPath: (p) => p.replace(/^\/static/, "") }),
  );
  app.get("/app.js", (c) => {
    const { body, version } = readAppJs();
    return c.body(body, 200, {
      "content-type": "application/javascript",
      // Long-lived cache is safe because the URL changes when content changes.
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${version}"`,
    });
  });
}

// ---------- listen ----------
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[ready] dev-agent-server listening on :${info.port}`);
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

// ---------- helpers ----------
function newSessionId(): string {
  // 8-byte hex, prefixed for readability in branch names.
  return crypto.randomBytes(6).toString("hex");
}

function deriveTitle(description: string | undefined): string | null {
  if (!description) return null;
  const firstLine = description.trim().split(/\r?\n/)[0]?.trim();
  if (!firstLine) return null;
  return firstLine.slice(0, 80);
}
