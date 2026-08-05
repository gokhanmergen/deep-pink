import { randomUUID } from 'node:crypto'
import type {
  Attachment,
  DailyUsage,
  GlobalStats,
  McpServerConfig,
  Message,
  ModelUsageRollup,
  Role,
  SearchHit,
  TagSource,
  TagSummary,
  Thread,
  ThreadConfig,
  ThreadStats,
  ToolUsageRollup,
  Usage
} from '@shared/types'
import { getDb } from './index'
import * as attachments from '../attachments'

/* ------------------------------------------------------------------ *
 * Row shapes
 * ------------------------------------------------------------------ */

interface ThreadRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  pinned: number
  archived: number
  config: string
}

interface MessageRow {
  id: string
  thread_id: string
  seq: number
  role: string
  content: string
  reasoning: string | null
  created_at: number
  model: string | null
  provider: string | null
  status: string
  error: string | null
  tool_calls: string | null
  tool_result: string | null
  system_prompt_snapshot: string | null
  is_compaction_summary: number
  compacted_into: string | null
}

interface UsageRow {
  message_id: string
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number
  cached_tokens: number
  total_tokens: number
  cost_usd: number
  latency_ms: number
  ttft_ms: number | null
  tokens_per_second: number | null
  generation_id: string | null
}

export const EMPTY_THREAD_CONFIG: ThreadConfig = {
  model: null,
  providerRouting: null,
  systemPrompt: null,
  temperature: null,
  maxTokens: null,
  webAccessEnabled: null,
  enabledMcpServers: null,
  repoPaths: [],
  disabledPromptSegments: []
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value)
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function toThread(row: ThreadRow, tags?: string[], messageCount?: number): Thread {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    tags: tags ?? getThreadTags(row.id),
    messageCount: messageCount ?? countMessages(row.id),
    config: { ...EMPTY_THREAD_CONFIG, ...parseJson<Partial<ThreadConfig>>(row.config, {}) }
  }
}

function toMessage(
  row: MessageRow,
  usage: Usage | null = null,
  attachments: Attachment[] = []
): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as Role,
    content: row.content,
    reasoning: row.reasoning,
    createdAt: row.created_at,
    model: row.model,
    provider: row.provider,
    status: row.status as Message['status'],
    error: row.error,
    toolCalls: parseJson(row.tool_calls, null),
    toolResult: parseJson(row.tool_result, null),
    systemPromptSnapshot: parseJson(row.system_prompt_snapshot, null),
    isCompactionSummary: row.is_compaction_summary === 1,
    compactedInto: row.compacted_into,
    usage,
    attachments
  }
}

function toUsage(row: UsageRow): Usage {
  return {
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    reasoningTokens: row.reasoning_tokens,
    cachedTokens: row.cached_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms,
    timeToFirstTokenMs: row.ttft_ms,
    tokensPerSecond: row.tokens_per_second,
    generationId: row.generation_id
  }
}

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

/** Longest a tag may be. Past this it is a sentence, not a label. */
export const MAX_TAG_LENGTH = 32

/**
 * The single place a tag name is cleaned up.
 *
 * Tags arrive from two directions — typed by the user, or written by a model
 * asked for JSON — and both produce leading hashes, stray quotes, odd spacing
 * and inconsistent case. Normalising here is what makes "Rust ", "#rust" and
 * "RUST" the same tag rather than three.
 */
export function normalizeTagName(raw: string): string {
  return raw
    .normalize('NFC')
    // Control characters and newlines become spaces, and collapse below.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^[#\s"'`]+|[\s"'`,.]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .slice(0, MAX_TAG_LENGTH)
    .trim()
}

/** The tag row for this name, creating it the first time it is used. */
function ensureTag(name: string): { id: string; name: string } | null {
  const clean = normalizeTagName(name)
  if (!clean) return null

  const db = getDb()
  const existing = db
    .prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE')
    .get(clean) as { id: string; name: string } | undefined
  if (existing) return existing

  const id = randomUUID()
  db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(id, clean, Date.now())
  return { id, name: clean }
}

/** Every tag in use, with how many threads carry it and how it is flagged. */
export function listTags(): TagSummary[] {
  return (
    getDb()
      .prepare(
        `SELECT t.name        AS name,
                t.manual_only AS manual_only,
                t.pinned      AS pinned,
                COUNT(tt.thread_id) AS threads
           FROM tags t
           LEFT JOIN thread_tags tt ON tt.tag_id = t.id
          GROUP BY t.id
          ORDER BY threads DESC, t.name`
      )
      .all() as { name: string; threads: number; manual_only: number; pinned: number }[]
  ).map((row) => ({
    name: row.name,
    threads: row.threads,
    manualOnly: row.manual_only === 1,
    pinned: row.pinned === 1
  }))
}

/**
 * Sets the flags on a tag.
 *
 * `manualOnly` takes it out of the model's reach entirely — it will neither be
 * suggested nor withdrawn, which is what makes a tag mean exactly what the
 * person applying it meant. `pinned` floats its folder to the top of the tag
 * view, and is deliberately unrelated to a pinned thread.
 */
export function setTagFlags(
  name: string,
  flags: { manualOnly?: boolean; pinned?: boolean }
): void {
  const clean = normalizeTagName(name)
  if (!clean) return

  const db = getDb()
  if (flags.manualOnly !== undefined) {
    db.prepare('UPDATE tags SET manual_only = ? WHERE name = ? COLLATE NOCASE').run(
      flags.manualOnly ? 1 : 0,
      clean
    )
  }
  if (flags.pinned !== undefined) {
    db.prepare('UPDATE tags SET pinned = ? WHERE name = ? COLLATE NOCASE').run(
      flags.pinned ? 1 : 0,
      clean
    )
  }
}

export function getThreadTags(threadId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT t.name AS name
           FROM thread_tags tt
           JOIN tags t ON t.id = tt.tag_id
          WHERE tt.thread_id = ?
          ORDER BY t.name`
      )
      .all(threadId) as { name: string }[]
  ).map((row) => row.name)
}

/** Which tag came from where, so a model never undoes a choice the user made. */
export function getThreadTagSources(threadId: string): Record<string, TagSource> {
  const rows = getDb()
    .prepare(
      `SELECT t.name AS name, tt.source AS source
         FROM thread_tags tt
         JOIN tags t ON t.id = tt.tag_id
        WHERE tt.thread_id = ?`
    )
    .all(threadId) as { name: string; source: string }[]
  return Object.fromEntries(rows.map((row) => [row.name, row.source as TagSource]))
}

/** Tags for many threads at once, so a list does not run a query per row. */
function tagsForThreads(threadIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (!threadIds.length) return map

  const placeholders = threadIds.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT tt.thread_id AS thread_id, t.name AS name
         FROM thread_tags tt
         JOIN tags t ON t.id = tt.tag_id
        WHERE tt.thread_id IN (${placeholders})
        ORDER BY t.name`
    )
    .all(...threadIds) as { thread_id: string; name: string }[]

  for (const row of rows) {
    const list = map.get(row.thread_id) ?? []
    list.push(row.name)
    map.set(row.thread_id, list)
  }
  return map
}

/**
 * Puts a tag on a thread. Returns the stored name, or null if what was given
 * normalises to nothing.
 *
 * A tag the user adds by hand is recorded as theirs even if a model put it
 * there first, because that is what protects it from being taken off again.
 */
export function addThreadTag(
  threadId: string,
  name: string,
  source: TagSource = 'user'
): string | null {
  const tag = ensureTag(name)
  if (!tag) return null

  getDb()
    .prepare(
      `INSERT INTO thread_tags (thread_id, tag_id, source, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id, tag_id) DO UPDATE SET
         source = CASE WHEN excluded.source = 'user' THEN 'user' ELSE thread_tags.source END`
    )
    .run(threadId, tag.id, source, Date.now())
  return tag.name
}

export function removeThreadTag(threadId: string, name: string): void {
  const clean = normalizeTagName(name)
  if (!clean) return
  getDb()
    .prepare(
      `DELETE FROM thread_tags
        WHERE thread_id = ?
          AND tag_id IN (SELECT id FROM tags WHERE name = ? COLLATE NOCASE)`
    )
    .run(threadId, clean)
}

/** Removes a tag from every thread and from the library. */
export function deleteTag(name: string): void {
  const clean = normalizeTagName(name)
  if (!clean) return
  getDb().prepare('DELETE FROM tags WHERE name = ? COLLATE NOCASE').run(clean)
}

/**
 * Empties the tag library: every tag, off every thread. The threads and their
 * messages are untouched — `thread_tags` goes with the tags by cascade.
 * Returns how many tags were removed, so the UI can say what it did.
 */
export function deleteAllTags(): number {
  return getDb().prepare('DELETE FROM tags').run().changes
}

/**
 * Renames a tag everywhere it is used. Renaming onto a name that already
 * exists merges the two, which is the only sensible reading of the request.
 */
export function renameTag(from: string, to: string): string | null {
  const source = normalizeTagName(from)
  const target = normalizeTagName(to)
  if (!source || !target || source === target) return null

  const db = getDb()
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(source) as
      | { id: string }
      | undefined
    if (!existing) return null

    const collision = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(target) as
      | { id: string }
      | undefined

    if (!collision) {
      db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(target, existing.id)
      return target
    }

    // Merge: move every thread across, then drop the now-empty tag.
    db.prepare(
      `INSERT OR IGNORE INTO thread_tags (thread_id, tag_id, source, created_at)
       SELECT thread_id, ?, source, created_at FROM thread_tags WHERE tag_id = ?`
    ).run(collision.id, existing.id)
    db.prepare('DELETE FROM tags WHERE id = ?').run(existing.id)
    return target
  })()
}

/**
 * Threads carrying no tags at all, and having something to tag — what the
 * "tag everything untagged" pass works through. Newest first, so a long run
 * reaches what the user was most recently doing before it reaches 2019.
 */
export function listUntaggedThreadIds(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT t.id AS id
           FROM threads t
          WHERE NOT EXISTS (SELECT 1 FROM thread_tags tt WHERE tt.thread_id = t.id)
            AND EXISTS (
                  SELECT 1 FROM messages m
                   WHERE m.thread_id = t.id
                     AND m.role IN ('user', 'assistant')
                     AND m.content <> ''
                     AND m.compacted_into IS NULL
                )
          ORDER BY t.pinned DESC, t.updated_at DESC`
      )
      .all() as { id: string }[]
  ).map((row) => row.id)
}

/**
 * Title and transcript size of every untagged thread, in one query.
 *
 * The estimate has to price hundreds of threads while someone watches the
 * dialog, and assembling each request in turn would read every message of
 * every one of them. A tagging request only ever carries the last few
 * messages, each truncated — so measure exactly that, in SQLite, and hand back
 * character counts for the caller to turn into tokens.
 */
export function untaggedThreadSizes(
  recentMessages: number,
  charsPerMessage: number
): { id: string; title: string; chars: number }[] {
  return getDb()
    .prepare(
      `WITH untagged AS (
         SELECT t.id AS id, t.title AS title
           FROM threads t
          WHERE NOT EXISTS (SELECT 1 FROM thread_tags tt WHERE tt.thread_id = t.id)
       ),
       recent AS (
         SELECT m.thread_id AS thread_id,
                m.role      AS role,
                m.content   AS content,
                ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.seq DESC) AS rn
           FROM messages m
           JOIN untagged u ON u.id = m.thread_id
          WHERE m.role IN ('user', 'assistant')
            AND m.content <> ''
            AND m.compacted_into IS NULL
       )
       SELECT u.id    AS id,
              u.title AS title,
              -- Each line costs its text (capped as the request caps it), plus
              -- the "ROLE: " label and the blank line between messages.
              COALESCE(SUM(MIN(LENGTH(r.content), ?) + LENGTH(r.role) + 4), 0) AS chars
         FROM untagged u
         LEFT JOIN recent r ON r.thread_id = u.id AND r.rn <= ?
        GROUP BY u.id
       HAVING chars > 0
        ORDER BY u.title`
    )
    .all(charsPerMessage, recentMessages) as { id: string; title: string; chars: number }[]
}

/**
 * Trims a thread back to `max` tags, dropping what a model added before what
 * the user did, and the oldest of those first.
 */
export function enforceTagLimit(threadId: string, max: number): void {
  const db = getDb()
  db.prepare(
    `DELETE FROM thread_tags
      WHERE thread_id = ?
        AND tag_id IN (
          SELECT tag_id FROM thread_tags
           WHERE thread_id = ?
           ORDER BY CASE source WHEN 'user' THEN 1 ELSE 0 END, created_at
           LIMIT MAX((SELECT COUNT(*) FROM thread_tags WHERE thread_id = ?) - ?, 0)
        )`
  ).run(threadId, threadId, threadId, Math.max(max, 0))
}

/* ------------------------------------------------------------------ *
 * Threads
 * ------------------------------------------------------------------ */

/**
 * What the sidebar means by "how long is this conversation": exactly what
 * `getMessages` would hand the transcript. A compacted-away message has been
 * replaced by its summary and is no longer there to read, and the naming and
 * tagging markers were never messages at all — both carry a `compacted_into`,
 * which is what this one condition covers.
 *
 * Deliberately not the same question as the statistics panel's message count,
 * which is about everything the thread has ever contained.
 */
const VISIBLE_MESSAGES = 'compacted_into IS NULL'

function countMessages(threadId: string): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND (${VISIBLE_MESSAGES})`
      )
      .get(threadId) as { n: number }
  ).n
}

/** The same count for every thread at once, for the list. */
function countMessagesByThread(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT thread_id AS id, COUNT(*) AS n FROM messages
        WHERE ${VISIBLE_MESSAGES}
        GROUP BY thread_id`
    )
    .all() as { id: string; n: number }[]
  return new Map(rows.map((row) => [row.id, row.n]))
}

export function createThread(title = '', config: Partial<ThreadConfig> = {}): Thread {
  const now = Date.now()
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO threads (id, title, created_at, updated_at, config)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, title, now, now, JSON.stringify({ ...EMPTY_THREAD_CONFIG, ...config }))
  return getThread(id)!
}

export function getThread(id: string): Thread | null {
  const row = getDb().prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined
  return row ? toThread(row) : null
}

export function listThreads(includeArchived = false): Thread[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM threads
       WHERE (? = 1 OR archived = 0)
       ORDER BY pinned DESC, updated_at DESC`
    )
    .all(includeArchived ? 1 : 0) as ThreadRow[]

  const tags = tagsForThreads(rows.map((row) => row.id))
  const counts = countMessagesByThread()
  return rows.map((row) => toThread(row, tags.get(row.id) ?? [], counts.get(row.id) ?? 0))
}

export function updateThread(
  id: string,
  patch: Partial<Pick<Thread, 'title' | 'pinned' | 'archived'>> & { config?: Partial<ThreadConfig> }
): Thread | null {
  const existing = getThread(id)
  if (!existing) return null

  const config = patch.config ? { ...existing.config, ...patch.config } : existing.config

  getDb()
    .prepare(
      `UPDATE threads
          SET title = ?, pinned = ?, archived = ?, config = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(
      patch.title ?? existing.title,
      (patch.pinned ?? existing.pinned) ? 1 : 0,
      (patch.archived ?? existing.archived) ? 1 : 0,
      JSON.stringify(config),
      Date.now(),
      id
    )
  return getThread(id)
}

export function touchThread(id: string): void {
  getDb().prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}

export function deleteThread(id: string): void {
  getDb().prepare('DELETE FROM threads WHERE id = ?').run(id)
}

/** Copies a thread and its messages up to and including `throughMessageId`. */
export function branchThread(threadId: string, throughMessageId: string): Thread | null {
  const source = getThread(threadId)
  if (!source) return null

  const db = getDb()
  const pivot = db.prepare('SELECT seq FROM messages WHERE id = ?').get(throughMessageId) as
    | { seq: number }
    | undefined
  if (!pivot) return null

  const clone = createThread(source.title ? `${source.title} (branch)` : '', source.config)
  const rows = db
    .prepare('SELECT * FROM messages WHERE thread_id = ? AND seq <= ? ORDER BY seq')
    .all(threadId, pivot.seq) as MessageRow[]

  const insert = db.prepare(
    `INSERT INTO messages (id, thread_id, seq, role, content, reasoning, created_at, model,
                           provider, status, error, tool_calls, tool_result,
                           system_prompt_snapshot, is_compaction_summary, compacted_into)
     VALUES (@id, @thread_id, @seq, @role, @content, @reasoning, @created_at, @model,
             @provider, @status, @error, @tool_calls, @tool_result,
             @system_prompt_snapshot, @is_compaction_summary, @compacted_into)`
  )

  db.transaction(() => {
    for (const row of rows) {
      insert.run({ ...row, id: randomUUID(), thread_id: clone.id })
    }
    // A branch is about the same subject, so it starts with the same tags.
    db.prepare(
      `INSERT OR IGNORE INTO thread_tags (thread_id, tag_id, source, created_at)
       SELECT ?, tag_id, source, created_at FROM thread_tags WHERE thread_id = ?`
    ).run(clone.id, threadId)
  })()

  return getThread(clone.id)
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

function nextSeq(threadId: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(seq), -1) AS max FROM messages WHERE thread_id = ?')
    .get(threadId) as { max: number }
  return row.max + 1
}

export function insertMessage(
  input: Partial<Message> & Pick<Message, 'threadId' | 'role'>
): Message {
  const id = input.id ?? randomUUID()
  getDb()
    .prepare(
      `INSERT INTO messages (id, thread_id, seq, role, content, reasoning, created_at, model,
                             provider, status, error, tool_calls, tool_result,
                             system_prompt_snapshot, is_compaction_summary, compacted_into)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.threadId,
      nextSeq(input.threadId),
      input.role,
      input.content ?? '',
      input.reasoning ?? null,
      input.createdAt ?? Date.now(),
      input.model ?? null,
      input.provider ?? null,
      input.status ?? 'complete',
      input.error ?? null,
      jsonOrNull(input.toolCalls),
      jsonOrNull(input.toolResult),
      jsonOrNull(input.systemPromptSnapshot),
      input.isCompactionSummary ? 1 : 0,
      input.compactedInto ?? null
    )
  touchThread(input.threadId)
  return getMessage(id)!
}

export function updateMessage(id: string, patch: Partial<Message>): Message | null {
  const existing = getMessage(id)
  if (!existing) return null

  getDb()
    .prepare(
      `UPDATE messages
          SET content = ?, reasoning = ?, model = ?, provider = ?, status = ?, error = ?,
              tool_calls = ?, tool_result = ?, system_prompt_snapshot = ?,
              is_compaction_summary = ?, compacted_into = ?
        WHERE id = ?`
    )
    .run(
      patch.content ?? existing.content,
      patch.reasoning !== undefined ? patch.reasoning : existing.reasoning,
      patch.model !== undefined ? patch.model : existing.model,
      patch.provider !== undefined ? patch.provider : existing.provider,
      patch.status ?? existing.status,
      patch.error !== undefined ? patch.error : existing.error,
      jsonOrNull(patch.toolCalls !== undefined ? patch.toolCalls : existing.toolCalls),
      jsonOrNull(patch.toolResult !== undefined ? patch.toolResult : existing.toolResult),
      jsonOrNull(
        patch.systemPromptSnapshot !== undefined
          ? patch.systemPromptSnapshot
          : existing.systemPromptSnapshot
      ),
      (patch.isCompactionSummary ?? existing.isCompactionSummary) ? 1 : 0,
      patch.compactedInto !== undefined ? patch.compactedInto : existing.compactedInto,
      id
    )
  return getMessage(id)
}

export function getMessage(id: string): Message | null {
  const row = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | MessageRow
    | undefined
  if (!row) return null
  const usageRow = getDb().prepare('SELECT * FROM usage WHERE message_id = ?').get(id) as
    | UsageRow
    | undefined
  return toMessage(row, usageRow ? toUsage(usageRow) : null, attachments.forMessage(id))
}

/**
 * Messages for display. Compacted-away messages are excluded but never deleted —
 * `includeCompacted` brings them back for the "show original context" view.
 */
export function getMessages(threadId: string, includeCompacted = false): Message[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM messages
        WHERE thread_id = ? AND (? = 1 OR compacted_into IS NULL)
        ORDER BY seq`
    )
    .all(threadId, includeCompacted ? 1 : 0) as MessageRow[]

  const usageRows = db.prepare('SELECT * FROM usage WHERE thread_id = ?').all(threadId) as (
    UsageRow & { thread_id: string }
  )[]
  const usageByMessage = new Map(usageRows.map((u) => [u.message_id, toUsage(u)]))

  const attachmentsByMessage = attachments.forThread(threadId)

  return rows.map((row) =>
    toMessage(row, usageByMessage.get(row.id) ?? null, attachmentsByMessage.get(row.id) ?? [])
  )
}

export function deleteMessage(id: string): void {
  getDb().prepare('DELETE FROM messages WHERE id = ?').run(id)
}

/** Removes every message after `messageId` — used when regenerating or editing. */
export function deleteMessagesAfter(threadId: string, messageId: string): void {
  const db = getDb()
  const pivot = db.prepare('SELECT seq FROM messages WHERE id = ?').get(messageId) as
    | { seq: number }
    | undefined
  if (!pivot) return
  db.prepare('DELETE FROM messages WHERE thread_id = ? AND seq > ?').run(threadId, pivot.seq)
}

/**
 * Inserts a message immediately before `beforeSeq`, shifting everything at or
 * after it along. Compaction summaries must land where the messages they
 * replace were, not at the end of the thread.
 */
export function insertMessageBefore(
  beforeSeq: number,
  input: Partial<Message> & Pick<Message, 'threadId' | 'role'>
): Message {
  const db = getDb()
  return db.transaction(() => {
    db.prepare('UPDATE messages SET seq = seq + 1 WHERE thread_id = ? AND seq >= ?').run(
      input.threadId,
      beforeSeq
    )
    const message = insertMessage(input)
    db.prepare('UPDATE messages SET seq = ? WHERE id = ?').run(beforeSeq, message.id)
    return getMessage(message.id)!
  })()
}

export function seqOf(messageId: string): number | null {
  const row = getDb().prepare('SELECT seq FROM messages WHERE id = ?').get(messageId) as
    | { seq: number }
    | undefined
  return row?.seq ?? null
}

export function markCompacted(messageIds: string[], summaryMessageId: string): void {
  const stmt = getDb().prepare('UPDATE messages SET compacted_into = ? WHERE id = ?')
  getDb().transaction(() => {
    for (const id of messageIds) stmt.run(summaryMessageId, id)
  })()
}

/**
 * Tidies up turns that were interrupted rather than finished — the app being
 * quit or killed mid-request, most often.
 *
 * An assistant row is written before the request goes out, so an interrupted
 * turn leaves a row marked `streaming` that nothing will ever complete. The
 * transcript then shows an empty bubble with a blinking caret forever. Nothing
 * can still be streaming at startup, so anything that claims to be is not.
 */
export function reconcileInterruptedMessages(): { removed: number; settled: number } {
  const db = getDb()

  return db.transaction(() => {
    // A turn that produced nothing at all is not worth keeping.
    const removed = db
      .prepare(
        `DELETE FROM messages
          WHERE role = 'assistant'
            AND status <> 'complete'
            AND content = ''
            AND (reasoning IS NULL OR reasoning = '')
            AND tool_calls IS NULL`
      )
      .run().changes

    // Anything that did produce output keeps it, but stops claiming to be live.
    const settled = db
      .prepare(`UPDATE messages SET status = 'aborted' WHERE status = 'streaming'`)
      .run().changes

    return { removed, settled }
  })()
}

/* ------------------------------------------------------------------ *
 * Usage & tool invocations
 * ------------------------------------------------------------------ */

export function recordUsage(
  threadId: string,
  messageId: string,
  model: string | null,
  provider: string | null,
  usage: Usage
): void {
  getDb()
    .prepare(
      `INSERT INTO usage (message_id, thread_id, model, provider, prompt_tokens, completion_tokens,
                          reasoning_tokens, cached_tokens, total_tokens, cost_usd, latency_ms,
                          ttft_ms, tokens_per_second, generation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET
         prompt_tokens = excluded.prompt_tokens,
         completion_tokens = excluded.completion_tokens,
         reasoning_tokens = excluded.reasoning_tokens,
         cached_tokens = excluded.cached_tokens,
         total_tokens = excluded.total_tokens,
         cost_usd = excluded.cost_usd,
         latency_ms = excluded.latency_ms,
         ttft_ms = excluded.ttft_ms,
         tokens_per_second = excluded.tokens_per_second,
         generation_id = excluded.generation_id`
    )
    .run(
      messageId,
      threadId,
      model,
      provider,
      usage.promptTokens,
      usage.completionTokens,
      usage.reasoningTokens,
      usage.cachedTokens,
      usage.totalTokens,
      usage.costUsd,
      usage.latencyMs,
      usage.timeToFirstTokenMs,
      usage.tokensPerSecond,
      usage.generationId,
      Date.now()
    )
}

export function recordToolInvocation(input: {
  threadId: string
  messageId: string
  source: 'mcp' | 'web' | 'repo'
  serverId: string | null
  toolName: string
  isError: boolean
  durationMs: number
  /** Characters returned to the model, which is what it costs in context. */
  resultChars?: number
}): void {
  getDb()
    .prepare(
      `INSERT INTO tool_invocations (id, thread_id, message_id, source, server_id, tool_name,
                                     is_error, duration_ms, created_at, result_chars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      input.threadId,
      input.messageId,
      input.source,
      input.serverId,
      input.toolName,
      input.isError ? 1 : 0,
      input.durationMs,
      Date.now(),
      input.resultChars ?? 0
    )
}

/* ------------------------------------------------------------------ *
 * Statistics
 * ------------------------------------------------------------------ */

interface ToolRollupRow {
  source: string
  calls: number
  chars: number
  ms: number
}

/** Tool cost by source. Characters are what actually entered the context, so
 *  they convert to a token estimate the same way everything else does. */
function toolRollup(rows: ToolRollupRow[]): ToolUsageRollup[] {
  return rows.map((row) => ({
    source: row.source,
    calls: row.calls,
    chars: row.chars,
    estimatedTokens: Math.ceil(row.chars / 4),
    totalMs: row.ms
  }))
}

const ROLLUP_SELECT = `
  SELECT model,
         MIN(provider)          AS provider,
         COUNT(*)               AS requests,
         SUM(prompt_tokens)     AS prompt_tokens,
         SUM(completion_tokens) AS completion_tokens,
         SUM(total_tokens)      AS total_tokens,
         SUM(cost_usd)          AS cost_usd
    FROM usage`

interface RollupRow {
  model: string | null
  provider: string | null
  requests: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_usd: number
}

function toRollup(row: RollupRow): ModelUsageRollup {
  return {
    model: row.model ?? 'unknown',
    provider: row.provider,
    requests: row.requests,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd
  }
}

export function getThreadStats(threadId: string, contextLimit: number | null): ThreadStats {
  const db = getDb()

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(reasoning_tokens), 0)  AS reasoning_tokens,
              COALESCE(SUM(cached_tokens), 0)     AS cached_tokens,
              COALESCE(SUM(total_tokens), 0)      AS total_tokens,
              COALESCE(SUM(cost_usd), 0)          AS cost_usd,
              AVG(tokens_per_second)              AS avg_tps,
              AVG(ttft_ms)                        AS avg_ttft
         FROM usage WHERE thread_id = ?`
    )
    .get(threadId) as {
    prompt_tokens: number
    completion_tokens: number
    reasoning_tokens: number
    cached_tokens: number
    total_tokens: number
    cost_usd: number
    avg_tps: number | null
    avg_ttft: number | null
  }

  // Naming and tagging markers exist only to carry their cost; they are not
  // messages anyone sent or saw.
  const messageCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
          WHERE thread_id = ?
            AND (compacted_into IS NULL OR compacted_into NOT IN ('title', 'tags'))`
      )
      .get(threadId) as { n: number }
  ).n

  const toolCallCount = (
    db.prepare('SELECT COUNT(*) AS n FROM tool_invocations WHERE thread_id = ?').get(threadId) as {
      n: number
    }
  ).n

  const toolUsage = toolRollup(
    db
      .prepare(
        `SELECT source, COUNT(*) AS calls, COALESCE(SUM(result_chars), 0) AS chars,
                COALESCE(SUM(duration_ms), 0) AS ms
           FROM tool_invocations WHERE thread_id = ? GROUP BY source ORDER BY chars DESC`
      )
      .all(threadId) as ToolRollupRow[]
  )

  // The live context is whatever the most recent request actually sent plus the
  // reply it produced — that is what will be re-sent on the next turn.
  const last = db
    .prepare(
      `SELECT prompt_tokens, completion_tokens
         FROM usage WHERE thread_id = ?
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(threadId) as { prompt_tokens: number; completion_tokens: number } | undefined

  const byModel = (
    db
      .prepare(`${ROLLUP_SELECT} WHERE thread_id = ? GROUP BY model ORDER BY total_tokens DESC`)
      .all(threadId) as RollupRow[]
  ).map(toRollup)

  return {
    threadId,
    messageCount,
    promptTokens: totals.prompt_tokens,
    completionTokens: totals.completion_tokens,
    reasoningTokens: totals.reasoning_tokens,
    cachedTokens: totals.cached_tokens,
    totalTokens: totals.total_tokens,
    costUsd: totals.cost_usd,
    contextTokens: last ? last.prompt_tokens + last.completion_tokens : 0,
    contextLimit,
    avgTokensPerSecond: totals.avg_tps,
    avgTimeToFirstTokenMs: totals.avg_ttft,
    toolCallCount,
    toolUsage,
    byModel
  }
}

export function getGlobalStats(): GlobalStats {
  const db = getDb()

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(reasoning_tokens), 0)  AS reasoning_tokens,
              COALESCE(SUM(cached_tokens), 0)     AS cached_tokens,
              COALESCE(SUM(total_tokens), 0)      AS total_tokens,
              COALESCE(SUM(cost_usd), 0)          AS cost_usd,
              MIN(created_at)                     AS first_used
         FROM usage`
    )
    .get() as {
    prompt_tokens: number
    completion_tokens: number
    reasoning_tokens: number
    cached_tokens: number
    total_tokens: number
    cost_usd: number
    first_used: number | null
  }

  const threadCount = (db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n
  const messageCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
          WHERE compacted_into IS NULL OR compacted_into NOT IN ('title', 'tags')`
      )
      .get() as { n: number }
  ).n
  const toolCallCount = (
    db.prepare('SELECT COUNT(*) AS n FROM tool_invocations').get() as { n: number }
  ).n

  const toolUsage = toolRollup(
    db
      .prepare(
        `SELECT source, COUNT(*) AS calls, COALESCE(SUM(result_chars), 0) AS chars,
                COALESCE(SUM(duration_ms), 0) AS ms
           FROM tool_invocations GROUP BY source ORDER BY chars DESC`
      )
      .all() as ToolRollupRow[]
  )

  const byModel = (
    db.prepare(`${ROLLUP_SELECT} GROUP BY model ORDER BY cost_usd DESC`).all() as RollupRow[]
  ).map(toRollup)

  const byProvider = (
    db
      .prepare(
        `SELECT provider              AS model,
                provider              AS provider,
                COUNT(*)              AS requests,
                SUM(prompt_tokens)    AS prompt_tokens,
                SUM(completion_tokens) AS completion_tokens,
                SUM(total_tokens)     AS total_tokens,
                SUM(cost_usd)         AS cost_usd
           FROM usage
          WHERE provider IS NOT NULL
          GROUP BY provider
          ORDER BY cost_usd DESC`
      )
      .all() as RollupRow[]
  ).map(toRollup)

  const byDay = (
    db
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day,
                SUM(total_tokens)                                 AS total_tokens,
                SUM(cost_usd)                                     AS cost_usd,
                COUNT(*)                                          AS requests
           FROM usage
          GROUP BY day
          ORDER BY day DESC
          LIMIT 90`
      )
      .all() as { day: string; total_tokens: number; cost_usd: number; requests: number }[]
  ).map(
    (r): DailyUsage => ({
      day: r.day,
      totalTokens: r.total_tokens,
      costUsd: r.cost_usd,
      requests: r.requests
    })
  )

  return {
    threadCount,
    messageCount,
    promptTokens: totals.prompt_tokens,
    completionTokens: totals.completion_tokens,
    reasoningTokens: totals.reasoning_tokens,
    cachedTokens: totals.cached_tokens,
    totalTokens: totals.total_tokens,
    costUsd: totals.cost_usd,
    firstUsedAt: totals.first_used,
    toolCallCount,
    toolUsage,
    byModel,
    byProvider,
    byDay
  }
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

// Private-use sentinels: FTS5 wraps matches in these, and they cannot occur
// in real message text, so escaping afterwards is unambiguous.
const MARK_OPEN = '\uE000'
const MARK_CLOSE = '\uE001'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Snippets are rendered as HTML so matches can be highlighted. Message bodies
 * are arbitrary text, so escape everything first and only then turn the private
 * sentinels FTS5 inserted into real <mark> tags.
 */
function toSafeSnippet(raw: string): string {
  return escapeHtml(raw)
    .split(MARK_OPEN)
    .join('<mark>')
    .split(MARK_CLOSE)
    .join('</mark>')
}

/** Turns free text into a safe FTS5 prefix query. */
function toFtsQuery(input: string): string {
  const terms = input
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, '').trim())
    .filter(Boolean)
  if (!terms.length) return ''
  return terms.map((t) => `"${t}"*`).join(' AND ')
}

/** Escapes the wildcards LIKE would otherwise read as syntax. */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export interface ParsedSearchQuery {
  /** `tag:rust` and `#rust` both narrow the search to threads tagged rust. */
  tags: string[]
  /** Whatever was left after the tag terms were taken out. */
  text: string
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const tags: string[] = []
  const rest: string[] = []

  for (const token of input.split(/\s+/).filter(Boolean)) {
    const match = /^(?:tag:|#)(.+)$/i.exec(token)
    if (!match) {
      rest.push(token)
      continue
    }
    const name = normalizeTagName(match[1])
    if (name) tags.push(name)
  }

  return { tags, text: rest.join(' ').trim() }
}

/** Threads carrying a tag that starts with `prefix`. */
function threadsTagged(prefix: string): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT tt.thread_id AS id
         FROM thread_tags tt
         JOIN tags t ON t.id = tt.tag_id
        WHERE t.name LIKE ? ESCAPE '\\' COLLATE NOCASE`
    )
    .all(`${likeEscape(prefix)}%`) as { id: string }[]
  return new Set(rows.map((row) => row.id))
}

export function search(query: string, limit = 50): SearchHit[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const db = getDb()
  const { tags: tagTerms, text } = parseSearchQuery(trimmed)

  // Every `tag:` term narrows further, so a thread must carry all of them.
  const tagged = tagTerms.map(threadsTagged)
  const scope: Set<string> | null = tagged.length
    ? new Set([...tagged[0]].filter((id) => tagged.every((set) => set.has(id))))
    : null
  if (scope && !scope.size) return []

  const inScope = (threadId: string): boolean => !scope || scope.has(threadId)
  const hits: SearchHit[] = []
  const threadLevel = new Set<string>()

  const threadHit = (
    row: { id: string; title: string; updated_at: number },
    kind: 'title' | 'tag',
    snippet: string,
    score: number
  ): void => {
    threadLevel.add(row.id)
    hits.push({
      threadId: row.id,
      threadTitle: row.title,
      messageId: null,
      role: null,
      snippet,
      createdAt: row.updated_at,
      score,
      kind,
      tags: []
    })
  }

  // A bare `tag:` query is a filter rather than a search: every thread wearing
  // the tag is a result, whether or not anything else matched.
  if (scope && !text) {
    const rows = db
      .prepare(
        `SELECT id, title, updated_at FROM threads
          ORDER BY pinned DESC, updated_at DESC`
      )
      .all() as { id: string; title: string; updated_at: number }[]

    for (const row of rows.filter((r) => scope!.has(r.id)).slice(0, limit)) {
      threadHit(row, 'tag', escapeHtml(row.title), 900)
    }
    return withTags(hits)
  }

  // Thread titles first — they are the fastest thing to match and the most
  // likely thing a user is jumping to.
  const titleRows = db
    .prepare(
      `SELECT id, title, updated_at FROM threads
        WHERE title LIKE ? COLLATE NOCASE
        ORDER BY pinned DESC, updated_at DESC LIMIT ?`
    )
    .all(`%${text}%`, limit) as { id: string; title: string; updated_at: number }[]

  for (const row of titleRows) {
    if (inScope(row.id)) threadHit(row, 'title', escapeHtml(row.title), 1000)
  }

  // Then tags. A tag is a name someone chose for a whole conversation, so a
  // match on one ranks above any single message inside it.
  const tagRows = db
    .prepare(
      `SELECT th.id AS id, th.title AS title, th.updated_at AS updated_at, t.name AS name
         FROM thread_tags tt
         JOIN tags    t  ON t.id = tt.tag_id
         JOIN threads th ON th.id = tt.thread_id
        WHERE t.name LIKE ? ESCAPE '\\' COLLATE NOCASE
        ORDER BY th.pinned DESC, th.updated_at DESC
        LIMIT ?`
    )
    .all(`%${likeEscape(text)}%`, limit) as {
    id: string
    title: string
    updated_at: number
    name: string
  }[]

  for (const row of tagRows) {
    if (!inScope(row.id) || threadLevel.has(row.id)) continue
    threadHit(row, 'tag', markMatch(row.name, text), 900)
  }

  const ftsQuery = toFtsQuery(text)
  if (ftsQuery) {
    const rows = db
      .prepare(
        `SELECT m.id           AS message_id,
                m.thread_id    AS thread_id,
                m.role         AS role,
                m.created_at   AS created_at,
                t.title        AS thread_title,
                snippet(messages_fts, 0, ?, ?, '…', 12) AS snippet,
                bm25(messages_fts) AS score
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
           JOIN threads  t ON t.id = m.thread_id
          WHERE messages_fts MATCH ?
          ORDER BY score
          LIMIT ?`
      )
      .all(MARK_OPEN, MARK_CLOSE, ftsQuery, limit) as {
      message_id: string
      thread_id: string
      role: string
      created_at: number
      thread_title: string
      snippet: string
      score: number
    }[]

    for (const row of rows) {
      if (!inScope(row.thread_id)) continue
      hits.push({
        threadId: row.thread_id,
        threadTitle: row.thread_title,
        messageId: row.message_id,
        role: row.role as Role,
        snippet: toSafeSnippet(row.snippet),
        createdAt: row.created_at,
        // bm25 returns lower-is-better; flip it so callers can sort descending.
        score: -row.score,
        kind: 'message',
        tags: []
      })
    }
  }

  return withTags(hits.slice(0, limit))
}

/** Highlights `needle` inside a tag name, the way FTS5 does for message text. */
function markMatch(name: string, needle: string): string {
  const at = needle ? name.toLowerCase().indexOf(needle.toLowerCase()) : -1
  if (at < 0) return escapeHtml(name)
  return (
    escapeHtml(name.slice(0, at)) +
    '<mark>' +
    escapeHtml(name.slice(at, at + needle.length)) +
    '</mark>' +
    escapeHtml(name.slice(at + needle.length))
  )
}

/** Hangs each hit's thread tags off it, so results can show them anywhere. */
function withTags(hits: SearchHit[]): SearchHit[] {
  const byThread = tagsForThreads([...new Set(hits.map((hit) => hit.threadId))])
  return hits.map((hit) => ({ ...hit, tags: byThread.get(hit.threadId) ?? [] }))
}

/* ------------------------------------------------------------------ *
 * Key/value settings
 * ------------------------------------------------------------------ */

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? parseJson<T>(row.value, fallback) : fallback
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    )
    .run(key, JSON.stringify(value))
}

/* ------------------------------------------------------------------ *
 * MCP servers
 * ------------------------------------------------------------------ */

export function listMcpServers(): McpServerConfig[] {
  const rows = getDb().prepare('SELECT config FROM mcp_servers ORDER BY created_at').all() as {
    config: string
  }[]
  return rows
    .map((r) => parseJson<McpServerConfig | null>(r.config, null))
    .filter((c): c is McpServerConfig => c !== null)
}

export function upsertMcpServer(config: McpServerConfig): McpServerConfig {
  getDb()
    .prepare(
      `INSERT INTO mcp_servers (id, config, created_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET config = excluded.config`
    )
    .run(config.id, JSON.stringify(config), Date.now())
  return config
}

export function deleteMcpServer(id: string): void {
  getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
}

/* ------------------------------------------------------------------ *
 * Model catalogue cache (so the app works offline between refreshes)
 * ------------------------------------------------------------------ */

export function getCache<T>(key: string, maxAgeMs: number): T | null {
  const row = getDb().prepare('SELECT payload, fetched_at FROM model_cache WHERE id = ?').get(key) as
    | { payload: string; fetched_at: number }
    | undefined
  if (!row) return null
  if (Date.now() - row.fetched_at > maxAgeMs) return null
  return parseJson<T | null>(row.payload, null)
}

export function setCache(key: string, payload: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO model_cache (id, payload, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
    )
    .run(key, JSON.stringify(payload), Date.now())
}

/* ------------------------------------------------------------------ *
 * Data management
 * ------------------------------------------------------------------ */

export function wipeAllData(): void {
  const db = getDb()
  db.transaction(() => {
    db.exec('DELETE FROM tool_invocations')
    db.exec('DELETE FROM usage')
    db.exec('DELETE FROM messages')
    db.exec('DELETE FROM threads')
    // thread_tags goes with the threads; the tag library goes with it.
    db.exec('DELETE FROM thread_tags')
    db.exec('DELETE FROM tags')
  })()
  db.exec('VACUUM')
}
