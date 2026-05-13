import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type SessionStatus = "open" | "closed" | "error";
export type MessageRole = "user" | "assistant" | "tool_result";

export interface SessionRow {
  id: string;
  title: string;
  status: SessionStatus;
  created_at: string;
  last_message_at: string | null;
  description: string | null;
  device: string | null;
  worktree_path: string | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
}

export interface AppContextRow {
  session_id: string;
  name: string;
  content: string;
  attrs: string | null;
}

export interface PrLinkRow {
  session_id: string;
  pr_number: number | null;
  pr_url: string | null;
  artifact_url: string | null;
  qr_url: string | null;
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
  device          TEXT,
  worktree_path   TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS app_contexts (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  attrs      TEXT,
  PRIMARY KEY (session_id, name)
);

CREATE TABLE IF NOT EXISTS pr_links (
  session_id   TEXT PRIMARY KEY REFERENCES sessions(id),
  pr_number    INTEGER,
  pr_url       TEXT,
  artifact_url TEXT,
  qr_url       TEXT,
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
  }

  // ---- sessions ----
  createSession(row: {
    id: string;
    title: string;
    description?: string;
    device?: string;
    worktreePath?: string;
  }): SessionRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, status, created_at, description, device, worktree_path)
         VALUES (?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        now,
        row.description ?? null,
        row.device ?? null,
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

  // ---- messages ----
  appendMessage(row: {
    id: string;
    sessionId: string;
    role: MessageRole;
    content: string;
  }): MessageRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.sessionId, row.role, row.content, now);
    this.touchSession(row.sessionId);
    return {
      id: row.id,
      session_id: row.sessionId,
      role: row.role,
      content: row.content,
      created_at: now,
    };
  }

  listMessages(sessionId: string): MessageRow[] {
    return this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as MessageRow[];
  }

  // ---- app_contexts ----
  putAppContext(
    sessionId: string,
    name: string,
    content: string,
    attrs: Record<string, string>,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO app_contexts (session_id, name, content, attrs)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, name, content, JSON.stringify(attrs));
  }

  listAppContexts(
    sessionId: string,
  ): { name: string; content: string; attrs: Record<string, string> }[] {
    const rows = this.db
      .prepare(`SELECT name, content, attrs FROM app_contexts WHERE session_id = ?`)
      .all(sessionId) as { name: string; content: string; attrs: string | null }[];
    return rows.map((r) => ({
      name: r.name,
      content: r.content,
      attrs: r.attrs ? JSON.parse(r.attrs) : {},
    }));
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
      qr_url: row.qr_url ?? existing?.qr_url ?? null,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pr_links
         (session_id, pr_number, pr_url, artifact_url, qr_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merged.session_id,
        merged.pr_number,
        merged.pr_url,
        merged.artifact_url,
        merged.qr_url,
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
    this.db.prepare(`DELETE FROM app_contexts WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  // ---- recent ----
  recentSessions(limit: number): { id: string; title: string; description: string | null }[] {
    return this.db
      .prepare(
        `SELECT id, title, description FROM sessions
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as { id: string; title: string; description: string | null }[];
  }
}
