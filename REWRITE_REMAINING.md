# MCP Rewrite — Remaining Work Tracker

Generated: 2026-06-27

---

## P0 — Fix before release

- [ ] **mcp_server.ts: Add `id` fields to tools in `tools/list`**
  - MCP spec section 2.4 requires an `id` field on each tool entry
  - Fix in `mcp_server.ts`

- [ ] **mcp_server.ts: Delete 3 stale comment blocks**
  - Lines ~72-75: "For now, we'll expect it in the arguments or a header."
  - Lines ~85-88: "Let's check for a 'sessionId' in args."
  - Lines ~97-99: "Map Open WebUI's chat_id / sessionId to dedicated git worktrees"

---

## P1 — Should fix next

- [ ] **Remove/deprecate dead `device` and `qr_url` columns from sessions table**
  - `device` — never written by MCP path (old web UI artifact)
  - `qr_url` — always null (old artifact/QR generation)
  - In `src/db.ts`

- [ ] **Remove dead `listOpenPrLinks()` method from `db.ts`**
  - Has zero callers in the codebase

- [ ] **Clean up `progress.md` — populate with real data**
  - Currently an empty template

- [ ] **Consider session ID convention**
  - Every tool forces `sessionId` as a manual arg — not MCP-standard
  - Might need a scoped session mechanism (`session_bind` method)

---

## P2 — Nice to have

- [ ] **Refactor `open_pr` to use `spawn` instead of `spawnSync`**
  - Currently blocks request thread in `tool_engine.ts`
  - Should be async with a spawned child process

- [ ] **Add test coverage**
  - Zero tests for new code (`tool_engine`, `mcp_server`, `api_auth`)
  - Only `sandbox.test.ts` remains from before the rewrite

- [ ] **Fix pre-existing TSC error in `db.ts:120`**
  - `better-sqlite3` type definition conflict on `.map()` chain
  - Not caused by the rewrite but should be fixed

---

## Not Done (deferred)

- [ ] SSE notification support — per MCP spec, server can push notifications
- [ ] `device`/`qr_url` migration in existing DB schemas (may drop columns in a future migration)
