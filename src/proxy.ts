import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface ProxySyncConfig {
  proxyProjectFile: string;
  proxyContainer: string;
  engineCli: string;
}

export function syncProxyAllowlist(
  config: ProxySyncConfig,
  workspaceMainDir: string,
) {
  const projectAllowlist = path.join(workspaceMainDir, ".dev-agent", "allowlist.txt");
  let extra = "";
  if (fs.existsSync(projectAllowlist)) {
    extra = fs.readFileSync(projectAllowlist, "utf8");
    console.log(`[proxy] loaded project allowlist from ${projectAllowlist}`);
  } else {
    console.log("[proxy] no .dev-agent/allowlist.txt — using server defaults only");
  }

  // Check if the file actually changed; skip the disruptive proxy reload if not.
  let current = "";
  try { current = fs.readFileSync(config.proxyProjectFile, "utf8"); } catch {}
  if (current === extra) {
    console.log("[proxy] allowlist unchanged — skipping proxy reload");
    return false;
  }

  try {
    fs.mkdirSync(path.dirname(config.proxyProjectFile), { recursive: true });
    fs.writeFileSync(config.proxyProjectFile, extra);
    console.log(`[proxy] wrote updated allowlist to ${config.proxyProjectFile}`);
  } catch (e) {
    console.error(`[proxy] failed to write ${config.proxyProjectFile}:`, e);
    return false;
  }

  // Signal tinyproxy (PID 1) to exit. systemd Restart=on-failure will bring
  // the container back, re-running the entrypoint with the new filter.
  const kill = spawnSync(config.engineCli, ["kill", "--signal", "TERM", config.proxyContainer], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (kill.status === 0) {
    console.log(`[proxy] sent SIGTERM to ${config.proxyContainer}; systemd will restart it`);
    return true;
  } else {
    console.error(`[proxy] failed to signal ${config.proxyContainer}: ${kill.stderr}`);
    return false;
  }
}
