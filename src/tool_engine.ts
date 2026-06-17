import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";
import type { ProjectConfig } from "./project_config.js";
import type { SandboxManager } from "./sandbox.js";
import type { GitHub } from "./github.js";
import type { Workspace } from "./workspace.js";

const MAX_FILE_BYTES = 100 * 1024;
const MAX_BASH_BYTES = 32 * 1024;

export interface ToolEngineDeps {
  db: DB;
  workspace: Workspace;
  sandbox: SandboxManager;
  github: GitHub | null;
  projectConfig: ProjectConfig | null;
  mainWorktree: string;
  syncProxy: () => void;
}

export class ToolEngine {
  constructor(private deps: ToolEngineDeps) {}

  async executeTool(
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
    let session = this.deps.db.getSession(sessionId);
    if (!session) {
      console.log(`[provision] session ${sessionId} not found, provisioning...`);
      session = await this.provisionSession(sessionId);
    }

    if (!session?.worktree_path) throw new Error("session has no worktree");
    const image = this.deps.sandbox.resolveImage(
      this.deps.projectConfig,
      this.deps.mainWorktree,
    );
    await this.deps.sandbox.ensureContainer({
      sessionId,
      image,
      worktreePath: session.worktree_path,
      mainGitDir: path.join(this.deps.mainWorktree, ".git"),
      preflight: this.deps.projectConfig?.agent.preflight,
    });
  }

  private async provisionSession(sessionId: string): Promise<any> {
    const workspace = this.deps.workspace;
    const projectConfig = this.deps.projectConfig;

    // Ensure main clone is up to date and sync proxy if it advanced.
    if (workspace.ensureMainClone()) {
      this.deps.syncProxy();
    }

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

    return this.deps.db.createSession({
      id: sessionId,
      title: `MCP Session ${sessionId.slice(0, 8)}`,
      worktreePath,
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
    const safePath = relPath.replace(/'/g, "'\\''");
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
