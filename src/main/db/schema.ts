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
  `,

  /* 5 — where a thread came from, so a re-import does not duplicate it */ `
  ALTER TABLE threads ADD COLUMN source TEXT;
  ALTER TABLE threads ADD COLUMN source_id TEXT;
  CREATE UNIQUE INDEX idx_threads_source ON threads (source, source_id)
    WHERE source IS NOT NULL;
  `,

  /* 6 — how much each tool call brought into the context */ `
  ALTER TABLE tool_invocations ADD COLUMN result_chars INTEGER NOT NULL DEFAULT 0;
  `,

  /* 7 — tags, shared across threads and searchable. Dropped again by 9; kept
     here because a database records how far through this list it has got, and
     removing an entry would renumber every migration after it. */ `
  CREATE TABLE tags (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- One row per tag however it is capitalised, so "Rust" and "rust" are one tag.
  CREATE UNIQUE INDEX idx_tags_name ON tags (name COLLATE NOCASE);

  CREATE TABLE thread_tags (
    thread_id  TEXT    NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    tag_id     TEXT    NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    -- 'user' or 'model'. A tag the user put on is never taken off by a model.
    source     TEXT    NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, tag_id)
  );
  CREATE INDEX idx_thread_tags_tag ON thread_tags (tag_id);
  `,

  /* 8 — per-tag flags: kept out of the model's reach, and pinned as a folder */ `
  ALTER TABLE tags ADD COLUMN manual_only INTEGER NOT NULL DEFAULT 0;
  -- A pinned tag is a pinned folder in the tag view. Deliberately unrelated to
  -- a pinned thread: the two views are pinned independently.
  ALTER TABLE tags ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  `,

  /* 9 — tags removed; the library, its threads' links and its leavings all go */ `
  DROP TABLE IF EXISTS thread_tags;
  DROP TABLE IF EXISTS tags;

  -- Tagging requests were recorded as hidden marker messages carrying their
  -- cost. Nothing reads them now, and leaving them behind would leave the
  -- statistics filtering for a feature that no longer exists. Their usage rows
  -- go with them by cascade.
  DELETE FROM messages WHERE compacted_into = 'tags';

  -- Settings were stored whole, so an upgraded install would otherwise keep a
  -- tagging block and its view preferences in its saved JSON forever.
  UPDATE settings
     SET value = json_remove(
           value,
           '$.tagging',
           '$.ui.threadSort',
           '$.ui.showTagsInSidebar',
           '$.keybinds."tagModel.picker"',
           '$.keybinds."tags.add"',
           '$.keybinds."tags.retag"',
           '$.keybinds."view.sortEdited"',
           '$.keybinds."view.sortCreated"',
           '$.keybinds."view.sortTags"'
         )
   WHERE key = 'settings' AND json_valid(value);
  `,

  /* 10 — folders: a thread lives in at most one, or in none */ `
  CREATE TABLE folders (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    -- Pinned exactly as a thread is: to the top of the list, above the dates.
    pinned     INTEGER NOT NULL DEFAULT 0
  );

  -- Deleting a folder empties it rather than taking the conversations with it:
  -- a folder is where something was filed, never what it is made of.
  ALTER TABLE threads ADD COLUMN folder_id TEXT REFERENCES folders (id) ON DELETE SET NULL;
  CREATE INDEX idx_threads_folder ON threads (folder_id);
  `,

  /* 11 — the accent was briefly re-defaulted, then put back. Kept because a
     database records how far through this list it has got; clearing a stored
     accent that equals the default is a no-op now that the default is that
     colour again, and an accent someone chose was never touched. */ `
  UPDATE settings
     SET value = json_remove(value, '$.ui.accent')
   WHERE key = 'settings'
     AND json_valid(value)
     AND lower(json_extract(value, '$.ui.accent')) = '#ff1493';
  `,

  /* 12 — attribution is on by default now */ `
  -- Settings are stored whole, so an install from before the change carries the
  -- old default forever. This clears the stored value only when it still equals
  -- that old default, so the new one applies; anyone who switched it on already
  -- has 'true' stored and is left alone.
  UPDATE settings
     SET value = json_remove(value, '$.sendAppAttribution')
   WHERE key = 'settings'
     AND json_valid(value)
     AND json_extract(value, '$.sendAppAttribution') = 0;
  `,

  /* 13 — what sync needs: a stamp on everything it can carry, and a mark left
     behind by everything that goes */ `
  -- When a row last changed, so two machines can tell which copy is newer.
  -- Backfilled from creation, which is the truth for anything never edited.
  ALTER TABLE messages    ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE folders     ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE attachments ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE mcp_servers ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE settings    ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

  UPDATE messages    SET updated_at = created_at;
  UPDATE folders     SET updated_at = created_at;
  UPDATE attachments SET updated_at = created_at;
  UPDATE mcp_servers SET updated_at = created_at;

  /*
   * A deletion has to travel, and it can only travel as a fact of its own:
   * "there is no thread 7 here" is indistinguishable from "this machine has
   * never heard of thread 7" unless something remembers that it went.
   *
   * Recorded by trigger rather than at each call site, so it cannot be missed —
   * not by a delete written later, and not by the cascade that takes a thread's
   * messages and their attachments with it.
   */
  CREATE TABLE sync_deletions (
    kind       TEXT    NOT NULL,
    id         TEXT    NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE INDEX idx_sync_deletions_at ON sync_deletions (deleted_at);

  CREATE TRIGGER threads_deleted AFTER DELETE ON threads BEGIN
    INSERT OR REPLACE INTO sync_deletions (kind, id, deleted_at)
    VALUES ('thread', old.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
  END;

  CREATE TRIGGER messages_deleted AFTER DELETE ON messages BEGIN
    INSERT OR REPLACE INTO sync_deletions (kind, id, deleted_at)
    VALUES ('message', old.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
  END;

  CREATE TRIGGER folders_deleted AFTER DELETE ON folders BEGIN
    INSERT OR REPLACE INTO sync_deletions (kind, id, deleted_at)
    VALUES ('folder', old.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
  END;

  CREATE TRIGGER attachments_deleted AFTER DELETE ON attachments BEGIN
    INSERT OR REPLACE INTO sync_deletions (kind, id, deleted_at)
    VALUES ('attachment', old.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
  END;

  CREATE TRIGGER mcp_servers_deleted AFTER DELETE ON mcp_servers BEGIN
    INSERT OR REPLACE INTO sync_deletions (kind, id, deleted_at)
    VALUES ('mcp', old.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
  END;
  `
]
