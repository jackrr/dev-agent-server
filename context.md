# MCP Rewrite State — Scout Report

## 1. Plan Status (from `docs/mcp-rewrite.md`)

### All 7 plan items are marked [x] done:
| # | Plan Item | Actual Status |
|---|-----------|---------------|
| 1 | Core Logic Decoupling → `src/tool_engine.ts` | ✅ Done. ToolEngine class with 6 tools: bash, read_file, write_file, apply_patch, list_recent_sessions, open_pr. |
| 2 | MCP Server Integration → `src/mcp_server.ts` | ✅ Done. SSE transport on `/mcp/sse`, POST on `/mcp/messages`, `initialize` + `tools/list` + `tools/call` JSON-RPC methods. |
| 3 | Database Simplification → `src/db.ts` | ✅ Partially done. `messages` and `app_contexts` tables removed. Sessions + pr_links remain. |
| 4 | App Integration → `src/server.ts` | ✅ Done. Hono app, boot sequence, toolEngine/MCPServer construction. |
| 5 | Redundant Component Removal | ✅ Done: `src/agent.ts` deleted, `src/llm_provider.ts` deleted, `public/` deleted. |
| 6 | Auth Update → `src/api_auth.ts` | ✅ Done. API Key / Bearer Token middleware (not Cloudflare). |
| 7 | Infrastructure → Dockerfile verified | ✅ Done. Multi-stage Dockerfile, builds + static docker + podman CLI. |

## 2. Deleted Files Confirmed

Confirmed deleted (all in commit `f8d99f6`, the MCP rewrite commit):
- **`src/agent.ts`** ✅ Deleted (397 lines removed)
- **`src/llm_provider.ts`** ✅ Deleted (220 lines removed)
- **`public/app.js`** ✅ Deleted (340 lines removed)
- **`public/index.html`** ✅ Deleted (189 lines removed)
- **`public/` directory** ✅ Gone entirely
- **`src/auth.ts`** ✅ Deleted (69 lines removed)
- **`src/report_parser.ts`** ✅ Deleted (118 lines removed)

## 3. Remaining `src/` Files (14 files)

```
api_auth.ts  db.ts        mcp_server.ts  proxy.ts          server.ts
github.ts    poller.ts    project_config.ts  sandbox.ts    tool_engine.ts
workspace.ts
```

## 4. Deleted Files NOT in Plan but Also Gone

- **`src/agent.ts`** — was the old agent loop (not explicitly listed but was redundant)
- **`src/auth.ts`** — Cloudflare JWT middleware (plan called for replace, did full replace)
- **`src/report_parser.ts`** — was legacy bug-report parser (plan noted "remove bug report logic")
- **`test/report_parser.test.ts`** — was the only test (see below)

## 5. TypeScript Compilation Error

**One error found:**
```
src/db.ts(120,7): error TS1128: Declaration or statement expected.
```

Line 120 is `.map((row) => row.id);` in the `getExpiredSessions` method. The source code looks syntactically valid. This error appears to be a TypeScript type-level issue — likely related to `better-sqlite3` type definitions (`@types/better-sqlite3/index.d.ts` is present).

**Important:** The file was **not** modified in any recent commit, so this is a **pre-existing** issue not introduced by the MCP rewrite. The `better-sqlite3` types may have a type definition that conflicts with the return type inference in the chain.

## 6. Test Directory

```
test/
└── sandbox.test.ts (5152 bytes, dated May 10 — from before rewrite)
```

**Key observation:** The rewrite commit (`f8d99f6`) **deleted** `test/report_parser.test.ts` (79 lines) — the only test file that was directly related to deleted code. **The rewrite did NOT add any new tests** for the new functionality (tool_engine, mcp_server, api_auth, tool chaining). Only `sandbox.test.ts` remains.

## 7. Current Branch History (6 commits post-rewrite)

```
d3f9aba docs: remove references to legacy session management API
4bbfa00 refactor: remove legacy session management API endpoints
24005d1 fix: align session sorting and expose activity timestamp in API
3873118 feat: implement session TTL reaper for automatic resource cleanup
8c1be95 Update proxy allowlist for dev-agent sandbox
f8d99f6 feat: rewrite server as a stateful MCP tool server  ← the rewrite
```

The last 2 commits (`d3f9aba` and `4bbfa00`) clean up legacy session management API references that remained after the rewrite.

## 8. No Staged Files

`git diff --cached` returns empty. Unstaged changes: `AGENT_CONTRACTS.md`, `README.md` (both doc updates, not code).

## 9. Gaps & Risks

### Gaps:
1. **No tests for new code** — `tool_engine.ts`, `mcp_server.ts`, and `api_auth.ts` have zero test coverage. No integration test for MCP SSE flow.
2. **`MessageRole` type still exported from `src/db.ts`** — line 6: `export type MessageRole = "user" | "assistant" | "tool_result";` — this is unused dead code. The plan said to remove message-related types.
3. **`src/poller.ts` not mentioned in the plan** — it still exists as a new file. Its purpose is unclear from the plan.

### Risks:
1. **TSC error at `db.ts:120`** — pre-existing, not caused by rewrite, but should be fixed before deployment.
2. **`list_recent_sessions` tool requires `sessionId` param** — this is odd; a "list recent sessions" tool shouldn't need a session ID. The MCP tool definition says `sessionId` is required but it's never used in `tool_engine.ts`. Same for other tools' `sessionId` in `inputSchema` — the SSE handler reads it from `args.sessionId` but it's also in the MCP schema as required.
3. **`handleMessage` has `cursor` but ignores it** — destructured from `params` but never used. If MCP clients pass cursor-based state, it's silently dropped.
