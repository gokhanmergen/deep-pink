import type {
  ImportSkipped,
  MessageStatus,
  Role,
  SystemPromptSegment,
  ThreadConfig,
  ToolCall,
  ToolResult,
  Usage
} from '@shared/types'
import { EMPTY_THREAD_CONFIG } from '../db/repo'

/**
 * The format Deep Pink writes when you export a thread to keep it, and the
 * reader that takes it back.
 *
 * A single JSON document: the thread's name, its settings, every message with
 * what answered it and what it cost, and any attachments inline. One file that
 * can be copied to another machine and opened there is worth more than a
 * directory of parts, and JSON means it can be read by something else entirely
 * if this app ever stops existing.
 *
 * Nothing here touches the database or the filesystem, so a file can be
 * validated before anything is written.
 */

export const ARCHIVE_FORMAT = 'deep-pink-thread'

/**
 * Bumped only when a reader of this version could not make sense of a file.
 * Adding a field does not need a bump: unknown fields are ignored and missing
 * ones fall back, so an older file always opens.
 */
export const ARCHIVE_VERSION = 1

export interface ArchivedAttachment {
  filename: string
  mime: string
  width: number | null
  height: number | null
  /** Base64, with no data-URL prefix — the same shape the composer sends. */
  data: string
}

/** A tool call as the statistics counted it, so they survive the trip. */
export interface ArchivedToolInvocation {
  source: string
  serverId: string | null
  toolName: string
  isError: boolean
  durationMs: number
  resultChars: number
  createdAt: number
}

export interface ArchivedMessage {
  /**
   * The id it had in the library it came from. Never reused — a message gets a
   * fresh id on import — but compaction links point at ids, and this is what
   * lets them be re-pointed at the copies.
   */
  id: string
  role: Role
  content: string
  reasoning: string | null
  createdAt: number
  model: string | null
  provider: string | null
  status: MessageStatus
  error: string | null
  toolCalls: ToolCall[] | null
  toolResult: ToolResult | null
  systemPromptSnapshot: SystemPromptSegment[] | null
  isCompactionSummary: boolean
  compactedInto: string | null
  usage: Usage | null
  toolInvocations: ArchivedToolInvocation[]
  attachments: ArchivedAttachment[]
}

export interface ArchivedThread {
  /** Its id where it came from, so re-importing the same file does nothing. */
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  /** By name: a folder id means nothing in someone else's library. */
  folder: string | null
  config: ThreadConfig
  messages: ArchivedMessage[]
}

export interface ThreadArchive {
  format: typeof ARCHIVE_FORMAT
  version: number
  exportedAt: number
  app: { name: string; version: string }
  threads: ArchivedThread[]
}

/** A parsed file, with a count of what could not be read. */
export interface ArchiveReport {
  threads: ArchivedThread[]
  skipped: ImportSkipped
  version: number
  exportedAt: number
  app: { name: string; version: string }
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const ROLES = new Set<Role>(['system', 'user', 'assistant', 'tool'])
const STATUSES = new Set<MessageStatus>(['complete', 'streaming', 'error', 'aborted'])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** True for anything claiming to be one of ours, before it is trusted. */
export function looksLikeArchive(value: unknown): boolean {
  return record(value)?.['format'] === ARCHIVE_FORMAT
}

function toConfig(value: unknown): ThreadConfig {
  const raw = record(value)
  if (!raw) return { ...EMPTY_THREAD_CONFIG }

  const routing = record(raw['providerRouting'])
  return {
    model: strOrNull(raw['model']),
    // Routing is stored whole rather than field by field: it is the provider
    // preference as it was, and half of one would route somewhere nobody asked
    // for. Anything unrecognised inside is ignored by the request builder.
    providerRouting: routing ? (routing as unknown as ThreadConfig['providerRouting']) : null,
    systemPrompt: strOrNull(raw['systemPrompt']),
    temperature: numOrNull(raw['temperature']),
    maxTokens: numOrNull(raw['maxTokens']),
    webAccessEnabled: typeof raw['webAccessEnabled'] === 'boolean' ? raw['webAccessEnabled'] : null,
    enabledMcpServers: Array.isArray(raw['enabledMcpServers'])
      ? stringList(raw['enabledMcpServers'])
      : null,
    repoPaths: stringList(raw['repoPaths']),
    disabledPromptSegments: stringList(raw['disabledPromptSegments'])
  }
}

function toUsage(value: unknown): Usage | null {
  const raw = record(value)
  if (!raw) return null
  return {
    promptTokens: num(raw['promptTokens']),
    completionTokens: num(raw['completionTokens']),
    reasoningTokens: num(raw['reasoningTokens']),
    cachedTokens: num(raw['cachedTokens']),
    totalTokens: num(raw['totalTokens']),
    costUsd: num(raw['costUsd']),
    latencyMs: num(raw['latencyMs']),
    timeToFirstTokenMs: numOrNull(raw['timeToFirstTokenMs']),
    tokensPerSecond: numOrNull(raw['tokensPerSecond']),
    generationId: strOrNull(raw['generationId'])
  }
}

function toToolCalls(value: unknown): ToolCall[] | null {
  if (!Array.isArray(value)) return null
  const calls = value
    .map(record)
    .filter((raw): raw is Record<string, unknown> => raw !== null)
    .map((raw) => ({
      id: str(raw['id']),
      name: str(raw['name']),
      arguments: str(raw['arguments'])
    }))
  return calls.length ? calls : null
}

function toToolResult(value: unknown): ToolResult | null {
  const raw = record(value)
  if (!raw) return null
  return {
    toolCallId: str(raw['toolCallId']),
    name: str(raw['name']),
    content: str(raw['content']),
    isError: bool(raw['isError']),
    durationMs: num(raw['durationMs'])
  }
}

function toSegments(value: unknown): SystemPromptSegment[] | null {
  // Kept verbatim: a snapshot is a record of what was sent, and rewriting it
  // field by field would make it a record of what this build expected.
  return Array.isArray(value) ? (value as SystemPromptSegment[]) : null
}

function toAttachments(value: unknown): ArchivedAttachment[] {
  if (!Array.isArray(value)) return []
  return value
    .map(record)
    .filter((raw): raw is Record<string, unknown> => raw !== null)
    .map((raw) => ({
      filename: str(raw['filename'], 'attachment'),
      mime: str(raw['mime'], 'application/octet-stream'),
      width: numOrNull(raw['width']),
      height: numOrNull(raw['height']),
      data: str(raw['data'])
    }))
    .filter((attachment) => attachment.data.length > 0)
}

function toToolInvocations(value: unknown, fallbackAt: number): ArchivedToolInvocation[] {
  if (!Array.isArray(value)) return []
  return value
    .map(record)
    .filter((raw): raw is Record<string, unknown> => raw !== null)
    .map((raw) => ({
      source: str(raw['source'], 'mcp'),
      serverId: strOrNull(raw['serverId']),
      toolName: str(raw['toolName']),
      isError: bool(raw['isError']),
      durationMs: num(raw['durationMs']),
      resultChars: num(raw['resultChars']),
      createdAt: num(raw['createdAt'], fallbackAt)
    }))
}

function toMessage(value: unknown, index: number, threadAt: number): ArchivedMessage | null {
  const raw = record(value)
  if (!raw) return null

  const role = str(raw['role']) as Role
  if (!ROLES.has(role)) return null

  const status = str(raw['status'], 'complete') as MessageStatus
  const createdAt = num(raw['createdAt'], threadAt)

  return {
    id: str(raw['id'], `imported-${index}`),
    role,
    content: str(raw['content']),
    reasoning: strOrNull(raw['reasoning']),
    createdAt,
    model: strOrNull(raw['model']),
    provider: strOrNull(raw['provider']),
    status: STATUSES.has(status) ? status : 'complete',
    error: strOrNull(raw['error']),
    toolCalls: toToolCalls(raw['toolCalls']),
    toolResult: toToolResult(raw['toolResult']),
    systemPromptSnapshot: toSegments(raw['systemPromptSnapshot']),
    isCompactionSummary: bool(raw['isCompactionSummary']),
    compactedInto: strOrNull(raw['compactedInto']),
    usage: toUsage(raw['usage']),
    toolInvocations: toToolInvocations(raw['toolInvocations'], createdAt),
    attachments: toAttachments(raw['attachments'])
  }
}

/** True for a message with nothing in it at all — no text, no call, no file. */
function isEmpty(message: ArchivedMessage): boolean {
  return (
    !message.content.trim() &&
    !message.reasoning?.trim() &&
    !message.toolCalls &&
    !message.toolResult &&
    message.attachments.length === 0
  )
}

/**
 * Validates a parsed JSON document and returns what can be read from it.
 *
 * Throws only for a file this build cannot honestly read — the wrong format
 * entirely, or one written by a newer version. Everything else is repaired
 * where it can be and counted where it cannot, because refusing a whole export
 * over one damaged message helps nobody.
 */
export function parseArchive(value: unknown): ArchiveReport {
  const root = record(value)
  if (!root || root['format'] !== ARCHIVE_FORMAT) {
    throw new Error('That file is not a Deep Pink thread export.')
  }

  const version = num(root['version'], 1)
  if (version > ARCHIVE_VERSION) {
    throw new Error(
      `That file was written by a newer version of Deep Pink (format ${version}). Update to open it.`
    )
  }

  const skipped: ImportSkipped = {
    hiddenOrSystem: 0,
    toolTraffic: 0,
    empty: 0,
    unreadableConversations: 0
  }

  const app = record(root['app'])
  const threads: ArchivedThread[] = []

  for (const entry of Array.isArray(root['threads']) ? root['threads'] : []) {
    const raw = record(entry)
    if (!raw || !Array.isArray(raw['messages'])) {
      skipped.unreadableConversations++
      continue
    }

    const createdAt = num(raw['createdAt'], Date.now())
    const messages: ArchivedMessage[] = []

    raw['messages'].forEach((entry, index) => {
      const message = toMessage(entry, index, createdAt)
      if (!message) {
        skipped.unreadableConversations++
        return
      }
      if (isEmpty(message)) {
        skipped.empty++
        return
      }
      messages.push(message)
    })

    threads.push({
      id: str(raw['id']) || `imported-${threads.length}`,
      title: str(raw['title']),
      createdAt,
      updatedAt: num(raw['updatedAt'], createdAt),
      pinned: bool(raw['pinned']),
      folder: strOrNull(raw['folder']),
      config: toConfig(raw['config']),
      messages
    })
  }

  return {
    threads,
    skipped,
    version,
    exportedAt: num(root['exportedAt'], Date.now()),
    app: { name: str(app?.['name'], 'Deep Pink'), version: str(app?.['version'], 'unknown') }
  }
}
