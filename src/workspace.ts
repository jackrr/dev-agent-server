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

  /**
   * Idempotent. Clones TARGET_REPO into <root>/main if it doesn't exist;
   * otherwise fetches AND hard-resets the working tree to the upstream default
   * branch. The hard reset matters: the main clone's working tree is what the
   * server reads .dev-agent/config.yaml, Dockerfile.sandbox, agent prompts,
   * context files, and the allowlist from. Without advancing it, every one of
   * those files is frozen at whatever commit was checked out on the initial
   * clone, regardless of how many commits have landed upstream.
   *
   * Safe because the main clone is treated as a read-only reference copy:
   * sessions branch off `origin/<base>` into their own worktrees and never
   * commit back to main.
   *
   * Returns true if the local HEAD actually moved (i.e. new commits were
   * fetched and applied), false if it was already up to date or this was a
   * fresh clone. Callers that need to react to upstream changes (e.g. proxy
   * allowlist sync) can gate on this return value.
   */
  ensureMainClone(): boolean {
    if (fs.existsSync(path.join(this.mainDir, ".git"))) {
      const before = this.git(this.mainDir, ["rev-parse", "HEAD"]).stdout.trim();
      this.git(this.mainDir, ["fetch", "--all", "--prune"]);
      // Refresh origin/HEAD in case the upstream default branch changed.
      this.git(this.mainDir, ["remote", "set-head", "origin", "--auto"]);
      const remoteHead = this.git(this.mainDir, [
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]).stdout.trim(); // e.g. "origin/main"
      const branch = remoteHead.replace(/^origin\//, "");
      // -B creates or resets the local branch to point at remoteHead, then
      // checks it out. Equivalent to `checkout -f <branch> && reset --hard
      // <remoteHead>` but a single command and tolerant of the branch not
      // existing locally yet.
      this.git(this.mainDir, ["checkout", "-B", branch, remoteHead]);
      const after = this.git(this.mainDir, ["rev-parse", "HEAD"]).stdout.trim();
      return before !== after;
    }
    fs.mkdirSync(path.dirname(this.mainDir), { recursive: true });
    const url = this.cloneUrl();
    const res = spawnSync("git", ["clone", url, this.mainDir], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (res.status !== 0) throw new Error(`git clone failed (status ${res.status})`);
    return true; // fresh clone always counts as "advanced"
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

  /** For generic mode: a worktree on a detached HEAD off the upstream default branch. */
  createGenericWorktree(sessionId: string): string {
    const wt = path.join(this.sessionsDir, sessionId);
    if (fs.existsSync(wt)) return wt;
    this.git(this.mainDir, ["fetch", "origin"]);
    // Base off origin/HEAD, not the main clone's local HEAD. The local HEAD is
    // only advanced by ensureMainClone(); using it here would risk a stale
    // snapshot if anyone calls this path without going through ensureMainClone
    // first. origin/HEAD is always the freshly fetched remote ref.
    this.git(this.mainDir, ["worktree", "add", "--detach", wt, "origin/HEAD"]);
    return wt;
  }

  removeSessionWorktree(sessionId: string): void {
    const wt = path.join(this.sessionsDir, sessionId);
    if (!fs.existsSync(wt)) return;
    try {
      this.git(this.mainDir, ["worktree", "remove", "--force", wt]);
    } catch (e) {
      // The directory exists but git doesn't recognise it as a worktree
      // (e.g. the worktree metadata was already pruned, or it was created
      // outside git). Fall back to removing the directory directly.
      console.error(`[workspace] git worktree remove failed, removing directory manually: ${(e as Error).message}`);
      fs.rmSync(wt, { recursive: true, force: true });
      // Also prune stale worktree bookkeeping so git doesn't complain later.
      try { this.git(this.mainDir, ["worktree", "prune"]); } catch {}
    }
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
