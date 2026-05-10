import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Manages the long-lived "main" clone of TARGET_REPO and per-session git worktrees.
 *
 * Layout under WORKSPACE_DIR:
 *   main/                 → bare-ish full clone, used as the worktree source
 *   sessions/<id>/        → git worktree, one per session, on branch agent/<id>
 */
export class Workspace {
  readonly root: string;
  readonly mainDir: string;
  readonly sessionsDir: string;
  readonly targetRepo: string; // owner/repo
  readonly githubToken: string | undefined;

  constructor(opts: { root: string; targetRepo: string; githubToken?: string }) {
    this.root = opts.root;
    this.mainDir = path.join(opts.root, "main");
    this.sessionsDir = path.join(opts.root, "sessions");
    this.targetRepo = opts.targetRepo;
    this.githubToken = opts.githubToken;
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  /** Idempotent. Clones TARGET_REPO into <root>/main if it doesn't exist; otherwise fetches. */
  ensureMainClone(): void {
    if (fs.existsSync(path.join(this.mainDir, ".git"))) {
      this.git(this.mainDir, ["fetch", "--all", "--prune"]);
      return;
    }
    fs.mkdirSync(path.dirname(this.mainDir), { recursive: true });
    const url = this.cloneUrl();
    const res = spawnSync("git", ["clone", url, this.mainDir], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (res.status !== 0) throw new Error(`git clone failed (status ${res.status})`);
  }

  /**
   * Creates a worktree for a new session on a fresh branch `${branchPrefix}<sessionId>`
   * tracking `baseBranch`. Returns the absolute worktree path.
   */
  createSessionWorktree(opts: {
    sessionId: string;
    baseBranch: string;
    branchPrefix: string;
  }): string {
    const wt = path.join(this.sessionsDir, opts.sessionId);
    if (fs.existsSync(wt)) return wt;
    const branch = `${opts.branchPrefix}${opts.sessionId}`;
    // Ensure base branch is up to date locally.
    this.git(this.mainDir, ["fetch", "origin", opts.baseBranch]);
    this.git(this.mainDir, [
      "worktree",
      "add",
      "-b",
      branch,
      wt,
      `origin/${opts.baseBranch}`,
    ]);
    return wt;
  }

  /** For generic mode: a worktree on a detached HEAD off the default branch. */
  createGenericWorktree(sessionId: string): string {
    const wt = path.join(this.sessionsDir, sessionId);
    if (fs.existsSync(wt)) return wt;
    this.git(this.mainDir, ["fetch", "origin"]);
    const head = this.git(this.mainDir, ["rev-parse", "HEAD"]).stdout.trim();
    this.git(this.mainDir, ["worktree", "add", "--detach", wt, head]);
    return wt;
  }

  removeSessionWorktree(sessionId: string): void {
    const wt = path.join(this.sessionsDir, sessionId);
    if (!fs.existsSync(wt)) return;
    this.git(this.mainDir, ["worktree", "remove", "--force", wt]);
  }

  /** Returns the worktree path; does not create. */
  worktreePath(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId);
  }

  private cloneUrl(): string {
    if (this.githubToken) {
      // `x-access-token` is GitHub's documented PAT-over-HTTPS user.
      return `https://x-access-token:${this.githubToken}@github.com/${this.targetRepo}.git`;
    }
    return `https://github.com/${this.targetRepo}.git`;
  }

  private git(cwd: string, args: string[]): { stdout: string; stderr: string } {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed in ${cwd} (status ${res.status}): ${res.stderr}`,
      );
    }
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }
}
