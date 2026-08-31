import { existsSync, writeFileSync } from 'node:fs'
import type { SyncDirection, SyncScopes } from '@shared/types'
import * as attachments from '../attachments'
import { getDb } from '../db/index'

/**
 * The database as a set of records, and back again.
 *
 * Sync moves rows, not tables: every syncable row is a record with a kind, an
 * id and a revision, and the revision is the only thing that decides which of
 * two copies is the newer. Nothing here knows about encryption or S3 — this
 * file is the boundary between "what this machine has" and "what is being
 * exchanged", and it is the part that has to be exactly right about identity,
 * because a mistake here does not fail, it duplicates or overwrites.
 */

export type RecordKind = 'thread' | 'message' | 'folder' | 'attachment' | 'setting' | 'mcp'

/** The two halves of the library a person can choose between. */
export type ScopeName = 'conversations' | 'settings'

export const KINDS_BY_SCOPE: Record<ScopeName, RecordKind[]> = {
  conversations: ['thread', 'message', 'folder', 'attachment'],
  settings: ['setting', 'mcp']
}

/** The row itself, as it travels. */
export interface SyncRecord {
  kind: RecordKind
  id: string
  /** When this version was made, in local milliseconds. Higher wins. */
  rev: number
  data: Record<string, unknown>
}

/** What this machine holds, by kind and id, without reading any of the bodies. */
export interface LocalRevisions {
  records: Map<string, number>
  deletions: Map<string, number>
}

export function logicalKey(kind: RecordKind, id: string): string {
  return `${kind}:${id}`
}

/**
 * The kinds a scope covers, when it is on and travelling the way asked about.
 *
 * `any` is "everything this machine is willing to exchange at all", which is
 * what deciding whether there is anything to do is about; `push` and `pull`
 * are the two halves of a run, and a scope set to one direction takes no part
 * in the other.
 */
export function kindsFor(scopes: SyncScopes, way: 'any' | 'push' | 'pull' = 'any'): RecordKind[] {
  const travels = (direction: SyncDirection): boolean =>
    way === 'any' || direction === 'two-way' || direction === way

  return [
    ...(scopes.conversations && travels(scopes.conversationsDirection)
      ? KINDS_BY_SCOPE.conversations
      : []),
    ...(scopes.settings && travels(scopes.settingsDirection) ? KINDS_BY_SCOPE.settings : [])
  ]
}

/**
 * The one key that is never synced.
 *
 * The OpenRouter key lives in its own file under the OS keyring and has never
 * been in the database, so there is nothing to exclude here — but the sync
 * settings themselves are stored beside the app's, and those are per machine:
 * the bucket a laptop syncs to, and the key it does it with, are not things to
 * copy onto every device automatically.
 */
const UNSYNCED_SETTINGS = new Set(['sync'])

/* ------------------------------------------------------------------ *
 * What is here
 * ------------------------------------------------------------------ */

const REVISION_QUERIES: Record<RecordKind, string> = {
  thread: 'SELECT id, MAX(updated_at, filed_at) AS rev FROM threads',
  message: 'SELECT id, updated_at AS rev FROM messages',
  folder: 'SELECT id, updated_at AS rev FROM folders',
  attachment: 'SELECT id, updated_at AS rev FROM attachments',
  setting: "SELECT key AS id, updated_at AS rev FROM settings WHERE key = 'settings'",
  mcp: 'SELECT id, updated_at AS rev FROM mcp_servers'
}

export function localRevisions(kinds: RecordKind[]): LocalRevisions {
  const db = getDb()
  const records = new Map<string, number>()

  for (const kind of kinds) {
    const rows = db.prepare(REVISION_QUERIES[kind]).all() as { id: string; rev: number }[]
    for (const row of rows) records.set(logicalKey(kind, row.id), row.rev)
  }

  const deletions = new Map<string, number>()
  const wanted = new Set<string>(kinds)
  const rows = db.prepare('SELECT kind, id, deleted_at FROM sync_deletions').all() as {
    kind: string
    id: string
    deleted_at: number
  }[]
  for (const row of rows) {
    if (!wanted.has(row.kind)) continue
    deletions.set(logicalKey(row.kind as RecordKind, row.id), row.deleted_at)
  }

  return { records, deletions }
}

/** Reads one record out of the database, ready to be sealed and sent. */
export function readRecord(kind: RecordKind, id: string): SyncRecord | null {
  const db = getDb()

  switch (kind) {
    case 'thread': {
      const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined
      // The later of "last edited" and "last filed": moving a conversation into
      // a folder does not stamp it as edited, and would otherwise never travel.
      if (!row) return null
      const rev = Math.max(Number(row['updated_at']), Number(row['filed_at'] ?? 0))
      return { kind, id, rev, data: row }
    }
    case 'message': {
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined
      if (!row) return null
      // Usage rides with its message: it is one fact about one turn, and a
      // reply that arrived without what it cost would quietly corrupt the
      // statistics on the machine that received it.
      const usage = db.prepare('SELECT * FROM usage WHERE message_id = ?').get(id) ?? null
      const tools = db.prepare('SELECT * FROM tool_invocations WHERE message_id = ?').all(id)
      return { kind, id, rev: Number(row['updated_at']), data: { ...row, usage, tools } }
    }
    case 'folder': {
      const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined
      return row ? { kind, id, rev: Number(row['updated_at']), data: row } : null
    }
    case 'attachment': {
      const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined
      if (!row) return null
      const file = attachments.readBase64(id)
      // The row without its file is not worth sending: the other machine would
      // draw a broken picture and have no way to ask for the missing half.
      if (!file) return null
      return { kind, id, rev: Number(row['updated_at']), data: { ...row, file } }
    }
    case 'setting': {
      if (UNSYNCED_SETTINGS.has(id)) return null
      const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(id) as
        | Record<string, unknown>
        | undefined
      return row ? { kind, id, rev: Number(row['updated_at']), data: row } : null
    }
    case 'mcp': {
      const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined
      return row ? { kind, id, rev: Number(row['updated_at']), data: row } : null
    }
  }
}

/* ------------------------------------------------------------------ *
 * Taking one in
 * ------------------------------------------------------------------ */

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function int(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

/**
 * Writes a record from somewhere else into this database.
 *
 * Every column is taken from the record rather than defaulted, `updated_at`
 * included: writing "now" instead of the revision that arrived would make the
 * row look newer than the copy it came from, and the two machines would push it
 * back and forth forever.
 */
export function applyRecord(record: SyncRecord): void {
  const db = getDb()
  const row = record.data

  switch (record.kind) {
    case 'thread':
      db.prepare(
        `INSERT INTO threads (id, title, created_at, updated_at, filed_at, pinned, archived, config,
                              source, source_id, folder_id)
         VALUES (@id, @title, @created_at, @updated_at, @filed_at, @pinned, @archived, @config,
                 @source, @source_id, @folder_id)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title, created_at = excluded.created_at,
           updated_at = excluded.updated_at, filed_at = excluded.filed_at,
           pinned = excluded.pinned,
           archived = excluded.archived, config = excluded.config,
           source = excluded.source, source_id = excluded.source_id,
           folder_id = excluded.folder_id`
      ).run({
        id: record.id,
        title: text(row['title']) ?? '',
        created_at: int(row['created_at']),
        // Both halves of the revision are taken as they were written, so this
        // copy computes the same revision the machine that sent it did and the
        // two do not hand the row back and forth. Neither may exceed the
        // revision the manifest names, which is the one both sides agreed on.
        updated_at: Math.min(int(row['updated_at'], record.rev), record.rev),
        filed_at: Math.min(int(row['filed_at']), record.rev),
        pinned: int(row['pinned']),
        archived: int(row['archived']),
        config: text(row['config']) ?? '{}',
        source: text(row['source']),
        source_id: text(row['source_id']),
        // A folder that has not arrived yet would fail the foreign key, so the
        // thread lands loose and is filed by a later pass.
        folder_id: folderExists(text(row['folder_id'])) ? text(row['folder_id']) : null
      })
      break

    case 'message': {
      if (!threadExists(text(row['thread_id']))) return
      db.prepare(
        `INSERT INTO messages (id, thread_id, seq, role, content, reasoning, created_at, updated_at,
                               model, provider, status, error, tool_calls, tool_result,
                               system_prompt_snapshot, is_compaction_summary, compacted_into)
         VALUES (@id, @thread_id, @seq, @role, @content, @reasoning, @created_at, @updated_at,
                 @model, @provider, @status, @error, @tool_calls, @tool_result,
                 @system_prompt_snapshot, @is_compaction_summary, @compacted_into)
         ON CONFLICT (id) DO UPDATE SET
           seq = excluded.seq, role = excluded.role, content = excluded.content,
           reasoning = excluded.reasoning, created_at = excluded.created_at,
           updated_at = excluded.updated_at, model = excluded.model,
           provider = excluded.provider, status = excluded.status, error = excluded.error,
           tool_calls = excluded.tool_calls, tool_result = excluded.tool_result,
           system_prompt_snapshot = excluded.system_prompt_snapshot,
           is_compaction_summary = excluded.is_compaction_summary,
           compacted_into = excluded.compacted_into`
      ).run({
        id: record.id,
        thread_id: text(row['thread_id']),
        seq: int(row['seq']),
        role: text(row['role']) ?? 'user',
        content: text(row['content']) ?? '',
        reasoning: text(row['reasoning']),
        created_at: int(row['created_at']),
        updated_at: record.rev,
        model: text(row['model']),
        provider: text(row['provider']),
        status: text(row['status']) ?? 'complete',
        error: text(row['error']),
        tool_calls: text(row['tool_calls']),
        tool_result: text(row['tool_result']),
        system_prompt_snapshot: text(row['system_prompt_snapshot']),
        is_compaction_summary: int(row['is_compaction_summary']),
        compacted_into: text(row['compacted_into'])
      })

      applyUsage(record.id, row['usage'])
      applyToolInvocations(record.id, row['tools'])
      break
    }

    case 'folder':
      db.prepare(
        `INSERT INTO folders (id, name, created_at, updated_at, pinned)
         VALUES (@id, @name, @created_at, @updated_at, @pinned)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, created_at = excluded.created_at,
           updated_at = excluded.updated_at, pinned = excluded.pinned`
      ).run({
        id: record.id,
        name: text(row['name']) ?? 'Folder',
        created_at: int(row['created_at']),
        updated_at: record.rev,
        pinned: int(row['pinned'])
      })
      break

    case 'attachment': {
      if (!messageExists(text(row['message_id']))) return
      // The picture itself rides in the record. Attachments are written once
      // and never edited, so there is no churn to save by storing the bytes
      // separately — and one object means a picture can never arrive without
      // the row that says what it is, or the other way round.
      const encoded = text(row['file'])
      const file = encoded ? Buffer.from(encoded, 'base64') : null
      if (!file) return

      db.prepare(
        `INSERT INTO attachments (id, message_id, thread_id, mime, filename, bytes, width, height,
                                  created_at, updated_at, preview)
         VALUES (@id, @message_id, @thread_id, @mime, @filename, @bytes, @width, @height,
                 @created_at, @updated_at, @preview)
         ON CONFLICT (id) DO UPDATE SET
           mime = excluded.mime, filename = excluded.filename, bytes = excluded.bytes,
           width = excluded.width, height = excluded.height, updated_at = excluded.updated_at,
           preview = excluded.preview`
      ).run({
        id: record.id,
        message_id: text(row['message_id']),
        thread_id: text(row['thread_id']),
        mime: text(row['mime']) ?? 'application/octet-stream',
        filename: text(row['filename']) ?? '',
        bytes: file.length,
        width: row['width'] === null ? null : int(row['width']),
        height: row['height'] === null ? null : int(row['height']),
        created_at: int(row['created_at']),
        updated_at: record.rev,
        preview: text(row['preview'])
      })

      writeAttachmentFile(record.id, file)
      break
    }

    case 'setting':
      if (UNSYNCED_SETTINGS.has(record.id)) return
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @updated_at)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run({
        key: record.id,
        value: keepingMachineSettings(record.id, text(row['value']) ?? '{}'),
        updated_at: record.rev
      })
      break

    case 'mcp':
      db.prepare(
        `INSERT INTO mcp_servers (id, config, created_at, updated_at)
         VALUES (@id, @config, @created_at, @updated_at)
         ON CONFLICT (id) DO UPDATE SET
           config = excluded.config, updated_at = excluded.updated_at`
      ).run({
        id: record.id,
        config: text(row['config']) ?? '{}',
        created_at: int(row['created_at']),
        updated_at: record.rev
      })
      break
  }
}

/**
 * Settings that describe this machine rather than a preference.
 *
 * Settings travel as one row, which is what makes "last write wins" honest for
 * them — but the window's zoom level is not an opinion, it is a fact about the
 * screen in front of you, and a 27-inch desktop should not be able to shrink a
 * laptop's window by having been used more recently.
 */
const MACHINE_SETTINGS = ['ui.zoomLevel']

function keepingMachineSettings(key: string, incoming: string): string {
  if (key !== 'settings') return incoming

  const mine = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (!mine) return incoming

  try {
    const local = JSON.parse(mine.value) as Record<string, unknown>
    const next = JSON.parse(incoming) as Record<string, unknown>

    for (const path of MACHINE_SETTINGS) {
      const [group, name] = path.split('.')
      const held = (local[group] as Record<string, unknown> | undefined)?.[name]
      const merged = { ...(next[group] as Record<string, unknown> | undefined) }
      // Nothing set here means this machine has never said: leave it unsaid,
      // so its own default applies rather than another machine's answer.
      if (held === undefined) delete merged[name]
      else merged[name] = held
      next[group] = merged
    }
    return JSON.stringify(next)
  } catch {
    // Not JSON either side: take what arrived rather than lose the update.
    return incoming
  }
}

function applyUsage(messageId: string, value: unknown): void {
  if (!value || typeof value !== 'object') return
  const row = value as Record<string, unknown>
  getDb()
    .prepare(
      `INSERT INTO usage (message_id, thread_id, model, provider, prompt_tokens, completion_tokens,
                          reasoning_tokens, cached_tokens, total_tokens, cost_usd, latency_ms,
                          ttft_ms, tokens_per_second, generation_id, created_at)
       VALUES (@message_id, @thread_id, @model, @provider, @prompt_tokens, @completion_tokens,
               @reasoning_tokens, @cached_tokens, @total_tokens, @cost_usd, @latency_ms,
               @ttft_ms, @tokens_per_second, @generation_id, @created_at)
       ON CONFLICT (message_id) DO UPDATE SET
         prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens,
         reasoning_tokens = excluded.reasoning_tokens, cached_tokens = excluded.cached_tokens,
         total_tokens = excluded.total_tokens, cost_usd = excluded.cost_usd,
         latency_ms = excluded.latency_ms, ttft_ms = excluded.ttft_ms,
         tokens_per_second = excluded.tokens_per_second, generation_id = excluded.generation_id`
    )
    .run({
      message_id: messageId,
      thread_id: text(row['thread_id']),
      model: text(row['model']),
      provider: text(row['provider']),
      prompt_tokens: int(row['prompt_tokens']),
      completion_tokens: int(row['completion_tokens']),
      reasoning_tokens: int(row['reasoning_tokens']),
      cached_tokens: int(row['cached_tokens']),
      total_tokens: int(row['total_tokens']),
      cost_usd: typeof row['cost_usd'] === 'number' ? row['cost_usd'] : 0,
      latency_ms: int(row['latency_ms']),
      ttft_ms: row['ttft_ms'] === null ? null : int(row['ttft_ms']),
      tokens_per_second:
        typeof row['tokens_per_second'] === 'number' ? row['tokens_per_second'] : null,
      generation_id: text(row['generation_id']),
      created_at: int(row['created_at'])
    })
}

function applyToolInvocations(messageId: string, value: unknown): void {
  if (!Array.isArray(value)) return
  const db = getDb()
  // Replaced wholesale: they belong to the message and arrive with it, so the
  // set that came is the set there should be.
  db.prepare('DELETE FROM tool_invocations WHERE message_id = ?').run(messageId)

  const insert = db.prepare(
    `INSERT OR REPLACE INTO tool_invocations
       (id, thread_id, message_id, source, server_id, tool_name, is_error, duration_ms,
        created_at, result_chars)
     VALUES (@id, @thread_id, @message_id, @source, @server_id, @tool_name, @is_error,
             @duration_ms, @created_at, @result_chars)`
  )

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    insert.run({
      id: text(row['id']) ?? `${messageId}-${int(row['created_at'])}`,
      thread_id: text(row['thread_id']),
      message_id: messageId,
      source: text(row['source']) ?? 'mcp',
      server_id: text(row['server_id']),
      tool_name: text(row['tool_name']) ?? '',
      is_error: int(row['is_error']),
      duration_ms: int(row['duration_ms']),
      created_at: int(row['created_at']),
      result_chars: int(row['result_chars'])
    })
  }
}

function writeAttachmentFile(id: string, bytes: Buffer): void {
  const path = attachments.pathFor(id)
  if (!path || existsSync(path)) return
  writeFileSync(path, bytes, { mode: 0o600 })
}

function folderExists(id: string | null): boolean {
  if (!id) return false
  return Boolean(getDb().prepare('SELECT 1 FROM folders WHERE id = ?').get(id))
}

function threadExists(id: string | null): boolean {
  if (!id) return false
  return Boolean(getDb().prepare('SELECT 1 FROM threads WHERE id = ?').get(id))
}

function messageExists(id: string | null): boolean {
  if (!id) return false
  return Boolean(getDb().prepare('SELECT 1 FROM messages WHERE id = ?').get(id))
}

/**
 * Applies a deletion that happened somewhere else.
 *
 * The row goes and the trigger records that it went, so this machine will now
 * tell a third one the same thing rather than quietly handing back the copy it
 * still had.
 */
export function applyDeletion(kind: RecordKind, id: string): void {
  const db = getDb()
  switch (kind) {
    case 'thread':
      db.prepare('DELETE FROM threads WHERE id = ?').run(id)
      break
    case 'message':
      db.prepare('DELETE FROM messages WHERE id = ?').run(id)
      break
    case 'folder':
      db.prepare('DELETE FROM folders WHERE id = ?').run(id)
      break
    case 'attachment':
      db.prepare('DELETE FROM attachments WHERE id = ?').run(id)
      break
    case 'mcp':
      db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
      break
    case 'setting':
      // Settings are replaced, never deleted; a tombstone for one would only be
      // a way to lose them.
      break
  }
}

/** Tombstones this old have been everywhere by now, and can stop travelling. */
export function pruneDeletions(olderThanMs: number): number {
  return getDb()
    .prepare('DELETE FROM sync_deletions WHERE deleted_at < ?')
    .run(Date.now() - olderThanMs).changes
}
