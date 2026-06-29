# FIXMES — MCP Rewrite Review

Generated from review of `mcp-rewrite` branch against `main`.

---

## 🔴 High Severity

### 1. Crash on malformed `tools/call` with no `params`
**File:** `src/mcp_server.ts:98`
```ts
const { name, arguments: args, cursor } = params as any;
const sessionId = args.sessionId;
```
If `params` is `undefined` or null, this crashes with a TypeError before the `sessionId` guard. Wrap in a try or validate first.

### 2. `open_pr` missing `signal` propagation
**File:** `src/tool_engine.ts:144-151`
Other tools pass `signal` to `sandbox.exec`, but `open_pr` doesn't. If the client aborts mid-PR, the container call still runs.

### 3. No size limit on `bash` tool input
**File:** `src/tool_engine.ts:20, 66`
Description promises "Output is truncated to 32 KB" but accepts unlimited input. A 10MB `cmd` string would blow past container buffers. Add an input `maxBytes` check before calling `sandbox.exec`.

### 4. Silent proxy sync failure at boot
**File:** `src/server.ts:84`
```ts
syncProxy();
```
Returns boolean but the return value is ignored. If the allowlist write or proxy signal fails, the server boots unnotified — the proxy may silently have a stale or empty allowlist.

---

## 🟡 Medium Severity

### 5. `initialize` returns hard-coded protocol/version
**File:** `src/mcp_server.ts:24-27`
`protocolVersion: "2024-11-05"` is a snapshot of the spec. If MCP versioning evolves, this could silently desync. Consider reading from the MCP SDK or a constant with a changelog comment.

### 6. Error in `initialize` / `tools/list` returns raw `e.message`
**File:** `src/mcp_server.ts:112-116`
Uses `-32000` which isn't in JSON-RPC 2.0 or MCP's defined error ranges. Should use `-32600` (Invalid Request) or `-32603` (Internal Error).

### 7. `api_auth.ts` allows all traffic when `API_KEY` is unset
**File:** `src/api_auth.ts:12-15`
```ts
if (!expectedKey) return await next();
```
Development convenience masquerading as production behavior. Add a `WARN` log at runtime and/or a `REQUIRE_API_KEY` env var toggle.

### 8. `tool_write_file` shell escaping for paths is fragile
**File:** `src/tool_engine.ts:79`
```ts
const safePath = relPath.replace(/'/g, "'\\''");
```
Works for typical files but breaks on paths containing `\` before the quote. Consider using `printf '%s' "$1"` with `$'...'` quoting or passing paths via heredoc.

### 9. `tool_apply_patch`: `patch -p1` is dangerous with unsanitized input
**File:** `src/tool_engine.ts:90`
The patch content comes directly from the tool argument. While sandboxed, a crafted patch can `cd` to `..` and escape the worktree root. Consider validating paths within the patch against allowed prefixes.

---

## 🟢 Low Severity / Style

### 10. `sessionId` required for every tool including `list_recent_sessions`
**File:** `src/mcp_server.ts:82-86`
Requiring `sessionId` for a "list recent sessions" tool that returns *all* sessions is semantically odd. This tool seems to be a system/admin tool, not session-scoped. Consider making it a server-level tool without `sessionId`.

### 11. `syncProxy` called twice at startup
**File:** `src/server.ts:82-84`
Then `toolEngine` also holds `syncProxy` and calls it during `provisionSession`. The first call is the only one that matters if allowlist hasn't changed — this is fine but the `syncProxy` method on `ToolEngine` and the standalone `syncProxy` variable are redundant for boot-time init.

### 12. DB connection leak risk
**File:** `src/db.ts`
No `db.close()` on shutdown. SQLite handles this on process exit, but for long-running servers it's a good practice to close.

### 13. `mcp_server.ts` has no `logging` capabilities declared
MCP clients may try to use the logging capability which isn't advertised. Either declare it in capabilities or drop it.

### 14. `tool_engine.ts:51` — `asString()` helper could throw unclear errors
```ts
function asString(v: unknown, name: string): string {
```
Throws `"cmd must be a string"` on type mismatch — good and clear. Consider adding `instanceof Buffer` or `Uint8Array` guards for content since it could arrive as bytes in some transports.

---

## Summary

| Severity | Count |
|------ ----|----- -|
| 🔴 High  | 4     |
| 🟡 Medium| 5     |
| 🟢 Low   | 5     |

## Most Actionable Fixes

1. Add input size limit on `bash` tool (safety)
2. Propagate `signal` in `open_pr` (correctness)
3. Handle undefined `params` in `tools/call` (crash)
4. Check `syncProxy()` return and warn/log on failure (observability)
5. Add `REQUIRE_API_KEY` override to `api_auth.ts` (defense in depth)
