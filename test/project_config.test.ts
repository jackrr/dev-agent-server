import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectConfig, loadProjectAllowlist } from "../src/project_config.js";

// ========== helpers ==========

function mktmp(name?: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), name ? `${name}-` : "pc-"));
}

function writeConfig(tmp: string, doc: Record<string, unknown>): void {
  fs.mkdirSync(path.join(tmp, ".dev-agent"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".dev-agent", "config.yaml"), docToYaml(doc));
}

function writeAllowlist(tmp: string, content: string): void {
  fs.mkdirSync(path.join(tmp, ".dev-agent"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".dev-agent", "allowlist.txt"), content);
}

function cleanup(tmp: string): void {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/** Minimal YAML serializer sufficient for our test needs. No external deps. */
function docToYaml(doc: unknown, indent: number = 0): string {
  const pad = "  ".repeat(indent);
  if (doc === null || doc === undefined) return "null";
  if (typeof doc === "string") return '"' + doc + '"';
  if (typeof doc === "number" || typeof doc === "boolean") return String(doc);
  if (Array.isArray(doc)) {
    return doc.map((item: string | unknown) => `${pad}- ${docToYaml(item, indent + 1)}`).join("\n");
  }
  if (typeof doc === "object") {
    const entries = Object.entries(doc as Record<string, unknown>).filter(([, v]) =>
      v !== undefined
    );
    const lines = entries.map(([key, value]) => {
      const indented = docToYaml(value, indent + 1);
      // If inner is a single-line string, keep it on one line: key: value
      // If inner is multi-line (array/object), newline after colon
      const isMultiLine = indented.includes("\n");
      if (isMultiLine) {
        return `${pad}${key}:\n${indented}`;
      }
      return `${pad}${key}: ${indented}`;
    });
    return lines.join("\n");
  }
  return String(doc);
}

// ========== loadProjectConfig — happy path & snake_case mapping ==========

test("loadProjectConfig: minimal config with image preset (default snake_case to camelCase)", () => {
  const tmp = mktmp("pc-minimal");
  try {
    writeConfig(tmp, {
      name: "test-project",
      sandbox: { image: "my-image" },
    });
    const cfg = loadProjectConfig(tmp);
    assert.ok(cfg);
    assert.equal(cfg.name, "test-project");
    assert.equal((cfg.sandbox as { image: string }).image, "my-image");
    assert.equal(cfg.description, undefined);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: image preset returns {image: string}", () => {
  const tmp = mktmp("pc-image");
  try {
    writeConfig(tmp, { name: "img-test", sandbox: { image: "my-image:v1" } });
    const cfg = loadProjectConfig(tmp);
    assert.ok(cfg);
    assert.equal(typeof (cfg!.sandbox as { image: string }).image, "string");
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: build preset returns {build: string}", () => {
  const tmp = mktmp("pc-build");
  try {
    writeConfig(tmp, { name: "build-test", sandbox: { build: "./Dockerfile" } });
    const cfg = loadProjectConfig(tmp);
    assert.ok(cfg);
    const b = cfg!.sandbox as { build: string };
    assert.ok("build" in b);
    assert.equal(b.build, "./Dockerfile");
  } finally { cleanup(tmp); }
});

// ========== loadProjectConfig — description ==========

test("loadProjectConfig: accepts optional description (defaults to undefined)", () => {
  const tmp = mktmp("pc-desc");
  try {
    writeConfig(tmp, { name: "desc-test", description: "A test project", sandbox: { image: "img:1" } });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.description, "A test project");
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: omitting description field also yields undefined", () => {
  const tmp = mktmp("pc-no-desc");
  try {
    writeConfig(tmp, { name: "no-desc", sandbox: { image: "img:1" } });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.description, undefined);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: description=null is treated as undefined (optString)", () => {
  const tmp = mktmp("pc-desc-null");
  try {
    writeConfig(tmp, { name: "desc-null", description: null, sandbox: { image: "img:1" } });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.description, undefined);
  } finally { cleanup(tmp); }
});

// ========== loadProjectConfig — agent ==========

test("loadProjectConfig: agent.prompt_file maps to promptFile (camelCase)", () => {
  const tmp = mktmp("pc-pf");
  try {
    writeConfig(tmp, { name: "pf-test", sandbox: { image: "img:1" }, agent: { prompt_file: "prompt.md" } });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.agent.promptFile, "prompt.md");
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: agent.preflight maps to preflight (camelCase)", () => {
  const tmp = mktmp("pc-pref");
  try {
    writeConfig(tmp, { name: "pf-test", sandbox: { image: "img:1" }, agent: { preflight: "preflight.sh" } });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.agent.preflight, "preflight.sh");
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: agent.context_files maps and validates items", () => {
  const tmp = mktmp("pc-ctx");
  try {
    writeConfig(tmp, {
      name: "ctx-test", sandbox: { image: "img:1" },
      agent: { context_files: ["a.md", "b.md"] },
    });
    const cfg = loadProjectConfig(tmp);
    assert.deepEqual(cfg!.agent.contextFiles, ["a.md", "b.md"]);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: agent.context_files as empty array is valid", () => {
  const tmp = mktmp("pc-ctx-empty");
  try {
    writeConfig(tmp, {
      name: "ctx-empty", sandbox: { image: "img:1" },
      agent: { context_files: [] },
    });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.agent.contextFiles.length, 0);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: agent section omitted defaults to empty context_files", () => {
  const tmp = mktmp("pc-no-agent");
  try {
    writeConfig(tmp, { name: "noagent", sandbox: { image: "img:1" } });
    const cfg = loadProjectConfig(tmp);
    assert.ok(cfg);
    assert.ok(Array.isArray(cfg!.agent.contextFiles));
    assert.equal(cfg!.agent.contextFiles.length, 0);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: both promptFile and preflight set together", () => {
  const tmp = mktmp("pc-both");
  try {
    writeConfig(tmp, {
      name: "both", sandbox: { image: "img:1" },
      agent: { prompt_file: "p.md", preflight: "s.sh", context_files: ["c.md"] },
    });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.agent.promptFile, "p.md");
    assert.equal(cfg!.agent.preflight, "s.sh");
    assert.deepEqual(cfg!.agent.contextFiles, ["c.md"]);
  } finally { cleanup(tmp); }
});

// ========== loadProjectConfig — ship ==========

test("loadProjectConfig: full ship config (snake_case → camelCase)", () => {
  const tmp = mktmp("pc-ship");
  try {
    writeConfig(tmp, {
      name: "ship-test", sandbox: { image: "img:1" },
      ship: {
        branch_prefix: "feat/",
        base_branch: "develop",
        artifact_workflow: "workflow.yml",
        artifact_asset_pattern: "*.zip",
        release_tag_pattern: "v{{pr_number}}",
      },
    });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.ship.branchPrefix, "feat/");
    assert.equal(cfg!.ship.baseBranch, "develop");
    assert.equal(cfg!.ship.artifactWorkflow, "workflow.yml");
    assert.equal(cfg!.ship.artifactAssetPattern, "*.zip");
    assert.equal(cfg!.ship.releaseTagPattern, "v{{pr_number}}");
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship absent → undefined", () => {
  const tmp = mktmp("pc-no-ship");
  try {
    writeConfig(tmp, { name: "no-ship", sandbox: { image: "img:1" } });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.ship, undefined);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship null → undefined (not an error)", () => {
  const tmp = mktmp("pc-ship-null");
  try {
    writeConfig(tmp, { name: "ship-null", sandbox: { image: "img:1" }, ship: null });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.ship, undefined);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship with partial fields — only branch_prefix", () => {
  const tmp = mktmp("pc-ship-partial");
  try {
    writeConfig(tmp, {
      name: "ship-partial", sandbox: { image: "img:1" },
      ship: { branch_prefix: "agent/" },
    });
    const cfg = loadProjectConfig(tmp);
    assert.ok(cfg);
    assert.equal(cfg!.ship.branchPrefix, "agent/");
  } finally { cleanup(tmp); }
});

// ========== loadProjectConfig — validation / throwing ==========

test("loadProjectConfig: throws when name is missing", () => {
  const tmp = mktmp("pc-no-name");
  try {
    writeConfig(tmp, { sandbox: { image: "img:1" } });
    assert.throws(() => loadProjectConfig(tmp), /config: name must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: throws when name is a number", () => {
  const tmp = mktmp("pc-name-num");
  try {
    writeConfig(tmp, { name: 42, sandbox: { image: "img:1" } });
    assert.throws(() => loadProjectConfig(tmp), /config: name must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: throws when name is null", () => {
  const tmp = mktmp("pc-name-null");
  try {
    writeConfig(tmp, { name: null, sandbox: { image: "img:1" } });
    assert.throws(() => loadProjectConfig(tmp), /config: name must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: throws when agent.context_files is a string not an array", () => {
  const tmp = mktmp("pc-ctx-str");
  try {
    writeConfig(tmp, {
      name: "ctx-str", sandbox: { image: "img:1" },
      agent: { context_files: "a.md" },
    });
    assert.throws(() => loadProjectConfig(tmp), /config: agent.context_files must be an array/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: throws when context_files items are not strings", () => {
  const tmp = mktmp("pc-ctx-items");
  try {
    writeConfig(tmp, {
      name: "ctx-items", sandbox: { image: "img:1" },
      agent: { context_files: ["a.md", 12] },
    });
    assert.throws(() => loadProjectConfig(tmp), /config: agent.context_files must contain only strings/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: throws when sandbox section is missing", () => {
  const tmp = mktmp("pc-no-sandbox");
  try {
    writeConfig(tmp, { name: "no-sandbox" });
    assert.throws(() => loadProjectConfig(tmp), /config: sandbox missing/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: throws when sandbox.image is not a string", () => {
  const tmp = mktmp("pc-sandbox-img");
  try {
    writeConfig(tmp, { name: "noimg", sandbox: { image: 42 } });
    assert.throws(() => loadProjectConfig(tmp), /config: sandbox.image must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: sandbox.build is not a string — fallback to image — both absent", () => {
  const tmp = mktmp("pc-sandbox-both");
  try {
    writeConfig(tmp, { name: "no-sbox-img-build", sandbox: {} });
    assert.throws(() => loadProjectConfig(tmp), /config: sandbox must contain either (image|build)/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: throws when ship is not a mapping (array)", () => {
  const tmp = mktmp("pc-ship-arr");
  try {
    writeConfig(tmp, { name: "ship-arr", sandbox: { image: "img:1" }, ship: [] });
    assert.throws(() => loadProjectConfig(tmp), /config: ship must be a mapping/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship.branch_prefix must be a string", () => {
  const tmp = mktmp("pc-ship-bp-num");
  try {
    writeConfig(tmp, {
      name: "ship-bp", sandbox: { image: "img:1" },
      ship: {
        branch_prefix: "agent/", base_branch: "main",
        artifact_workflow: "w.yml", artifact_asset_pattern: "*.tar.gz",
        release_tag_pattern: "release-v{pr_number}",
      },
    });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.ship.branchPrefix, "agent/");
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship.base_branch must be a string", () => {
  const tmp = mktmp("pc-ship-bb");
  try {
    writeConfig(tmp, {
      name: "ship-bb", sandbox: { image: "img:1" },
      ship: {
        branch_prefix: "agent/", base_branch: "main",
        artifact_workflow: "w.yml", artifact_asset_pattern: "*.tar.gz",
        release_tag_pattern: "release-v{pr_number}",
      },
    });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.ship.baseBranch, "main");
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship.artifact_workflow must be a string", () => {
  const tmp = mktmp("pc-ship-aw");
  try {
    writeConfig(tmp, {
      name: "ship-aw", sandbox: { image: "img:1" },
      ship: {
        branch_prefix: "agent/", base_branch: "main",
        artifact_workflow: "w.yml", artifact_asset_pattern: "*.tar.gz",
        release_tag_pattern: "release-v{pr_number}",
      },
    });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.ship.artifactWorkflow, "w.yml");
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship.artifact_asset_pattern must be a string", () => {
  const tmp = mktmp("pc-ship-aa");
  try {
    writeConfig(tmp, {
      name: "ship-aa", sandbox: { image: "img:1" },
      ship: {
        branch_prefix: "agent/", base_branch: "main",
        artifact_workflow: "w.yml", artifact_asset_pattern: "*.tar.gz",
        release_tag_pattern: "release-v{pr_number}",
      },
    });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.ship.artifactAssetPattern, "*.tar.gz");
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship.release_tag_pattern must be a string", () => {
  const tmp = mktmp("pc-ship-rt");
  try {
    writeConfig(tmp, {
      name: "ship-rt", sandbox: { image: "img:1" },
      ship: {
        branch_prefix: "agent/", base_branch: "main",
        artifact_workflow: "w.yml", artifact_asset_pattern: "*.tar.gz",
        release_tag_pattern: "release-v{pr_number}",
      },
    });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.ship.releaseTagPattern, "release-v{pr_number}");
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: throws when top-level YAML is not a mapping (string)", () => {
  const tmp = mktmp("pc-top-str");
  try {
    const dir = path.join(tmp, ".dev-agent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yaml"), "just a string");
    assert.throws(() => loadProjectConfig(tmp), /config must be a mapping/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: throws when top-level YAML is an array", () => {
  const tmp = mktmp("pc-top-arr");
  try {
    const dir = path.join(tmp, ".dev-agent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yaml"), "- one\n- two");
    assert.throws(() => loadProjectConfig(tmp), /config must be a mapping/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: throws when top-level YAML is null (empty file)", () => {
  const tmp = mktmp("pc-top-null");
  try {
    const dir = path.join(tmp, ".dev-agent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yaml"), "");
    assert.throws(() => loadProjectConfig(tmp), /config must be a mapping/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: throws on invalid YAML (bad indentation)", () => {
  const tmp = mktmp("pc-invalid");
  try {
    const dir = path.join(tmp, ".dev-agent");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yaml"), "name: test\nsandbox:\n image: img:1");
    assert.throws(() => loadProjectConfig(tmp));
  } finally { cleanup(tmp); }
});

// ========== loadProjectConfig — extra fields ==========

test("loadProjectConfig: extra top-level fields are silently ignored", () => {
  const tmp = mktmp("pc-extra-top");
  try {
    writeConfig(tmp, {
      name: "extra", sandbox: { image: "img:1" }, __extra: "should_ignored", deep: { value: 42 },
    });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.name, "extra");
    assert.ok(!("__extra" in cfg!));
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: extra agent fields are ignored", () => {
  const tmp = mktmp("pc-extra-agent");
  try {
    writeConfig(tmp, {
      name: "extra-agent", sandbox: { image: "img:1" },
      agent: { prompt_file: "p.md", extra_agent_field: true },
    });
    const cfg = loadProjectConfig(tmp);
    assert.equal(cfg!.agent.promptFile, "p.md");
  } finally { cleanup(tmp); }
});

// ======================================================================
// loadProjectConfig — missing config file
// =========================================================================

test("loadProjectConfig: returns null when .dev-agent/config.yaml is missing", () => {
  const tmp = mktmp("pc-no-config");
  try {
    // No .dev-agent directory at all
    assert.equal(loadProjectConfig(tmp), null);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: returns null when .dev-agent dir exists but config.yaml is missing", () => {
  const tmp = mktmp("pc-dir-exists");
  try {
    fs.mkdirSync(path.join(tmp, ".dev-agent"), { recursive: true });
    assert.equal(loadProjectConfig(tmp), null);
  } finally { cleanup(tmp); }
});

// ======================================================================
// loadProjectConfig — edge case: agent as empty object
// ==================================================================

test("loadProjectConfig: agent: {} is valid — no context_files", () => {
  const tmp = mktmp("pc-empty-agent");
  try {
    writeConfig(tmp, {
      name: "empty-agent", sandbox: { image: "img:1" }, agent: {},
    });
    const cfg = loadProjectConfig(tmp);
    assert.deepEqual(cfg!.agent.contextFiles, []);
    assert.equal(cfg!.agent.promptFile, undefined);
    assert.equal(cfg!.agent.preflight, undefined);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: agent: { context_files: [\"a\", \"b\"], prompt_file: \"p.md\" } with preflight absent", () => {
  const tmp = mktmp("pc-partial-agent");
  try {
    writeConfig(tmp, {
      name: "partial", sandbox: { image: "img:1" },
      agent: { context_files: ["a", "b"], prompt_file: "p.md" },
    });
    const cfg = loadProjectConfig(tmp);
    assert.deepEqual(cfg!.agent.contextFiles, ["a", "b"]);
    assert.equal(cfg!.agent.promptFile, "p.md");
    assert.equal(cfg!.agent.preflight, undefined);
  } finally { cleanup(tmp); }
});

// ==================================================================
// loadProjectAllowlist — happy path
// =======================================================
// ==============================================
test("loadProjectAllowlist: returns valid entries trimmed, ignores comments and blanks", () => {
  const tmp = mktmp("al-happy");
  try {
    writeAllowlist(tmp, "example.com\n# comment\n\napi.example.com\n  trailing-space.com  \n");
    const result = loadProjectAllowlist(tmp);
    assert.deepEqual(result, ["example.com", "api.example.com", "trailing-space.com"]);
  } finally { cleanup(tmp); }
});

test("loadProjectAllowlist: single valid entry", () => {
  const tmp = mktmp("al-single");
  try {
    writeAllowlist(tmp, "one.example.com");
    assert.deepEqual(loadProjectAllowlist(tmp), ["one.example.com"]);
  } finally { cleanup(tmp); }
});

test("loadProjectAllowlist: entries only with comments", () => {
  const tmp = mktmp("al-cmts");
  try {
    writeAllowlist(tmp, "# only\n# comments\n# here");
    assert.deepEqual(loadProjectAllowlist(tmp), []);
  } finally { cleanup(tmp); }
});

test("loadProjectAllowlist: empty content", () => {
  const tmp = mktmp("al-empty");
  try {
    writeAllowlist(tmp, "");
    assert.deepEqual(loadProjectAllowlist(tmp), []);
  } finally { cleanup(tmp); }
});

test("loadProjectAllowlist: many lines with intermixed blanks and comments", () => {
  const tmp = mktmp("al-many");
  try {
    writeAllowlist(tmp, "# start\n\napi1.com\n\napi2.com\n\n\n # indented comment\napi3.com\n");
    const result = loadProjectAllowlist(tmp);
    assert.equal(result.length, 3);
    assert.equal(result[0], "api1.com");
    assert.equal(result[1], "api2.com");
    assert.equal(result[2], "api3.com");
  } finally { cleanup(tmp); }
});

// ====================================================
// loadProjectAllowlist — edge cases
// ======================
// =============
test("loadProjectAllowlist: missing file returns []", () => {
  const tmp = mktmp("al-missing");
  try {
    assert.deepEqual(loadProjectAllowlist(tmp), []);
  } finally { cleanup(tmp); }
});

test("loadProjectAllowlist: missing .dev-agent dir returns []", () => {
  const tmp = mktmp("al-nodir");
  try {
    assert.deepEqual(loadProjectAllowlist(tmp), []);
  } finally { cleanup(tmp); }
});

test("loadProjectAllowlist: blank-only lines ignored", () => {
  const tmp = mktmp("al-blanks");
  try {
    writeAllowlist(tmp, "\n   \n\t\n  ");
    assert.deepEqual(loadProjectAllowlist(tmp), []);
  } finally { cleanup(tmp); }
});

test("loadProjectAllowlist: trailing newlines don't produce empty entries", () => {
  const tmp = mktmp("al-trailing");
  try {
    writeAllowlist(tmp, "example.com\n\n\n");
    assert.deepEqual(loadProjectAllowlist(tmp), ["example.com"]);
  } finally { cleanup(tmp); }
});

test("loadProjectAllowlist: leading newlines handled correctly", () => {
  const tmp = mktmp("al-leading");
  try {
    writeAllowlist(tmp, "\n\napi.example.com");
    assert.deepEqual(loadProjectAllowlist(tmp), ["api.example.com"]);
  } finally { cleanup(tmp); }
});

test("loadProjectAllowlist: entries with special characters preserved (after trim)", () => {
  const tmp = mktmp("al-special");
  try {
    writeAllowlist(tmp, "api.example.com\nhttps://example.com/path?q=1\n*.wildcard.com");
    const result = loadProjectAllowlist(tmp);
    assert.equal(result.length, 3);
    assert.equal(result[0], "api.example.com");
    assert.equal(result[1], "https://example.com/path?q=1");
    assert.equal(result[2], "*.wildcard.com");
  } finally { cleanup(tmp); }
});

test("loadProjectAllowlist: entries that start with # are filtered", () => {
  const tmp = mktmp("al-hash");
  try {
    writeAllowlist(tmp, "#comment\n# another comment\nvalid.com");
    assert.deepEqual(loadProjectAllowlist(tmp), ["valid.com"]);
  } finally { cleanup(tmp); }
});

// ============================================================
// loadProjectConfig — description type edge cases
// ===================================================
test("loadProjectConfig: description as boolean should throw (optString only accepts string)", () => {
  const tmp = mktmp("pc-desc-bool");
  try {
    writeConfig(tmp, { name: "bool-desc", description: true, sandbox: { image: "img:1" } });
    assert.throws(() => loadProjectConfig(tmp), /config: description must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: description as null should return undefined (optString handles null)", () => {
  const tmp = mktmp("pc-desc-null");
  try {
    writeConfig(tmp, { name: "null-desc", description: null, sandbox: { image: "img:1" } });
    assert.equal(loadProjectConfig(tmp)!.description, undefined);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: prompt_file as number should throw", () => {
  const tmp = mktmp("pc-pf-num");
  try {
    writeConfig(tmp, { name: "pf-num", sandbox: { image: "img:1" }, agent: { prompt_file: 42 } });
    assert.throws(() => loadProjectConfig(tmp), /config: agent.prompt_file must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: preflight as number should throw", () => {
  const tmp = mktmp("pc-pf-num");
  try {
    writeConfig(tmp, { name: "pf-num", sandbox: { image: "img:1" }, agent: { preflight: 42 } });
    assert.throws(() => loadProjectConfig(tmp), /config: agent.preflight must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship missing branch_prefix should throw", () => {
  const tmp = mktmp("pc-ship-nbp");
  try {
    writeConfig(tmp, {
      name: "nbp", sandbox: { image: "img:1" },
      ship: { base_branch: "main" },
    });
    assert.throws(() => loadProjectConfig(tmp), /config: ship.branch_prefix must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship missing base_branch should throw", () => {
  const tmp = mktmp("pc-ship-nbb");
  try {
    writeConfig(tmp, {
      name: "nbb", sandbox: { image: "img:1" },
      ship: { branch_prefix: "agent/" },
    });
    assert.throws(() => loadProjectConfig(tmp), /config: ship.base_branch must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship missing artifact_workflow should throw", () => {
  const tmp = mktmp("pc-ship-naw");
  try {
    writeConfig(tmp, {
      name: "naw", sandbox: { image: "img:1" },
      ship: { branch_prefix: "agent/", base_branch: "main" },
    });
    assert.throws(() => loadProjectConfig(tmp), /config: ship.artifact_workflow must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship missing artifact_asset_pattern should throw", () => {
  const tmp = mktmp("pc-ship-naap");
  try {
    writeConfig(tmp, {
      name: "naap", sandbox: { image: "img:1" },
      ship: { branch_prefix: "agent/", base_branch: "main", artifact_workflow: "w.yml" },
    });
    assert.throws(() => loadProjectConfig(tmp), /config: ship.artifact_asset_pattern must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: ship missing release_tag_pattern should throw", () => {
  const tmp = mktmp("pc-ship-ntp2");
  try {
    writeConfig(tmp, {
      name: "ntp2", sandbox: { image: "img:1" },
      ship: { branch_prefix: "agent/", base_branch: "main", artifact_workflow: "w.yml", artifact_asset_pattern: "*.tar.gz" },
    });
    assert.throws(() => loadProjectConfig(tmp), /config: ship.release_tag_pattern must be a string/);
  } finally { cleanup(tmp); }
});

test("loadProjectConfig: valid config with all fields returns expected type shape", () => {
  const tmp = mktmp("pc-full-valid");
  try {
    writeConfig(tmp, {
      name: "full", description: "Full test config", sandbox: { image: "myimg:latest" },
      agent: { prompt_file: "p.md", preflight: "s.sh", context_files: ["a.md"] },
      ship: { branch_prefix: "agent/", base_branch: "main", artifact_workflow: "w.yml", artifact_asset_pattern: "*.tar.gz", release_tag_pattern: "release-v{pr_number}" },
    });
    const cfg = loadProjectConfig(tmp);
    assert.ok(cfg);
    assert.equal(typeof cfg!.name, "string");
    assert.equal(typeof cfg!.description, "string");
    assert.ok(cfg!.sandbox);
    assert.ok(cfg!.ship);
  } finally { cleanup(tmp); }
});
