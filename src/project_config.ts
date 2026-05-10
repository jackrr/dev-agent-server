import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export interface ShipConfig {
  branchPrefix: string;
  baseBranch: string;
  artifactWorkflow: string;
  artifactAssetPattern: string;
  releaseTagPattern: string;
}

export type SandboxSpec = { image: string } | { build: string };

export interface ProjectConfig {
  name: string;
  description?: string;
  agent: {
    promptFile?: string;
    preflight?: string;
    contextFiles: string[];
  };
  sandbox: SandboxSpec;
  ship?: ShipConfig;
}

const CONFIG_REL_PATH = ".dev-agent/config.yaml";

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asString(x: unknown, field: string): string {
  if (typeof x !== "string") throw new Error(`config: ${field} must be a string`);
  return x;
}

function optString(x: unknown, field: string): string | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x !== "string") throw new Error(`config: ${field} must be a string`);
  return x;
}

/**
 * Loads `<mainWorktree>/.dev-agent/config.yaml`.
 * Returns null (with a warning) if the file is missing — the server then runs in
 * generic mode (bash tool only, no PR helpers).
 * Throws on a present-but-malformed file: a broken config should fail loudly.
 */
export function loadProjectConfig(mainWorktree: string): ProjectConfig | null {
  const fullPath = path.join(mainWorktree, CONFIG_REL_PATH);
  if (!fs.existsSync(fullPath)) {
    console.warn(
      `[project_config] ${CONFIG_REL_PATH} not found in ${mainWorktree}; running in generic mode`,
    );
    return null;
  }
  const raw = fs.readFileSync(fullPath, "utf8");
  const parsed = yaml.load(raw);
  if (!isObject(parsed)) {
    throw new Error(`config: top-level must be a mapping (${CONFIG_REL_PATH})`);
  }

  const name = asString(parsed.name, "name");
  const description = optString(parsed.description, "description");

  const agentRaw = isObject(parsed.agent) ? parsed.agent : {};
  const contextFilesRaw = agentRaw.context_files ?? [];
  if (!Array.isArray(contextFilesRaw)) {
    throw new Error("config: agent.context_files must be a list");
  }
  const agent: ProjectConfig["agent"] = {
    promptFile: optString(agentRaw.prompt_file, "agent.prompt_file"),
    preflight: optString(agentRaw.preflight, "agent.preflight"),
    contextFiles: contextFilesRaw.map((c, i) => asString(c, `agent.context_files[${i}]`)),
  };

  const sandboxRaw = parsed.sandbox;
  if (!isObject(sandboxRaw)) {
    throw new Error("config: sandbox section is required");
  }
  let sandbox: SandboxSpec;
  if (typeof sandboxRaw.image === "string") {
    sandbox = { image: sandboxRaw.image };
  } else if (typeof sandboxRaw.build === "string") {
    sandbox = { build: sandboxRaw.build };
  } else {
    throw new Error("config: sandbox.image or sandbox.build is required");
  }

  let ship: ShipConfig | undefined;
  if (parsed.ship !== undefined) {
    if (!isObject(parsed.ship)) throw new Error("config: ship must be a mapping");
    const s = parsed.ship;
    ship = {
      branchPrefix: asString(s.branch_prefix, "ship.branch_prefix"),
      baseBranch: asString(s.base_branch, "ship.base_branch"),
      artifactWorkflow: asString(s.artifact_workflow, "ship.artifact_workflow"),
      artifactAssetPattern: asString(s.artifact_asset_pattern, "ship.artifact_asset_pattern"),
      releaseTagPattern: asString(s.release_tag_pattern, "ship.release_tag_pattern"),
    };
  }

  return { name, description, agent, sandbox, ship };
}

/** Reads optional `.dev-agent/allowlist.txt` — one host per line, blank/`#` lines ignored. */
export function loadProjectAllowlist(mainWorktree: string): string[] {
  const fullPath = path.join(mainWorktree, ".dev-agent/allowlist.txt");
  if (!fs.existsSync(fullPath)) return [];
  return fs
    .readFileSync(fullPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}
