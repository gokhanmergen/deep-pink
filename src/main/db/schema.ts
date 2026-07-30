/**
 * Schema migrations, applied in order. Each entry runs exactly once and the
 * applied version is recorded in `user_version`.
 *
 * Everything the app knows lives in this one SQLite file, under the OS user
 * data directory. Nothing is synced anywhere.
 */
export const MIGRATIONS: string[] = [
  /* 1 — core tables */ `
  CREATE TABLE threads (
    id                 TEXT PRIMARY KEY,
    title              TEXT    NOT NULL DEFAULT '',
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    pinned             INTEGER NOT NULL DEFAULT 0,
    archived           INTEGER NOT NULL DEFAULT 0,
    config             TEXT    NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_threads_updated ON threads (pinned DESC, updated_at DESC);

  CREATE TABLE messages (
    id                     TEXT PRIMARY KEY,
    thread_id              TEXT    NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    seq                    INTEGER NOT NULL,
    role                   TEXT    NOT NULL,
    content                TEXT    NOT NULL DEFAULT '',
    reasoning              TEXT,
    created_at             INTEGER NOT NULL,
    model                  TEXT,
    provider               TEXT,
    status                 TEXT    NOT NULL DEFAULT 'complete',
    error                  TEXT,
    tool_calls             TEXT,
    tool_result            TEXT,
    system_prompt_snapshot TEXT,
    is_compaction_summary  INTEGER NOT NULL DEFAULT 0,
    compacted_into         TEXT
  );
  CREATE INDEX idx_messages_thread ON messages (thread_id, seq);

  CREATE TABLE usage (
    message_id        TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    thread_id         TEXT    NOT NULL,
    model             TEXT,
    provider          TEXT,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL    NOT NULL DEFAULT 0,
    latency_ms        INTEGER NOT NULL DEFAULT 0,
    ttft_ms           INTEGER,
    tokens_per_second REAL,
    generation_id     TEXT,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX idx_usage_thread  ON usage (thread_id);
  CREATE INDEX idx_usage_created ON usage (created_at);
  CREATE INDEX idx_usage_model   ON usage (model);

  CREATE TABLE tool_invocations (
    id          TEXT PRIMARY KEY,
    thread_id   TEXT    NOT NULL,
    message_id  TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    server_id   TEXT,
    tool_name   TEXT    NOT NULL,
    is_error    INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_tool_thread  ON tool_invocations (thread_id);
  CREATE INDEX idx_tool_created ON tool_invocations (created_at);

  CREATE TABLE mcp_servers (
    id         TEXT PRIMARY KEY,
    config     TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE model_cache (
    id         TEXT PRIMARY KEY,
    payload    TEXT    NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  `,

  /* 2 — full-text search over message bodies */ `
  CREATE VIRTUAL TABLE messages_fts USING fts5 (
    content,
    content='messages',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts (rowid, content) VALUES (new.rowid, new.content);
  END;
  `,
/* 3 — image attachments; bytes live on disk, this is the index */ `
  CREATE TABLE attachments (
    id         TEXT PRIMARY KEY,
    message_id TEXT    NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    thread_id  TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    filename   TEXT    NOT NULL DEFAULT '',
    bytes      INTEGER NOT NULL DEFAULT 0,
    width      INTEGER,
    height     INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_attachments_message ON attachments (message_id);
  CREATE INDEX idx_attachments_thread  ON attachments (thread_id);
  `,

  /* 4 — attachments may be text as well as images */ `
  ALTER TABLE attachments ADD COLUMN preview TEXT;
  `
]
