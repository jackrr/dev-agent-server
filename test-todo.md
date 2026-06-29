# Test Coverage Audit

**What IS covered (well):**

| Source | Test Files | Coverage |
|--------|-----------|----------|
| `api_auth.ts` | Test file 2 + 4 | ✅ Auth middleware, all branches |
| `mcp_server.ts` | Test files 3 + 4 | ✅ SSE, init, tools/list, tools/call, errors |
| `github.js` (globToRegex) | Test file 1 | ✅ Regex generation patterns |

**What is NOT covered by any tests:**

| Source | Why it needs tests |
|--------|--------------------|
| **`db.ts`** — Session/PR link CRUD, `getExpiredSessions`, `upsertPrLink` merge logic, `listOpenPrLinks`, `recentSessions` | Critical data layer, no tests at all |
| **`tool_engine.ts`** — tool routing, `asString` helper, error handling, error paths (missing session, missing worktree, sandbox exec failure) | Complex routing / error logic, no tests |
| **`poller.ts`** — `start`/`stop`/`tickSafe` / guard logic (`!cfg.ship`, `already resolved`, `no sha` found) | Only lightly touched in test file 1 |
| **`workspace.ts`** — `ensureMainClone` (fetch/reset flow), worktree creation/removal edge cases | No `Workspace` tests exist |
| **`proxy.ts`** — `syncProxyAllowlist` change-detection, skip path, kill path, write-failure path | No tests |

**What is covered but could be deeper:**

| Source | Gap |
|--------|---|
| `mcp_server.ts` | Two almost-identical test file 3 + 4 (test file 3 is a duplicate) |
| `api_auth.ts` | Test file 2 is good but `apiKeyAuth` itself is trivial — coverage is adequate |
| `github.js` | Only `globToRegex` regex output; actual GitHub API methods (`openPr`, `findReleaseAsset`, `prHeadSha`) are only tested via string substitution, not the real class methods |
| `server.ts` | Only tested implicitly through the Hono mirroring in test file 2 — **nothing** tests sandbox lifecycle, reaper, SIGTERM, project config loading |

**Recommendations (highest value):**

1. **Add `db.ts` tests** — SQLite in-memory (better-sqlite3 supports `:memory:`) — covers 0 lines, high value since it's the persistence layer
2. **Add `tool_engine.ts` tests** — mock the deps, test tool routing, error handling
3. **Add `workspace.ts` tests** — test `ensureMainClone` logic with `git` mocks
4. **Stop test file 3** — it's a near-duplicate of test file 4; deduplicate
