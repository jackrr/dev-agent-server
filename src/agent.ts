import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { DB, MessageRow } from "./db.js";
import type { ProjectConfig } from "./project_config.js";
import type { SandboxManager } from "./sandbox.js";
import type { Workspace } from "./workspace.js";
import type { GitHub } from "./github.js";

/**
 * Drives a single Claude agent turn (or sequence of turns until the model stops calling tools)
 * for a given session. Streams events as SSE-friendly objects through a callback.
 */

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string }
  | { type: "done"; messageId: string }
  | { type: "error"; message: string };

const BASE_PROMPT = `You are a software engineer. You are working in a git worktree of the project repository. Your task is to understand the user's report and propose or implement a fix. When \`open_pr\` is available, opening a PR is the only ship mechanism — never push to the base branch directly.`;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const MAX_TOOL_TURNS = 40;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_BASH_BYTES = 32 * 1024;

export interface AgentDeps {
  db: DB;
  workspace: Workspace;
  sandbox: SandboxManager;
  github: GitHub | null;
  projectConfig: ProjectConfig | null;
  mainWorktree: string;
}

export class Agent {
  private anthropic: Anthropic;

  constructor(private deps: AgentDeps) {
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  /** Builds the system prompt once per session per turn — cheap to recompute. */
  systemPrompt(session: { id: string }): string {
    const parts: string[] = [BASE_PROMPT];
    const cfg = this.deps.projectConfig;
    if (cfg) {
      for (const rel of cfg.agent.contextFiles) {
        const p = path.join(this.deps.mainWorktree, rel);
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, "utf8");
          parts.push(`<project-context file="${rel}">\n${content}\n</project-context>`);
        }
      }
      if (cfg.agent.promptFile) {
        const p = path.join(this.deps.mainWorktree, cfg.agent.promptFile);
        if (fs.existsSync(p)) parts.push(fs.readFileSync(p, "utf8"));
      }
    }
    return parts.join("\n\n");
  }

  /** Tool schemas exposed to the model. `open_pr` only when ship: is configured. */
  tools(): Anthropic.Messages.Tool[] {
    const tools: Anthropic.Messages.Tool[] = [
      {
        name: "bash",
        description:
          "Run a bash command inside the per-session sandbox container. cwd is /workspace. Output is truncated to 32 KB.",
        input_schema: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
      },
      {
        name: "read_file",
        description: "Read a file from the workspace. Path is relative to /workspace. Max 100 KB.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write a file to the workspace. Path is relative to /workspace.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "apply_patch",
        description: "Apply a unified diff (-p1) on top of /workspace via the `patch` command.",
        input_schema: {
          type: "object",
          properties: { patch: { type: "string" } },
          required: ["patch"],
        },
      },
      {
        name: "list_recent_sessions",
        description:
          "List recent sessions on this server with their titles and short descriptions, for cross-referencing similar reports.",
        input_schema: {
          type: "object",
          properties: { limit: { type: "number" } },
          required: ["limit"],
        },
      },
    ];

    if (this.deps.projectConfig?.ship && this.deps.github) {
      tools.push({
        name: "open_pr",
        description:
          "Commit any pending changes in the worktree, push the session branch, and open a GitHub pull request.",
        input_schema: {
          type: "object",
          properties: { title: { type: "string" }, body: { type: "string" } },
          required: ["title", "body"],
        },
      });
    }
    return tools;
  }

  /**
   * Runs one user→assistant turn. Streams tokens + tool calls/results through `emit`.
   * Persists the final assistant message + intermediate tool_result messages to SQLite.
   */
  async runTurn(args: {
    sessionId: string;
    history: MessageRow[];
    emit: (e: AgentEvent) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const { sessionId, history, emit } = args;
    const session = this.deps.db.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);

    // Convert DB history → Anthropic message list. Tool calls/results are stored
    // as JSON inside `messages.content` for assistant/tool_result roles.
    type AnyContentBlocks = Exclude<Anthropic.Messages.MessageParam["content"], string>;
    const messages: Anthropic.Messages.MessageParam[] = [];
    for (const m of history) {
      if (m.role === "user") {
        messages.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        try {
          const blocks = JSON.parse(m.content) as AnyContentBlocks;
          messages.push({ role: "assistant", content: blocks });
        } catch {
          messages.push({ role: "assistant", content: m.content });
        }
      } else if (m.role === "tool_result") {
        try {
          const blocks = JSON.parse(m.content) as AnyContentBlocks;
          messages.push({ role: "user", content: blocks });
        } catch {
          messages.push({ role: "user", content: m.content });
        }
      }
    }

    const system = this.systemPrompt(session);
    const tools = this.tools();

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      if (args.signal?.aborted) {
        emit({ type: "error", message: "cancelled by user" });
        return;
      }
      const stream = this.anthropic.messages.stream({
        model: MODEL,
        max_tokens: 4096,
        system,
        tools,
        messages,
      });

      stream.on("text", (delta) => emit({ type: "token", text: delta }));

      // Abort the in-flight Anthropic request if the user cancels.
      const onAbort = () => stream.abort();
      args.signal?.addEventListener("abort", onAbort, { once: true });

      let final: Anthropic.Messages.Message;
      try {
        final = await stream.finalMessage();
      } catch (e) {
        if (args.signal?.aborted) {
          emit({ type: "error", message: "cancelled by user" });
          return;
        }
        throw e;
      } finally {
        args.signal?.removeEventListener("abort", onAbort);
      }

      // Persist the assistant message with full content blocks (so tool_use ids are preserved).
      const assistantMsgId = crypto.randomUUID();
      this.deps.db.appendMessage({
        id: assistantMsgId,
        sessionId,
        role: "assistant",
        content: JSON.stringify(final.content),
      });
      messages.push({ role: "assistant", content: final.content });

      const toolUses = final.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0 || final.stop_reason === "end_turn") {
        emit({ type: "done", messageId: assistantMsgId });
        return;
      }

      // Execute each tool and build a tool_result content array for the next user turn.
      const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (args.signal?.aborted) {
          emit({ type: "error", message: "cancelled by user" });
          return;
        }
        emit({ type: "tool_call", name: tu.name, input: tu.input });
        let outText: string;
        let isError = false;
        try {
          outText = await this.dispatchTool(sessionId, tu.name, tu.input, args.signal);
        } catch (e) {
          outText = `error: ${(e as Error).message}`;
          isError = true;
        }
        emit({ type: "tool_result", name: tu.name, output: outText });
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: outText,
          is_error: isError || undefined,
        });
      }
      const toolResultMsgId = crypto.randomUUID();
      this.deps.db.appendMessage({
        id: toolResultMsgId,
        sessionId,
        role: "tool_result",
        content: JSON.stringify(toolResultBlocks),
      });
      messages.push({ role: "user", content: toolResultBlocks });
    }

    emit({ type: "error", message: `tool-call limit (${MAX_TOOL_TURNS}) exceeded` });
  }

  // ---------- tool dispatch ----------

  private async dispatchTool(
    sessionId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const args = (input ?? {}) as Record<string, unknown>;
    switch (name) {
      case "bash":
        return await this.toolBash(sessionId, asString(args.cmd, "cmd"), signal);
      case "read_file":
        return await this.toolReadFile(sessionId, asString(args.path, "path"), signal);
      case "write_file":
        return await this.toolWriteFile(
          sessionId,
          asString(args.path, "path"),
          asString(args.content, "content"),
          signal,
        );
      case "apply_patch":
        return await this.toolApplyPatch(sessionId, asString(args.patch, "patch"), signal);
      case "list_recent_sessions": {
        const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)));
        const rows = this.deps.db.recentSessions(limit);
        return JSON.stringify(rows);
      }
      case "open_pr":
        return await this.toolOpenPr(
          sessionId,
          asString(args.title, "title"),
          asString(args.body, "body"),
        );
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  private async ensureContainer(sessionId: string): Promise<void> {
    const session = this.deps.db.getSession(sessionId);
    if (!session?.worktree_path) throw new Error("session has no worktree");
    const image = this.deps.sandbox.resolveImage(
      this.deps.projectConfig,
      this.deps.mainWorktree,
    );
    await this.deps.sandbox.ensureContainer({
      sessionId,
      image,
      worktreePath: session.worktree_path,
      preflight: this.deps.projectConfig?.agent.preflight,
    });
  }

  private async toolBash(sessionId: string, cmd: string, signal?: AbortSignal): Promise<string> {
    await this.ensureContainer(sessionId);
    const r = await this.deps.sandbox.exec(sessionId, cmd, { maxBytes: MAX_BASH_BYTES, signal });
    let out = "";
    if (r.stdout) out += r.stdout;
    if (r.stderr) out += (out ? "\n" : "") + `[stderr]\n${r.stderr}`;
    out += `\n[exit ${r.exitCode}${r.truncated ? "; truncated" : ""}]`;
    return out;
  }

  private async toolReadFile(sessionId: string, relPath: string, signal?: AbortSignal): Promise<string> {
    await this.ensureContainer(sessionId);
    // Just shell out to `cat` inside the sandbox — keeps mount semantics consistent
    // and respects per-container view of the workspace.
    const safe = relPath.replace(/'/g, "'\\''");
    const r = await this.deps.sandbox.exec(sessionId, `cat -- '${safe}'`, {
      maxBytes: MAX_FILE_BYTES,
      signal,
    });
    if (r.exitCode !== 0) throw new Error(`read_file failed: ${r.stderr.trim() || r.stdout}`);
    return r.stdout;
  }

  private async toolWriteFile(
    sessionId: string,
    relPath: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.ensureContainer(sessionId);
    // Stream content via stdin to avoid argv length / quoting limits.
    // We use the sandbox exec but with a heredoc-style approach via bash -c reading from $0.
    // Simplest: write through a tee invocation. Path is relative to /workspace.
    const safePath = relPath.replace(/'/g, "'\\''");
    // Encode content as base64 to avoid any quoting issues.
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const cmd = `mkdir -p "$(dirname '${safePath}')" && echo '${b64}' | base64 -d > '${safePath}'`;
    const r = await this.deps.sandbox.exec(sessionId, cmd, { signal });
    if (r.exitCode !== 0) throw new Error(`write_file failed: ${r.stderr.trim() || r.stdout}`);
    return `wrote ${content.length} bytes to ${relPath}`;
  }

  private async toolApplyPatch(sessionId: string, patch: string, signal?: AbortSignal): Promise<string> {
    await this.ensureContainer(sessionId);
    const b64 = Buffer.from(patch, "utf8").toString("base64");
    const cmd = `echo '${b64}' | base64 -d | patch -p1`;
    const r = await this.deps.sandbox.exec(sessionId, cmd, { signal });
    if (r.exitCode !== 0) throw new Error(`patch failed: ${r.stderr.trim() || r.stdout}`);
    return r.stdout;
  }

  private async toolOpenPr(sessionId: string, title: string, body: string): Promise<string> {
    const cfg = this.deps.projectConfig;
    if (!cfg?.ship || !this.deps.github) throw new Error("open_pr is not enabled for this project");
    await this.ensureContainer(sessionId);

    // Stage + commit any pending changes inside the sandbox, then push from the host
    // (the host has gh + git auth; the sandbox is intentionally limited).
    const session = this.deps.db.getSession(sessionId);
    if (!session?.worktree_path) throw new Error("session has no worktree");

    const commitMsg = title.replace(/'/g, "'\\''");
    const stage = await this.deps.sandbox.exec(
      sessionId,
      `git -c user.email=agent@dev-agent.local -c user.name="dev-agent" add -A && \
       (git diff --cached --quiet && echo "no changes to commit" || \
        git -c user.email=agent@dev-agent.local -c user.name="dev-agent" commit -m '${commitMsg}')`,
    );
    if (stage.exitCode !== 0) {
      throw new Error(`pre-PR commit failed: ${stage.stderr || stage.stdout}`);
    }

    const branch = `${cfg.ship.branchPrefix}${sessionId}`;
    const result = this.deps.github.openPr({
      worktreePath: session.worktree_path,
      branch,
      baseBranch: cfg.ship.baseBranch,
      title,
      body,
    });
    this.deps.db.upsertPrLink({
      session_id: sessionId,
      pr_number: result.prNumber,
      pr_url: result.prUrl,
    });
    return JSON.stringify(result);
  }
}

function asString(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`${name} must be a string`);
  return v;
}
