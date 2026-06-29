/**
 * Tests for ToolEngine: tool routing, asString validation,
 * tool-specific happy/error paths, open_pr, ensureContainer,
 * list_recent_sessions
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ToolEngine } from "../src/tool_engine.js";
import type { ToolEngineDeps } from "../src/tool_engine.js";

const DEFAULT_ENGINE_DEPS: ToolEngineDeps = {
  db: {
    touchSession: () => {},
    getSession: () => null,
    recentSessions: () => [],
    createSession: () => ({
      id: "id1", title: "title", description: "description",
      worktreePath: "/data/workspaces/sessions/s1/worktree",
      worktree_path: ".worktree",
      created_at: "now", last_message_at: "now",
    }),
    upsertPrLink: () => {},
  },
  workspace: {
    ensureMainClone: () => false,
    syncProxy: () => {},
    createSessionWorktree: () => "/data/workspaces/sessions/s1/worktree",
    createGenericWorktree: () => "/data/workspaces/sessions/s1/worktree",
    removeSessionWorktree: () => undefined,
    worktreePath: () => "/data/workspaces/sessions/s1/worktree",
    root: "/data/workspaces",
    mainDir: "/data/workspaces/main",
    sessionsDir: "/data/workspaces/sessions",
    targetRepo: "test/repo@main",
    githubToken: "tok",
  },
  sandbox: {
    ensureContainer: async () => {},
    resolveImage: () => "default-latest",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  },
  github: null as any,
  projectConfig: {
    agent: { preflight: false },
    ship: { baseBranch: "main", branchPrefix: "agent/" },
  } as any,
  mainWorktree: "/data/workspaces/main",
  syncProxy: () => {},
};

function makeDeps(patches: Partial<ToolEngineDeps> = {}): ToolEngineDeps {
  return {
    ...DEFAULT_ENGINE_DEPS,
    ...patches,
    sandbox: { ...DEFAULT_ENGINE_DEPS.sandbox, ...(patches.sandbox ?? {}) },
    db: { ...DEFAULT_ENGINE_DEPS.db, ...(patches.db ?? {}) },
    workspace: { ...DEFAULT_ENGINE_DEPS.workspace, ...(patches.workspace ?? {}) },
    projectConfig: { ...DEFAULT_ENGINE_DEPS.projectConfig, ...(patches.projectConfig ?? {}) },
  } as ToolEngineDeps;
}

// == bash ==

describe("ToolEngine - bash", () => {
  test("returns combined stdout + stderr + exit code", async () => {
    const deps = makeDeps({
      sandbox: {
        exec: async () => ({ exitCode: 0, stdout: "hello\n", stderr: "warning\n" }),
      },
    });
    const engine = new ToolEngine(deps);
    const result = await engine.executeTool("s1", "bash", { cmd: "echo hello" });
    assert.ok(result.includes("hello"));
    assert.ok(result.includes("[stderr]"));
    assert.ok(result.includes("warning"));
    assert.ok(result.includes("[exit 0]"));
  });

  test("stdout only — exit(0) suffix present", async () => {
    const deps = makeDeps({
      sandbox: {
        exec: async () => ({ exitCode: 0, stdout: "data\n" }),
      },
    });
    const engine = new ToolEngine(deps);
    const result = await engine.executeTool("s2", "bash", { cmd: "echo data" });
    assert.ok(result.includes("data"));
    assert.ok(result.includes("[exit 0]"));
  });

  test("non-zero exit: includes [exit N]", async () => {
    const deps = makeDeps({
      sandbox: {
        exec: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
      },
    });
    const engine = new ToolEngine(deps);
    const result = await engine.executeTool("s3", "bash", { cmd: "badcmd" });
    assert.ok(result.includes("[exit 127]"));
    assert.ok(result.includes("not found"));
  });

  test("calls touchSession before any work", async () => {
    const deps = makeDeps({
      sandbox: { exec: async () => ({ exitCode: 0, stdout: "ok" }) },
    });
    const touchIds: string[] = [];
    deps.db.touchSession = (id: string) => touchIds.push(id);
    await new ToolEngine(deps).executeTool("s4", "bash", { cmd: "x" });
    assert.equal(touchIds.length, 1);
    assert.equal(touchIds[0], "s4");
  });

  test("empty cmd string is accepted (asString passes for '')", async () => {
    const deps = makeDeps();
    const engine = new ToolEngine(deps);
    const result = await engine.executeTool("s5", "bash", { cmd: "" });
    assert.ok(result.includes("[exit 0]"));
  });
});

// == file tools ==

describe("ToolEngine - file tools", () => {
  test("read_file: returns stdout", async () => {
    const deps = makeDeps({
      sandbox: {
        exec: async () => ({ exitCode: 0, stdout: "FILE_CONTENT" }),
      },
    });
    const engine = new ToolEngine(deps);
    const result = await engine.executeTool("s6", "read_file", { path: "/ok" });
    assert.equal(result, "FILE_CONTENT");
  });

  test("write_file: returns standard byte-count string", async () => {
    const deps = makeDeps({
      sandbox: {
        exec: async () => ({ exitCode: 0 }),
      },
    });
    const engine = new ToolEngine(deps);
    const result = await engine.executeTool("s7", "write_file", {
      path: "/tmp/w", content: "data",
    });
    assert.equal(result, "wrote 4 bytes to /tmp/w");
  });

  test("apply_patch: returns stdout", async () => {
    const deps = makeDeps({
      sandbox: {
        exec: async () => ({ exitCode: 0, stdout: "PATCH_OUT" }),
      },
    });
    const engine = new ToolEngine(deps);
    const result = await engine.executeTool("s8", "apply_patch", { patch: "@@hello" });
    assert.equal(result, "PATCH_OUT");
  });

  test("touchSession called for every file tool", async () => {
    for (const tool of ["read_file", "write_file", "apply_patch"] as const) {
      const deps = makeDeps();
      const touchIds: string[] = [];
      deps.db.touchSession = (id: string) => touchIds.push(id);
      await new ToolEngine(deps).executeTool("s9", tool, {
        ...(tool === "write_file" ? { path: "/f", content: "c" }
          : tool === "apply_patch" ? { patch: "p" }
          : { path: "/f" }),
      });
      assert.equal(touchIds.length, 1);
    }
  });
});

// == file tool error paths ==

describe("ToolEngine - file tool error paths", () => {
  test("read_file failure (exitCode \!== 0) throws", async () => {
    const deps = makeDeps({
      sandbox: {
        exec: async () => ({ exitCode: 1, stdout: "err", stderr: "" }),
      },
    });
    const engine = new ToolEngine(deps);
    await assert.rejects(
      async () => engine.executeTool("s11", "read_file", { path: "/nope" }),
      /read_file failed/,
    );
  });

  test("read_file uses stderr when available", async () => {
    const deps = makeDeps({
      sandbox: {
        exec: async () => ({ exitCode: 1, stdout: "", stderr: "No such file" }),
      },
    });
    const engine = new ToolEngine(deps);
    await assert.rejects(
      async () => engine.executeTool("s12", "read_file", { path: "/nope" }),
      /No such file/,
    );
  });

  test("write_file failure throws", async () => {
    const deps = makeDeps({
      sandbox: {
        exec: async () => ({ exitCode: 1, stdout: "", stderr: "perm denied" }),
      },
    });
    const engine = new ToolEngine(deps);
    await assert.rejects(
      async () => engine.executeTool("s13", "write_file", { path: "/x", content: "y" }),
      /write_file failed/,
    );
  });

  test("apply_patch failure throws", async () => {
    const deps = makeDeps({
      sandbox: {
        exec: async () => ({ exitCode: 1, stdout: "", stderr: "rejected" }),
      },
    });
    const engine = new ToolEngine(deps);
    await assert.rejects(
      async () => engine.executeTool("s14", "apply_patch", { patch: "bad patch" }),
      /patch failed/,
    );
  });
});

// == unknown tool ==

describe("ToolEngine - unknown tool", () => {
  test("unknown tool name throws", async () => {
    const deps = makeDeps();
    const engine = new ToolEngine(deps);
    await assert.rejects(
      async () => (engine as any).executeTool("s15", "unknown_tool", {}),
      /unknown tool: unknown_tool/,
    );
  });
});

// == asString validation ==

describe("ToolEngine - asString validation", () => {
  const cases: Array<{ tool: string; props: Record<string, unknown>; field: string }> = [
    { tool: "bash",    props: { cmd: 123 },          field: "cmd" },
    { tool: "bash",    props: { cmd: null },         field: "cmd" },
    { tool: "bash",    props: { cmd: undefined },    field: "cmd" },
    { tool: "read_file", props: { path: 42 },        field: "path" },
    { tool: "write_file", props: { content: 42 },    field: "content" },
    { tool: "write_file", props: { content: "x", path: null }, field: "path" },
    { tool: "apply_patch", props: { patch: 42 },     field: "patch" },
  ];

  for (const { tool, props, field } of cases) {
    test(`${tool} ${field}: ${JSON.stringify(props[field])} throws`, async () => {
      const deps = makeDeps();
      const engine = new ToolEngine(deps);
      await assert.rejects(
        async () => (engine as any).executeTool("s16", tool, props as any),
        new RegExp(`${field} must be a string`),
      );
    });
  }
});

// == list_recent_sessions ==

describe("ToolEngine - list_recent_sessions", () => {
  test("default limit (10) when no limit", async () => {
    let cap: number | undefined;
    const deps = makeDeps({
      db: { ...DEFAULT_ENGINE_DEPS.db,
        recentSessions: (limit?: number) => { cap = limit; return []; },
      },
    });
    const engine = new ToolEngine(deps);
    const result = await engine.executeTool("rl1", "list_recent_sessions", {});
    assert.equal(cap, 10);
    assert.equal(JSON.parse(result).length, 0);
  });

  test("limit clamped min 1", async () => {
    let cap: number | undefined;
    const deps = makeDeps({
      db: { ...DEFAULT_ENGINE_DEPS.db,
        recentSessions: (limit?: number) => { cap = limit; return []; },
      },
    });
    const engine = new ToolEngine(deps);
    await engine.executeTool("rl2", "list_recent_sessions", { limit: 0 });
    assert.equal(cap, 1);
  });

  test("limit clamped max 50", async () => {
    let cap: number | undefined;
    const deps = makeDeps({
      db: { ...DEFAULT_ENGINE_DEPS.db,
        recentSessions: (limit?: number) => { cap = limit; return []; },
      },
    });
    const engine = new ToolEngine(deps);
    await engine.executeTool("rl3", "list_recent_sessions", { limit: 9999 });
    assert.equal(cap, 50);
  });

  test("returns JSON string of session objects", async () => {
    const mockSessions = [
      { id: "s1", title: "A", description: "d1", created_at: "2025-01-01", last_message_at: "2025-01-01T00:00:00Z" },
      { id: "s2", title: "B", description: "d2", created_at: "2025-01-02", last_message_at: "2025-01-02T00:00:00Z" },
    ];
    const deps = makeDeps({
      db: { ...DEFAULT_ENGINE_DEPS.db,
        recentSessions: (limit?: number) => mockSessions,
      },
    });
    const engine = new ToolEngine(deps);
    const result = await engine.executeTool("rl4", "list_recent_sessions", {});
    const parsed = JSON.parse(result);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].title, "A");
    assert.equal(parsed[1].title, "B");
  });
});

// == open_pr ==

describe("ToolEngine - open_pr", () => {
  test("throws when projectConfig.ship is null", async () => {
    const deps = makeDeps({
      projectConfig: { agent: { preflight: false }, ship: null } as any,
      github: { openPr: async () => ({ prNumber: 99, prUrl: "https://x/99" }) } as any,
    });
    const engine = new ToolEngine(deps);
    await assert.rejects(
      async () => (engine as any).executeTool("op1", "open_pr", { title: "T", body: "B" }),
      /open_pr is not enabled for this project/,
    );
  });

  test("throws when github is null (even with ship config)", async () => {
    const deps = makeDeps({
      github: null as any,
      projectConfig: { agent: { preflight: false }, ship: { baseBranch: "main" } } as any,
    });
    const engine = new ToolEngine(deps);
    await assert.rejects(
      async () => (engine as any).executeTool("op2", "open_pr", { title: "T", body: "B" }),
      /open_pr is not enabled for this project/,
    );
  });

  test("throws session has no worktree", async () => {
    const session = {
      id: "op-sess", title: "T", worktreePath: null,
      worktree_path: null, description: "", created_at: "", last_message_at: "",
    };
    const deps = makeDeps({
      db: { ...DEFAULT_ENGINE_DEPS.db,
        getSession: () => session,
      },
      github: { openPr: async () => ({ prNumber: 99, prUrl: "https://x/99" }) } as any,
    });
    const engine = new ToolEngine(deps);
    await assert.rejects(
      async () => (engine as any).executeTool("op3", "open_pr", { title: "T", body: "B" }),
      /session has no worktree/,
    );
  });

  test("happy path: opens PR when session already exists", async () => {
    let openPrArgs: { worktreePath: string; branch: string; baseBranch: string; title: string; body: string } | null = null;
    let upsertRow: { session_id: string; pr_number: number; pr_url: string } | null = null;

    const session = {
      id: "op-happy", title: "Test", worktreePath: "/ws/op-happy",
      worktree_path: "/ws/op-happy", description: "", created_at: "", last_message_at: "",
    };

    const deps = makeDeps({
      db: {
        ...DEFAULT_ENGINE_DEPS.db,
        getSession: () => session,
        upsertPrLink(row: { session_id: string; pr_number: number; pr_url: string }) {
          upsertRow = row;
        },
        createSession() {
          return session;
        },
      },
      workspace: {
        ...DEFAULT_ENGINE_DEPS.workspace,
        ensureMainClone: () => false,
      },
      github: {
        openPr: async (a: { worktreePath: string; branch: string; baseBranch: string; title: string; body: string }) => {
          openPrArgs = a;
          return { prNumber: 42, prUrl: "https://github.com/test/pr/42" };
        },
      },
    });

    const engine = new ToolEngine(deps);
    const resultStr = await engine.executeTool("op-happy", "open_pr", {
      title: "WIP: feat",
      body: "fixes #1",
    });

    if (upsertRow) {
      assert.ok(upsertRow, "upsertPrLink should have been called");
      assert.equal(upsertRow.pr_number, 42);
      assert.ok(upsertRow.pr_url.startsWith("https://"));
    } else {
      assert.fail("upsertPrLink should have been called");
    }
    if (openPrArgs) {
      assert.equal(openPrArgs.branch, "agent/op-happy");
      assert.equal(openPrArgs.baseBranch, "main");
      assert.equal(openPrArgs.title, "WIP: feat");
      assert.equal(openPrArgs.body, "fixes #1");
    } else {
      assert.fail("openPr should have been called");
    }

    const parsed = JSON.parse(resultStr);
    assert.equal(parsed.prNumber, 42);
    assert.ok(parsed.prUrl.startsWith("https://"));
  });
});

// == ensureContainer / provisionSession ==

describe("ToolEngine - ensureContainer / provisionSession", () => {
  test("getSession null → calls syncProxy after ensureMainClone", async () => {
    let ensureMainCloneCalled = false;
    let syncProxyCalled = false;

    const deps = makeDeps({
      workspace: {
        ...DEFAULT_ENGINE_DEPS.workspace,
        ensureMainClone: () => {
          ensureMainCloneCalled = true;
          return true;
        },
        syncProxy: () => { syncProxyCalled = true; },
      },
      sandbox: {
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      },
    });

    // read_file forces the provisioning path because getSession returns null (default)
    const engine = new ToolEngine(deps);
    await engine.executeTool("prov", "read_file", { path: "/f" });
    assert.ok(ensureMainCloneCalled, "ensureMainClone should have been called");
    assert.ok(syncProxyCalled, "syncProxy should have been called after ensureMainClone returned true");
  });
});
