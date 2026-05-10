import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
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
  seccompProfile?: string; // path on host
  fallbackImage: string; // used when no project config present
  /** e.g. "keep-id" for rootless podman; passed as --userns=<value> if set. */
  userns?: string;
  /** Override --user; defaults to "1000:1000". Set empty string to omit. */
  userSpec?: string;
}

export class SandboxManager {
  private containers = new Map<string, string>(); // sessionId -> container id
  private preflightDone = new Set<string>();

  constructor(private opts: SandboxOpts) {}

  /** Resolves the docker image to use for a given project config (may build it). */
  resolveImage(projectCfg: ProjectConfig | null, mainWorktree: string): string {
    if (!projectCfg) return this.opts.fallbackImage;
    if ("image" in projectCfg.sandbox) return projectCfg.sandbox.image;
    // build path is relative to the main worktree
    const dockerfile = path.join(mainWorktree, projectCfg.sandbox.build);
    if (!fs.existsSync(dockerfile)) {
      throw new Error(`sandbox.build references missing file: ${dockerfile}`);
    }
    const tag = `dev-agent-sandbox:${hashFile(dockerfile)}`;
    if (!imageExists(tag)) {
      const res = spawnSync(
        "docker",
        ["build", "-t", tag, "-f", dockerfile, path.dirname(dockerfile)],
        { stdio: "inherit" },
      );
      if (res.status !== 0) throw new Error(`docker build failed (status ${res.status})`);
    }
    return tag;
  }

  /** Idempotently starts the session's container. Returns container id. */
  async ensureContainer(args: {
    sessionId: string;
    image: string;
    worktreePath: string;
    preflight?: string;
  }): Promise<string> {
    const existing = this.containers.get(args.sessionId);
    if (existing) return existing;

    const name = `dev-agent-${args.sessionId}`;
    // Try to attach to a previously-started container if it survived a server restart.
    const inspect = spawnSync("docker", ["inspect", "-f", "{{.Id}}", name], { encoding: "utf8" });
    if (inspect.status === 0) {
      const id = inspect.stdout.trim();
      // Make sure it's running.
      spawnSync("docker", ["start", id], { encoding: "utf8" });
      this.containers.set(args.sessionId, id);
      return id;
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
      "/home/agent:rw,size=256m",
      "-v",
      `${args.worktreePath}:/workspace:rw`,
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
      dockerArgs.push("--security-opt", `seccomp=${this.opts.seccompProfile}`);
    }
    // gVisor if available; fall back to runc silently.
    if (runtimeAvailable("runsc")) {
      dockerArgs.push("--runtime=runsc");
    }
    if (this.opts.githubToken) {
      dockerArgs.push("-e", `GH_TOKEN=${this.opts.githubToken}`);
      dockerArgs.push("-e", `GITHUB_TOKEN=${this.opts.githubToken}`);
    }
    dockerArgs.push(args.image, "sleep", "infinity");

    const res = spawnSync("docker", dockerArgs, { encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`docker run failed: ${res.stderr}`);
    }
    const id = res.stdout.trim();
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
      const child = spawn("docker", ["exec", id, "bash", "-lc", cmd]);
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
    spawnSync("docker", ["rm", "-f", id]);
    this.containers.delete(sessionId);
    this.preflightDone.delete(sessionId);
  }

  destroyAll(): void {
    for (const id of this.containers.keys()) this.destroy(id);
  }
}

function imageExists(tag: string): boolean {
  const r = spawnSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
  return r.status === 0;
}

function runtimeAvailable(name: string): boolean {
  const r = spawnSync("docker", ["info", "--format", "{{json .Runtimes}}"], { encoding: "utf8" });
  if (r.status !== 0) return false;
  try {
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    return name in obj;
  } catch {
    return false;
  }
}

function hashFile(p: string): string {
  // Cheap content fingerprint — avoids importing crypto for one call.
  const data = fs.readFileSync(p);
  let h = 0;
  for (let i = 0; i < data.length; i++) h = ((h << 5) - h + data[i]!) | 0;
  return (h >>> 0).toString(16);
}
