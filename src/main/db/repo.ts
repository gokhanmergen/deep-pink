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
  Thread,
  ThreadConfig,
  ThreadStats,
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

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
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
 * Threads
 * ------------------------------------------------------------------ */

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
  return rows.map(toThread)
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
  source: 'mcp' | 'web'
  serverId: string | null
  toolName: string
  isError: boolean
  durationMs: number
}): void {
  getDb()
    .prepare(
      `INSERT INTO tool_invocations (id, thread_id, message_id, source, server_id, tool_name,
                                     is_error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      Date.now()
    )
}

/* ------------------------------------------------------------------ *
 * Statistics
 * ------------------------------------------------------------------ */

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

  // Title-generation markers exist only to carry their cost; they are not
  // messages anyone sent or saw.
  const messageCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
          WHERE thread_id = ? AND (compacted_into IS NULL OR compacted_into <> 'title')`
      )
      .get(threadId) as { n: number }
  ).n

  const toolCallCount = (
    db.prepare('SELECT COUNT(*) AS n FROM tool_invocations WHERE thread_id = ?').get(threadId) as {
      n: number
    }
  ).n

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
          WHERE compacted_into IS NULL OR compacted_into <> 'title'`
      )
      .get() as { n: number }
  ).n
  const toolCallCount = (
    db.prepare('SELECT COUNT(*) AS n FROM tool_invocations').get() as { n: number }
  ).n

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

export function search(query: string, limit = 50): SearchHit[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const db = getDb()
  const hits: SearchHit[] = []

  // Thread titles first — they are the fastest thing to match and the most
  // likely thing a user is jumping to.
  const titleRows = db
    .prepare(
      `SELECT id, title, updated_at FROM threads
        WHERE title LIKE ? COLLATE NOCASE
        ORDER BY pinned DESC, updated_at DESC LIMIT ?`
    )
    .all(`%${trimmed}%`, limit) as { id: string; title: string; updated_at: number }[]

  for (const row of titleRows) {
    hits.push({
      threadId: row.id,
      threadTitle: row.title,
      messageId: null,
      role: null,
      snippet: escapeHtml(row.title),
      createdAt: row.updated_at,
      score: 1000
    })
  }

  const ftsQuery = toFtsQuery(trimmed)
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
      hits.push({
        threadId: row.thread_id,
        threadTitle: row.thread_title,
        messageId: row.message_id,
        role: row.role as Role,
        snippet: toSafeSnippet(row.snippet),
        createdAt: row.created_at,
        // bm25 returns lower-is-better; flip it so callers can sort descending.
        score: -row.score
      })
    }
  }

  return hits.slice(0, limit)
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
  })()
  db.exec('VACUUM')
}
