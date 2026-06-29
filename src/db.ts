import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type SessionStatus = "open" | "closed" | "error";

export interface SessionRow {
  id: string;
  title: string;
  status: SessionStatus;
  created_at: string;
  last_message_at: string | null;
  description: string | null;
  worktree_path: string | null;
}

export interface PrLinkRow {
  session_id: string;
  pr_number: number | null;
  pr_url: string | null;
  artifact_url: string | null;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TEXT NOT NULL,
  last_message_at TEXT,
  description     TEXT,
  worktree_path   TEXT
);

CREATE TABLE IF NOT EXISTS pr_links (
  session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  pr_number    INTEGER,
  pr_url       TEXT,
  artifact_url TEXT,
  updated_at   TEXT NOT NULL
);
`;

export class DB {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);

    // Migrate existing pr_links FK to have ON DELETE CASCADE.
    // SQLite doesn't support ALTER TABLE on FK constraints, so we
    // recreate pr_links via a temp table (safe: it's a single PK row per session).
    this.fixPrLinksFk();
  }

  private fixPrLinksFk(): void {
    // Check if the table already has CASCADE
    const existing = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='pr_links'`,
    ).get() as { sql: string } | undefined;
    if (!existing) return;
    if (existing.sql.includes("ON DELETE CASCADE")) return;

    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec("BEGIN IMMEDIATE");

    // Copy pr_links data to a temp table
    this.db.exec(`
      CREATE TEMPORARY TABLE pr_links_bak (
        session_id   TEXT PRIMARY KEY,
        pr_number    INTEGER,
        pr_url       TEXT,
        artifact_url TEXT,
        updated_at   TEXT NOT NULL
      )
    `);
    this.db.exec(`INSERT INTO pr_links_bak SELECT * FROM pr_links`);

    // Drop pr_links (sessions stays — they can be dropped/created together)
    this.db.exec("DROP TABLE pr_links");

    // Recreate pr_links with CASCADE FK
    this.db.exec(`
      CREATE TABLE pr_links (
        session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        pr_number    INTEGER,
        pr_url       TEXT,
        artifact_url TEXT,
        updated_at   TEXT NOT NULL
      )
    `);

    // Restore data
    this.db.exec("INSERT INTO pr_links SELECT * FROM pr_links_bak");
    this.db.exec("DROP TABLE pr_links_bak");

    this.db.exec("COMMIT");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  // ---- sessions ----
  createSession(row: {
    id: string;
    title: string;
    description?: string;
    worktreePath?: string;
  }): SessionRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, status, created_at, description, worktree_path)
         VALUES (?, ?, 'open', ?, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        now,
        row.description ?? null,
        row.worktreePath ?? null,
      );
    return this.getSession(row.id)!;
  }

  getSession(id: string): SessionRow | null {
    return (
      (this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined) ??
      null
    );
  }

  listSessions(): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions ORDER BY COALESCE(last_message_at, created_at) DESC`)
      .all() as SessionRow[];
  }

  updateSessionStatus(id: string, status: SessionStatus): void {
    this.db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, id);
  }

  setSessionWorktree(id: string, worktreePath: string): void {
    this.db.prepare(`UPDATE sessions SET worktree_path = ? WHERE id = ?`).run(worktreePath, id);
  }

  touchSession(id: string): void {
    this.db
      .prepare(`UPDATE sessions SET last_message_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  getExpiredSessions(maxAgeIso: string): string[] {
    const rows = this.db.prepare(
      `SELECT id FROM sessions
       WHERE COALESCE(last_message_at, created_at) < ?`,
    ).all(maxAgeIso) as { id: string }[];
    return rows.map((row) => row.id);
  }

  // ---- pr_links ----
  upsertPrLink(row: Partial<PrLinkRow> & { session_id: string }): void {
    const now = new Date().toISOString();
    const existing = this.getPrLink(row.session_id);
    const merged = {
      session_id: row.session_id,
      pr_number: row.pr_number ?? existing?.pr_number ?? null,
      pr_url: row.pr_url ?? existing?.pr_url ?? null,
      artifact_url: row.artifact_url ?? existing?.artifact_url ?? null,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pr_links
         (session_id, pr_number, pr_url, artifact_url, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        merged.session_id,
        merged.pr_number,
        merged.pr_url,
        merged.artifact_url,
        merged.updated_at,
      );
  }

  getPrLink(sessionId: string): PrLinkRow | null {
    return (
      (this.db.prepare(`SELECT * FROM pr_links WHERE session_id = ?`).get(sessionId) as
        | PrLinkRow
        | undefined) ?? null
    );
  }

  listOpenPrLinks(): PrLinkRow[] {
    return this.db
      .prepare(`SELECT * FROM pr_links WHERE pr_number IS NOT NULL`)
      .all() as PrLinkRow[];
  }

  // ---- delete ----
  deleteSession(id: string): void {
    this.db.prepare(`DELETE FROM pr_links WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  // ---- recent ----
  recentSessions(limit: number): { id: string; title: string; description: string | null }[] {
    return this.db
      .prepare(
        `SELECT id, title, description FROM sessions
         ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?`,
      )
      .all(limit) as { id: string; title: string; description: string | null }[];
  }
}
