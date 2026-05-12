import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type { ProjectConfig } from "./project_config.js";

/**
 * Per-session container manager.
 *
 * One container per session, lazily created on first use. Bind-mounts the session's
 * git worktree at /workspace, attached to the egress-restricted network, run as
 * uid 1000:1000 with read-only root + tmpfs.
 *
 * Built on the `docker` CLI rather than the API to keep the surface area tiny.
 */
export interface SandboxOpts {
  network: string;
  proxyUrl: string;
  githubToken?: string;
  /**
   * Path on the server's filesystem to the seccomp profile. Used only to decide
   * whether to apply seccomp at all (file exists → apply). When the server runs
   * in a container, this is the in-container path.
   */
  seccompProfile?: string;
  /**
   * Path on the *daemon's* filesystem to the seccomp profile. This is what gets
   * passed to --security-opt seccomp=... and resolved by docker/podman on the
   * host. Defaults to seccompProfile (correct for the case where the server
   * runs directly on the host).
   */
  seccompProfileHost?: string;
  /**
   * In-server path to the workspace root. Used together with workspaceDirHost
   * to translate per-session worktree paths from the server's filesystem to
   * the daemon's filesystem when constructing -v bind mounts. Leave unset if
   * the server runs directly on the host.
   */
  workspaceDir?: string;
  /** Corresponding path as the engine daemon sees it on the host. */
  workspaceDirHost?: string;
  fallbackImage: string; // used when no project config present
  /** e.g. "keep-id" for rootless podman; passed as --userns=<value> if set. */
  userns?: string;
  /** Override --user; defaults to "1000:1000". Set empty string to omit. */
  userSpec?: string;
  /**
   * Container engine CLI to invoke. "docker" (default) talks to anything
   * exposing the Docker API. Use "podman" when you need podman-specific flags
   * like --userns=keep-id; podman accepts a docker-compatible socket via the
   * CONTAINER_HOST env var.
   */
  engineCli?: string;
  /** Max age (days) for built sandbox images before pruneOldImages() removes them. */
  imageMaxAgeDays?: number;
}

export class SandboxManager {
  private containers = new Map<string, string>(); // sessionId -> container id
  private preflightDone = new Set<string>();
  private get cli(): string { return this.opts.engineCli || "docker"; }

  constructor(private opts: SandboxOpts) {}

  /** Resolves the container image to use for a given project config (may build it). */
  resolveImage(projectCfg: ProjectConfig | null, mainWorktree: string): string {
    if (!projectCfg) return this.opts.fallbackImage;
    if ("image" in projectCfg.sandbox) return projectCfg.sandbox.image;
    // build path is relative to the main worktree
    const dockerfile = path.join(mainWorktree, projectCfg.sandbox.build);
    if (!fs.existsSync(dockerfile)) {
      throw new Error(`sandbox.build references missing file: ${dockerfile}`);
    }
    // Hash the Dockerfile AND any files it pulls in via COPY/ADD so edits to
    // those files invalidate the cached image.
    const tag = `dev-agent-sandbox:${hashBuildContext(dockerfile)}`;
    if (!this.imageExists(tag)) {
      const res = spawnSync(
        this.cli,
        ["build", "-t", tag, "-f", dockerfile, path.dirname(dockerfile)],
        { stdio: "inherit" },
      );
      if (res.status !== 0) throw new Error(`${this.cli} build failed (status ${res.status})`);
    }
    return tag;
  }

  /**
   * Remove dev-agent-sandbox:* images older than imageMaxAgeDays (default 14).
   * Skips any image currently in use by a running container. Best-effort: logs
   * and swallows individual removal failures.
   */
  pruneOldImages(): void {
    const maxAgeDays = this.opts.imageMaxAgeDays ?? 14;
    const cutoffMs = Date.now() - maxAgeDays * 86400_000;
    // {{.ID}} is stable; {{.CreatedAt}} format varies between docker/podman, so use
    // {{.CreatedSince}} as a fallback only — better to inspect each image for Created.
    const list = spawnSync(
      this.cli,
      ["image", "ls", "--filter", "reference=dev-agent-sandbox:*", "--format", "{{.ID}}"],
      { encoding: "utf8" },
    );
    if (list.status !== 0) return;
    const ids = Array.from(new Set(list.stdout.split("\n").map((s) => s.trim()).filter(Boolean)));
    if (ids.length === 0) return;
    let removed = 0;
    for (const id of ids) {
      const inspect = spawnSync(
        this.cli,
        ["image", "inspect", "-f", "{{.Created}}", id],
        { encoding: "utf8" },
      );
      if (inspect.status !== 0) continue;
      const createdMs = Date.parse(inspect.stdout.trim());
      if (!Number.isFinite(createdMs)) continue;
      if (createdMs > cutoffMs) continue;
      const rm = spawnSync(this.cli, ["image", "rm", id], { encoding: "utf8" });
      if (rm.status === 0) removed++;
      // Non-zero typically means the image is still in use; that's fine, skip it.
    }
    if (removed > 0) console.log(`[sandbox] pruned ${removed} old sandbox image(s)`);
  }

  private imageExists(tag: string): boolean {
    const r = spawnSync(this.cli, ["image", "inspect", tag], { stdio: "ignore" });
    return r.status === 0;
  }

  /** Idempotently starts the session's container. Returns container id. */
  async ensureContainer(args: {
    sessionId: string;
    image: string;
    worktreePath: string;
    preflight?: string;
  }): Promise<string> {
    const existing = this.containers.get(args.sessionId);
    if (existing) {
      // Verify the container is still running — it may have exited (e.g.
      // entrypoint failure, OOM, tmpfs ENOSPC) since we cached the id.
      const check = spawnSync(
        this.cli,
        ["inspect", "-f", "{{.State.Status}}", existing],
        { encoding: "utf8" },
      );
      const status = check.status === 0 ? check.stdout.trim() : "unknown";
      if (status === "running") {
        return existing;
      }
      // Container died; capture logs before removing so we can diagnose.
      const logs = spawnSync(
        this.cli,
        ["logs", "--tail", "50", existing],
        { encoding: "utf8" },
      );
      console.error(
        `[sandbox] cached container ${existing.slice(0, 12)} for session ` +
        `${args.sessionId} is ${status}; recreating.\n` +
        `  stdout: ${(logs.stdout || "").trim()}\n` +
        `  stderr: ${(logs.stderr || "").trim()}`,
      );
      spawnSync(this.cli, ["rm", "-f", existing], { encoding: "utf8" });
      this.containers.delete(args.sessionId);
      this.preflightDone.delete(args.sessionId);
    }

    const name = `dev-agent-${args.sessionId}`;
    // Try to attach to a previously-started container if it survived a server
    // restart. Only reuse it if it's actually still running — attempting to
    // `podman start` an exited container whose runtime state (under
    // /run/user/$UID) has been wiped (e.g. host reboot, server container
    // restart) reliably fails with confusing errors like
    // `crun: write: No space left on device`. The session's worktree is
    // persistent on disk, so recreating the container is cheap and correct.
    const inspect = spawnSync(
      this.cli,
      ["inspect", "-f", "{{.Id}} {{.State.Status}}", name],
      { encoding: "utf8" },
    );
    if (inspect.status === 0) {
      const [id, status] = inspect.stdout.trim().split(/\s+/, 2);
      if (id && status === "running") {
        this.containers.set(args.sessionId, id);
        return id;
      }
      // Any other state (created/exited/configured/…): discard rather than
      // try to revive — and fall through to a fresh `run`.
      spawnSync(this.cli, ["rm", "-f", name], { encoding: "utf8" });
    }

    const dockerArgs: string[] = [
      "run",
      "-d",
      "--name",
      name,
      "--rm=false",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=512m",
      "--tmpfs",
      // Writable $HOME for caches, dotfiles, lockfiles. MUST be larger than
      // whatever the sandbox image bakes into /home/agent, because the default
      // tmpcopyup mount option copies the underlying directory's contents into
      // the tmpfs at mount time; if the existing content exceeds `size=`, the
      // copy fails with ENOSPC and crun reports `write: No space left on
      // device`. Toolchains belong under /opt/* in the sandbox image, not
      // under /home/agent, so this cap can stay small.
      "/home/agent:rw,size=256m",
      "-v",
      // :Z asks podman/SELinux to relabel the bind mount with a private MCS
      // label matching this container's process label. Without it, on Fedora
      // (SELinux enforcing) the container_t domain is denied access to the
      // host directory and even reads fail with EACCES.
      `${this.toHostPath(args.worktreePath)}:/workspace:rw,Z`,
      "-w",
      "/workspace",
      "--network",
      this.opts.network,
      "-e",
      `HTTP_PROXY=${this.opts.proxyUrl}`,
      "-e",
      `HTTPS_PROXY=${this.opts.proxyUrl}`,
      "-e",
      `http_proxy=${this.opts.proxyUrl}`,
      "-e",
      `https_proxy=${this.opts.proxyUrl}`,
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--cpus",
      "2",
      "--memory",
      "4g",
      "--pids-limit",
      "512",
    ];
    const userSpec = this.opts.userSpec ?? "1000:1000";
    if (userSpec) dockerArgs.push("--user", userSpec);
    if (this.opts.userns) dockerArgs.push(`--userns=${this.opts.userns}`);
    if (this.opts.seccompProfile && fs.existsSync(this.opts.seccompProfile)) {
      const sentToEngine = this.opts.seccompProfileHost ?? this.opts.seccompProfile;
      dockerArgs.push("--security-opt", `seccomp=${sentToEngine}`);
    }
    // gVisor if available; fall back to runc silently.
    if (this.runtimeAvailable("runsc")) {
      dockerArgs.push("--runtime=runsc");
    }
    if (this.opts.githubToken) {
      dockerArgs.push("-e", `GH_TOKEN=${this.opts.githubToken}`);
      dockerArgs.push("-e", `GITHUB_TOKEN=${this.opts.githubToken}`);
    }
    dockerArgs.push(args.image, "sleep", "infinity");

    console.log(`[sandbox] creating container ${name} with image ${args.image}`);
    const res = spawnSync(this.cli, dockerArgs, { encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`${this.cli} run failed: ${res.stderr}`);
    }
    const id = res.stdout.trim();

    // Give the entrypoint a moment to run, then verify the container is
    // actually alive. If it exited already, grab its logs before throwing
    // so the root cause is visible in the server log.
    spawnSync("sleep", ["1"]);
    const postCheck = spawnSync(
      this.cli,
      ["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", id],
      { encoding: "utf8" },
    );
    const postStatus = postCheck.status === 0 ? postCheck.stdout.trim() : "inspect-failed";
    if (!postStatus.startsWith("running")) {
      const logs = spawnSync(this.cli, ["logs", "--tail", "80", id], { encoding: "utf8" });
      const detail =
        `[sandbox] container ${id.slice(0, 12)} exited immediately (${postStatus})\n` +
        `  stdout: ${(logs.stdout || "").trim()}\n` +
        `  stderr: ${(logs.stderr || "").trim()}`;
      console.error(detail);
      spawnSync(this.cli, ["rm", "-f", id], { encoding: "utf8" });
      throw new Error(detail);
    }
    console.log(`[sandbox] container ${id.slice(0, 12)} is running`);
    this.containers.set(args.sessionId, id);

    if (args.preflight && !this.preflightDone.has(args.sessionId)) {
      const out = await this.exec(args.sessionId, args.preflight);
      console.log(`[sandbox] preflight for ${args.sessionId}: exit=${out.exitCode}`);
      this.preflightDone.add(args.sessionId);
    }
    return id;
  }

  /** Runs a bash command inside the session container. Output truncated to 32 KB. */
  async exec(
    sessionId: string,
    cmd: string,
    opts: { maxBytes?: number; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
    const id = this.containers.get(sessionId);
    if (!id) throw new Error(`no container for session ${sessionId}`);
    const maxBytes = opts.maxBytes ?? 32 * 1024;
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

    return await new Promise((resolve) => {
      const child = spawn(this.cli, ["exec", id, "bash", "-lc", cmd]);
      let stdout = "";
      let stderr = "";
      let truncated = false;
      const append = (chunk: Buffer, which: "stdout" | "stderr") => {
        const s = chunk.toString("utf8");
        if (which === "stdout") {
          if (stdout.length + s.length > maxBytes) {
            stdout += s.slice(0, Math.max(0, maxBytes - stdout.length));
            truncated = true;
          } else stdout += s;
        } else {
          if (stderr.length + s.length > maxBytes) {
            stderr += s.slice(0, Math.max(0, maxBytes - stderr.length));
            truncated = true;
          } else stderr += s;
        }
      };
      child.stdout.on("data", (c) => append(c, "stdout"));
      child.stderr.on("data", (c) => append(c, "stderr"));
      const t = setTimeout(() => {
        truncated = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("close", (code) => {
        clearTimeout(t);
        resolve({ stdout, stderr, exitCode: code ?? -1, truncated });
      });
    });
  }

  /** Stop + remove the container. Idempotent. */
  destroy(sessionId: string): void {
    const id = this.containers.get(sessionId);
    if (!id) return;
    spawnSync(this.cli, ["rm", "-f", id]);
    this.containers.delete(sessionId);
    this.preflightDone.delete(sessionId);
  }

  destroyAll(): void {
    for (const id of this.containers.keys()) this.destroy(id);
  }

  /** See {@link translateWorkspacePath}. */
  private toHostPath(p: string): string {
    return translateWorkspacePath(p, this.opts.workspaceDir, this.opts.workspaceDirHost);
  }

  private runtimeAvailable(name: string): boolean {
    const r = spawnSync(this.cli, ["info", "--format", "{{json .Runtimes}}"], { encoding: "utf8" });
    if (r.status !== 0) return false;
    try {
      const obj = JSON.parse(r.stdout) as Record<string, unknown>;
      return name in obj;
    } catch {
      return false;
    }
  }
}

/**
 * Hashes a Dockerfile plus the contents of every file referenced via COPY/ADD
 * within its build context. Glob patterns are expanded as a recursive directory
 * walk; missing paths are still folded in (as a fixed marker) so deletions also
 * invalidate. Best-effort — conservatively over-hashes rather than under-hashes.
 */
export function hashBuildContext(dockerfilePath: string): string {
  const h = crypto.createHash("sha256");
  const dockerfile = fs.readFileSync(dockerfilePath);
  h.update("DOCKERFILE\0");
  h.update(dockerfile);

  const ctxDir = path.dirname(dockerfilePath);
  const sources = parseCopySources(dockerfile.toString("utf8"));
  // Stable order so the hash is reproducible.
  sources.sort();
  for (const src of sources) {
    const abs = path.resolve(ctxDir, src);
    // Guard: stay inside the build context (docker would reject anything outside
    // anyway, but we don't want a `../etc/passwd` walk).
    if (!abs.startsWith(path.resolve(ctxDir) + path.sep) && abs !== path.resolve(ctxDir)) {
      h.update(`SRC ${src} OUT_OF_CONTEXT\0`);
      continue;
    }
    h.update(`SRC ${src}\0`);
    hashPath(abs, h);
  }
  // 12 hex chars is plenty of collision resistance for image tag dedup.
  return h.digest("hex").slice(0, 12);
}

/**
 * Extracts COPY/ADD source paths from Dockerfile text. Skips --from=stage
 * (those reference other build stages, not files on disk). Skips http(s)://
 * URLs in ADD. Handles line continuations.
 */
export function parseCopySources(text: string): string[] {
  // Join line continuations.
  const joined = text.replace(/\\\r?\n/g, " ");
  const out: string[] = [];
  for (const rawLine of joined.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^(COPY|ADD)\s+(.+)$/i.exec(line);
    if (!m) continue;
    // Tokenize, respecting simple quoting.
    const tokens = tokenize(m[2]!);
    // Drop flags (--from=..., --chown=..., --chmod=...). If --from= is present,
    // the sources reference a build stage, not the on-disk context — skip.
    let fromStage = false;
    const positional: string[] = [];
    for (const t of tokens) {
      if (t.startsWith("--")) {
        if (t.startsWith("--from=")) fromStage = true;
        continue;
      }
      positional.push(t);
    }
    if (fromStage || positional.length < 2) continue;
    // Last positional arg is the destination; everything before is a source.
    const srcs = positional.slice(0, -1);
    for (const s of srcs) {
      if (/^https?:\/\//i.test(s)) continue;
      out.push(s);
    }
  }
  return out;
}

/**
 * Translates an in-server filesystem path to the corresponding host path the
 * engine daemon will resolve. If inDir/hostDir aren't both configured, or the
 * path doesn't live under inDir, returns it unchanged.
 */
export function translateWorkspacePath(
  p: string,
  inDir: string | undefined,
  hostDir: string | undefined,
): string {
  if (!inDir || !hostDir || inDir === hostDir) return p;
  const normIn = inDir.endsWith("/") ? inDir : inDir + "/";
  const normHost = hostDir.replace(/\/$/, "");
  if (p === inDir) return normHost;
  if (p.startsWith(normIn)) return normHost + "/" + p.slice(normIn.length);
  return p;
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function hashPath(abs: string, h: crypto.Hash): void {
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { h.update("MISSING\0"); return; }
  if (st.isFile()) {
    h.update(`FILE ${st.size}\0`);
    h.update(fs.readFileSync(abs));
    return;
  }
  if (st.isDirectory()) {
    h.update("DIR\0");
    let entries: string[];
    try { entries = fs.readdirSync(abs).sort(); } catch { return; }
    for (const name of entries) {
      h.update(`ENTRY ${name}\0`);
      hashPath(path.join(abs, name), h);
    }
    return;
  }
  // Symlinks/devices/etc: just hash the link target name.
  h.update(`OTHER\0`);
}
