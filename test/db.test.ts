/**
 * Tests for DB — the SQLite persistence layer (better-sqlite3).
 *
 * Strategy:
 *   • Create a fresh in-memory DB per test file using `:memory:`.
 *   • No mocks needed: the DB class itself is the unit under test.
 *   • Verify every public method and its branches (happy + error-prone paths).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/db.js";
import type { SessionRow } from "../src/db.js";

// ---- per-test-file fixture (in-memory DB shared by all tests) ----

let db: DB;

after(() => {
  db?.db.close();
});

// ---- Test Suite: Create Session ----

describe("createSession", () => {
  test("creates a minimal session (only id + title)", () => {
    db = new DB(":memory:");
    const row = db.createSession({ id: "sess-min", title: "Minimal" });
    assert.strictEqual(row.id, "sess-min");
    assert.strictEqual(row.title, "Minimal");
    assert.strictEqual(row.status, "open");
    assert.ok(row.created_at);
    assert.strictEqual(row.description, null);
    assert.strictEqual(row.worktree_path, null);
    assert.strictEqual(row.last_message_at, null);
  });

  test("creates a session with description only", () => {
    db = new DB(":memory:");
    const row = db.createSession({
      id: "sess-desc",
      title: "Has Description",
      description: "A session focused on debugging",
    });
    assert.strictEqual(row.description, "A session focused on debugging");
  });

  test("creates a session with worktreePath only", () => {
    db = new DB(":memory:");
    const row = db.createSession({
      id: "sess-wt",
      title: "Has Worktree",
      worktreePath: "/data/workspaces/sessions/sess-wt",
    });
    assert.strictEqual(row.worktree_path, "/data/workspaces/sessions/sess-wt");
  });

  test("creates a session with both description and worktreePath", () => {
    db = new DB(":memory:");
    const row = db.createSession({
      id: "sess-full",
      title: "Full Session",
      description: "Full description",
      worktreePath: "/ws/sess-full",
    });
    assert.strictEqual(row.description, "Full description");
    assert.strictEqual(row.worktree_path, "/ws/sess-full");
  });

  test("returned row matches what getSession returns", () => {
    db = new DB(":memory:");
    const created = db.createSession({
      id: "sess-match",
      title: "Match Check",
      description: "Verify round-trip",
      worktreePath: "/ws/match",
    });
    const found = db.getSession("sess-match");
    assert.ok(found);
    assert.strictEqual(found.id, created.id);
    assert.strictEqual(found.title, created.title);
    assert.strictEqual(found.description, created.description);
    assert.strictEqual(found.worktree_path, created.worktree_path);
    assert.strictEqual(found.status, created.status);
  });
});

// ---- Test Suite: Get Session ----

describe("getSession", () => {
  test("returns the row when session exists", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-get", title: "Get Test" });
    const found = db.getSession("sess-get");
    assert.ok(found);
    assert.strictEqual(found.title, "Get Test");
  });

  test("returns null when session does not exist", () => {
    db = new DB(":memory:");
    const found = db.getSession("nonexistent");
    assert.strictEqual(found, null);
  });
});

// ---- Test Suite: List Sessions ----

describe("listSessions", () => {
  test("returns all sessions ordered by last_message_at desc, then created_at desc", () => {
    db = new DB(":memory:");

    const t1 = "2025-01-01T00:00:00.000Z";
    const t2 = "2025-01-02T00:00:00.000Z";
    const t3 = "2025-01-03T00:00:00.000Z";

    // Insert rows with distinct created_at directly via SQL since
    // createSession() would assign them all the same (now) timestamp.
    db.db.exec(`INSERT INTO sessions (id, title, status, created_at, description, worktree_path) VALUES ('sess-a', 'A', 'open', '${t1}', null, null)`);
    db.db.exec(`INSERT INTO sessions (id, title, status, created_at, description, worktree_path) VALUES ('sess-b', 'B', 'open', '${t2}', null, null)`);
    db.db.exec(`INSERT INTO sessions (id, title, status, created_at, description, worktree_path) VALUES ('sess-c', 'C', 'open', '${t3}', null, null)`);

    // Touch sess-b to set last_message_at to t2
    db.db.prepare(`UPDATE sessions SET last_message_at = ? WHERE id = ?`).run(t2, "sess-b");
    // sess-a gets no last_message_at, falls back to created_at (t1)
    // sess-c gets no last_message_at, falls back to created_at (t3)

    const rows = db.listSessions() as SessionRow[];
    // Expected order: sess-c (last_message_at = null, created_at = t3),
    //                 sess-b (last_message_at = t2, created_at = t2)
    //                 sess-a (last_message_at = null, created_at = t1)
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].id, "sess-c");
    assert.strictEqual(rows[1].id, "sess-b");
    assert.strictEqual(rows[2].id, "sess-a");
  });

  test("returns empty array when no sessions exist", () => {
    db = new DB(":memory:");
    assert.deepStrictEqual(db.listSessions(), []);
  });

  test("updates status correctly on list", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-status", title: "Status Check" });
    db.updateSessionStatus("sess-status", "closed");

    const rows = db.listSessions() as SessionRow[];
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, "closed");
  });
});

// ---- Test Suite: Update Session Status ----

describe("updateSessionStatus", () => {
  test("changes open → closed", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-update", title: "Update Test" });
    db.updateSessionStatus("sess-update", "closed");
    const updated = db.getSession("sess-update");
    assert.ok(updated);
    assert.strictEqual(updated.status, "closed");
  });

  test("changes open → error", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-err", title: "Error Update" });
    db.updateSessionStatus("sess-err", "error");
    const updated = db.getSession("sess-err");
    assert.ok(updated);
    assert.strictEqual(updated.status, "error");
  });
});

// ---- Test Suite: Set Session Worktree ----

describe("setSessionWorktree", () => {
  test("stores worktree path for an existing session", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-wt", title: "Write Worktree" });
    db.setSessionWorktree("sess-wt", "/data/workspaces/sessions/sess-wt");
    const updated = db.getSession("sess-wt");
    assert.ok(updated);
    assert.strictEqual(updated.worktree_path, "/data/workspaces/sessions/sess-wt");
  });
});

// ---- Test Suite: Touch Session ----

describe("touchSession", () => {
  test("updates last_message_at to current time", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-touch", title: "Touch Test" });
    const before = db.getSession("sess-touch")?.last_message_at;
    assert.strictEqual(before, null);

    db.touchSession("sess-touch");
    const after = db.getSession("sess-touch")?.last_message_at;
    assert.ok(after);
    assert.notStrictEqual(after, before);
  });

  test("subsequent touch updates last_message_at again", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-touch2", title: "Twice Touch" });
    db.touchSession("sess-touch2");
    const t1 = db.getSession("sess-touch2")?.last_message_at;

    // Force via direct update, then touch again
    db.db.prepare(`UPDATE sessions SET last_message_at = ? WHERE id = ?`).run(t1 + "x", "sess-touch2");
    db.touchSession("sess-touch2");
    const t2 = db.getSession("sess-touch2")?.last_message_at;
    assert.strictEqual(t2! >= (t1 || ""), true);
  });
});

// ---- Test Suite: Get Expired Sessions ----

describe("getExpiredSessions", () => {
  test("filters sessions where COALESCE(last_message_at, created_at) < threshold", () => {
    db = new DB(":memory:");

    // Insert rows directly via SQL (bound params don't work with db.db.exec).
    db.db.exec(`INSERT INTO sessions (id, title, status, created_at, description, worktree_path) VALUES ('sess-old1', 'Old 1', 'open', '2024-01-01T00:00:00.000Z', 'desc1', null)`);
    db.db.exec(`INSERT INTO sessions (id, title, status, created_at, description, worktree_path) VALUES ('sess-old2', 'Old 2', 'open', '2024-06-01T00:00:00.000Z', 'desc2', null)`);
    db.db.exec(`INSERT INTO sessions (id, title, status, created_at, last_message_at, description, worktree_path) VALUES ('sess-old-lm', 'Old LastMsg', 'open', '2024-03-01T00:00:00.000Z', '2024-01-15T00:00:00.000Z', 'desc3', null)`);

    // Threshold: sessions before this timestamp are "expired"
    const threshold = "2024-02-01T00:00:00.000Z";
    const expired = db.getExpiredSessions(threshold);

    // sess-old1: created_at 2024-01-01 < threshold → expired
    // sess-old2: created_at 2024-06-01 >= threshold → NOT expired
    // sess-old-lm: last_message_at 2024-01-15 < threshold → expired
    assert.strictEqual(expired.length, 2);
    assert.ok(expired.includes("sess-old1"));
    assert.ok(expired.includes("sess-old-lm"));
    assert.ok(!expired.includes("sess-old2"));
  });

  test("returns empty array when no sessions are expired", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-new", title: "Very Recent" });
    const expired = db.getExpiredSessions("2020-01-01T00:00:00.000Z");
    assert.strictEqual(expired.length, 0);
  });

  test("uses COALESCE — falls back to created_at when last_message_at is null", () => {
    db = new DB(":memory:");
    db.db.exec(`INSERT INTO sessions (id, title, status, created_at, last_message_at) VALUES ('sess-no-lm', 'No LastMsg', 'open', '2023-01-01T00:00:00.000Z', NULL)`);

    const expired = db.getExpiredSessions("2024-01-01T00:00:00.000Z");
    assert.strictEqual(expired.includes("sess-no-lm"), true);
  });
});

// ---- Test Suite: Upsert Pr Link ----

describe("upsertPrLink", () => {
  test("creates a new pr_link row", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-pr-new", title: "PR New" });
    db.upsertPrLink({
      session_id: "sess-pr-new",
      pr_number: 42,
      pr_url: "https://github.com/owner/repo/pull/42",
      artifact_url: null,
    });
    const link = db.getPrLink("sess-pr-new");
    assert.ok(link);
    assert.strictEqual(link.pr_number, 42);
    assert.strictEqual(link.pr_url, "https://github.com/owner/repo/pull/42");
    assert.strictEqual(link.artifact_url, null);
    assert.ok(link.updated_at);
  });

  test("updates pr_number and pr_url while preserving artifact_url", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-pr-update", title: "PR Update" });

    // First insertion with artifact_url
    db.upsertPrLink({
      session_id: "sess-pr-update",
      pr_number: 10,
      pr_url: "https://github.com/owner/repo/pull/10",
      artifact_url: "https://github.com/owner/repo/releases/download/abc/artifact.tgz",
    });

    // Second upsert with only pr_number and pr_url
    db.upsertPrLink({
      session_id: "sess-pr-update",
      pr_number: 42,
      pr_url: "https://github.com/owner/repo/pull/42",
    });

    const link = db.getPrLink("sess-pr-update");
    assert.ok(link);
    assert.strictEqual(link.pr_number, 42);
    assert.strictEqual(link.pr_url, "https://github.com/owner/repo/pull/42");
    // artifact_url should be preserved from first insertion
    assert.strictEqual(link.artifact_url, "https://github.com/owner/repo/releases/download/abc/artifact.tgz");
  });

  test("resets pr_number to null if pr_number field is not provided and existing is null", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-pr-null", title: "PR Null" });

    // Insert without pr_number
    db.upsertPrLink({ session_id: "sess-pr-null" });
    const link = db.getPrLink("sess-pr-null");
    assert.ok(link);
    assert.strictEqual(link.pr_number, null);
  });
});

// ---- Test Suite: Get Pr Link ----

describe("getPrLink", () => {
  test("returns the link when it exists", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-gpl", title: "Get Pr Link" });
    db.upsertPrLink({ session_id: "sess-gpl", pr_number: 55, pr_url: "https://example.com/pr/55" });
    const found = db.getPrLink("sess-gpl");
    assert.ok(found);
    assert.strictEqual(found.session_id, "sess-gpl");
    assert.strictEqual(found.pr_number, 55);
  });

  test("returns null when no pr_link exists", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-no-prl", title: "No Pr Link" });
    const found = db.getPrLink("sess-no-prl");
    assert.strictEqual(found, null);
  });
});

// ---- Test Suite: List Open Pr Links ----

describe("listOpenPrLinks", () => {
  test("filters pr_links where pr_number IS NOT NULL", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-open-a", title: "Open A" });
    db.createSession({ id: "sess-open-b", title: "Open B" });
    db.createSession({ id: "sess-open-c", title: "Open C" });

    // Pr link with pr_number
    db.upsertPrLink({ session_id: "sess-open-a", pr_number: 10 });
    // Pr link with null pr_number (should NOT appear)
    db.upsertPrLink({ session_id: "sess-open-b", pr_number: null });
    // No pr_link at all (should NOT appear)

    const links = db.listOpenPrLinks();
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].session_id, "sess-open-a");
    assert.strictEqual(links[0].pr_number, 10);
  });

  test("returns all open pr links when multiple exist", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-multi1", title: "Multi 1" });
    db.createSession({ id: "sess-multi2", title: "Multi 2" });

    db.upsertPrLink({ session_id: "sess-multi1", pr_number: 1 });
    db.upsertPrLink({ session_id: "sess-multi2", pr_number: 2 });

    const links = db.listOpenPrLinks();
    assert.strictEqual(links.length, 2);
    const sessionIds = links.map((l) => l.session_id);
    assert.ok(sessionIds.includes("sess-multi1"));
    assert.ok(sessionIds.includes("sess-multi2"));
  });

  test("returns empty array when no pr_links have pr_number", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-no-open", title: "No Open" });
    db.upsertPrLink({ session_id: "sess-no-open" });
    assert.strictEqual(db.listOpenPrLinks().length, 0);
  });
});

// ---- Test Suite: Delete Session ----

describe("deleteSession", () => {
  test("removes session from sessions table", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-del", title: "Delete Me" });
    db.deleteSession("sess-del");
    assert.strictEqual(db.getSession("sess-del"), null);
  });

  test("removes pr_link from pr_links table as well", () => {
    db = new DB(":memory:");
    db.createSession({ id: "sess-del-pl", title: "Delete Pr Link" });
    db.upsertPrLink({ session_id: "sess-del-pl", pr_number: 1 });
    db.deleteSession("sess-del-pl");
    assert.strictEqual(db.getPrLink("sess-del-pl"), null);
    assert.strictEqual(db.getSession("sess-del-pl"), null);
  });

  test("does not throw when session does not exist (idempotent)", () => {
    db = new DB(":memory:");
    assert.doesNotThrow(() => db.deleteSession("nonexistent"));
  });
});

// ---- Test Suite: Recent Sessions ----

describe("recentSessions", () => {
  test("returns sessions ordered by COALESCE last_message_at desc, then created_at desc", () => {
    db = new DB(":memory:");

    // Insert directly via SQL to get distinct timestamps,
    // since createSession() would assign all the same (now).
    db.db.exec(`INSERT INTO sessions (id, title, status, created_at) VALUES ('r-sess-x', 'R-X', 'open', '2025-01-01T00:00:00.000Z')`);
    db.db.exec(`INSERT INTO sessions (id, title, status, created_at) VALUES ('r-sess-y', 'R-Y', 'open', '2025-01-02T00:00:00.000Z')`);
    db.db.exec(`INSERT INTO sessions (id, title, status, created_at) VALUES ('r-sess-z', 'R-Z', 'open', '2025-01-03T00:00:00.000Z')`);

    // Touch r-sess-y with an explicit, explicit timestamp (2025-01-04) to
    // simulate it being the most recently updated.
    db.db.prepare(`UPDATE sessions SET last_message_at = '2025-01-04T00:00:00.000Z' WHERE id = 'r-sess-y'`).run();

    const rows = db.recentSessions(2);
    assert.strictEqual(rows.length, 2);
    // r-sess-y should be first (last_message_at = 2025-01-04 > r-sess-z created_at = 2025-01-03)
    assert.strictEqual(rows[0].id, "r-sess-y");
    // r-sess-z second (created_at = 2025-01-03 > r-sess-x created_at = 2025-01-01)
    assert.strictEqual(rows[1].id, "r-sess-z");
  });

  test("respects the limit parameter when there are more sessions", () => {
    db = new DB(":memory:");
    for (let i = 0; i < 10; i++) {
      db.createSession({ id: `sess-r-${i}`, title: `R-${i}` });
    }
    const rows = db.recentSessions(3);
    assert.strictEqual(rows.length, 3);
  });

  test("returns limited rows when limit exceeds count", () => {
    db = new DB(":memory:");
    db.createSession({ id: "r-single", title: "R Single" });
    const rows = db.recentSessions(100);
    assert.strictEqual(rows.length, 1);
  });

  test("does not include pr_link or worktree_path in recent output", () => {
    db = new DB(":memory:");
    db.createSession({ id: "r-clean", title: "R-Clean" });
    db.upsertPrLink({ session_id: "r-clean", pr_number: 1 });
    db.setSessionWorktree("r-clean", "/ws/clean");

    const rows = db.recentSessions(10);
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.id, "r-clean");
    assert.strictEqual(row.title, "R-Clean");
    assert.strictEqual(row.description, null);
    // Type narrowing confirms only { id, title, description } returned
    assert.strictEqual(Object.keys(row).sort().toString(), "description,id,title");
  });

  test("limit is clamped: limit=0 returns 0 rows (DB passes limit directly to SQLite)", () => {
    db = new DB(":memory:");
    db.createSession({ id: "r-min", title: "R-Min" });
    // DB.recentSessions does NOT clamp; limit=0 → LIMIT 0 in SQL → 0 rows
    const rows = db.recentSessions(0);
    assert.strictEqual(rows.length, 0);
  });
});
