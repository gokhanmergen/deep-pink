import { randomUUID } from 'node:crypto'
import type {
  Message,
  SendMessageRequest,
  Settings,
  StreamEvent,
  TagBackfillEstimate,
  Thread,
  ToolCall,
  ToolResult
} from '@shared/types'
import * as repo from '../db/repo'
import * as mcp from '../mcp/host'
import { loadSettings } from '../settings'
import {
  OpenRouterError,
  complete,
  listModels,
  streamChat,
  type ChatMessageParam,
  type StreamResult
} from '../providers/openrouter'
import { runWebFetch, runWebSearch } from '../tools/web'
import { REPO_TOOL_NAMES } from '../tools/repo'
import { ensureTree, runRepoOp } from '../tools/repoService'
import * as attachments from '../attachments'
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../attachments'
import { assembleContext, estimateTokens } from './prompt'

export type Emit = (event: StreamEvent) => void

/**
 * Writes a partial reply to disk at most this often. Frequent enough that a
 * crash loses little, rare enough not to churn the full-text index — every
 * content update re-writes that row's FTS entry.
 */
const PROGRESS_INTERVAL_MS = 750
const lastPersisted = new Map<string, number>()

function persistProgress(messageId: string): void {
  const live = liveStreams.get(messageId)
  if (!live) return

  const now = Date.now()
  const previous = lastPersisted.get(messageId) ?? 0
  if (now - previous < PROGRESS_INTERVAL_MS) return

  lastPersisted.set(messageId, now)
  repo.updateMessage(messageId, { content: live.content, reasoning: live.reasoning || null })
}

/** Hard stop so a misbehaving tool loop cannot run forever. */
const MAX_TOOL_ROUNDS = 12

const abortControllers = new Map<string, AbortController>()
const pendingApprovals = new Map<string, (approved: boolean) => void>()

/**
 * Text of replies still arriving, keyed by message id.
 *
 * A streamed reply exists only as deltas until the turn ends, so without this
 * the accumulated text lives nowhere but the window that happened to be showing
 * it. Leaving that thread threw it away, and coming back showed only what
 * arrived after the return. The main process now holds it, so any view can ask
 * for what it missed.
 */
interface LiveStream {
  threadId: string
  messageId: string
  content: string
  reasoning: string
}

const liveStreams = new Map<string, LiveStream>()

/** Partial replies currently arriving in a thread. */
export function liveStreamsFor(threadId: string): LiveStream[] {
  return [...liveStreams.values()].filter((s) => s.threadId === threadId)
}

export function abortThread(threadId: string): void {
  abortControllers.get(threadId)?.abort()
  abortControllers.delete(threadId)
}

export function isGenerating(threadId: string): boolean {
  return abortControllers.has(threadId)
}

export function resolveToolApproval(toolCallId: string, approved: boolean): void {
  const resolve = pendingApprovals.get(toolCallId)
  if (resolve) {
    pendingApprovals.delete(toolCallId)
    resolve(approved)
  }
}

/* ------------------------------------------------------------------ *
 * Message conversion
 * ------------------------------------------------------------------ */

/** Fence language from a filename, so inlined code arrives tagged. */
const FENCE_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish', ps1: 'powershell',
  sql: 'sql', json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', html: 'html', css: 'css', scss: 'scss', md: 'markdown', tex: 'latex',
  lua: 'lua', vim: 'vim', nix: 'nix', dockerfile: 'docker', diff: 'diff', patch: 'diff'
}

function fenceLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return FENCE_LANG[ext] ?? ''
}

/**
 * Renders text attachments into the message body.
 *
 * OpenRouter has no concept of a text file, so a "pasted text" attachment is a
 * composer convenience: by the time it reaches a provider it is just text. It is
 * fenced and labelled so the model can tell it apart from what the user typed.
 */
function inlineTextAttachments(message: Message): string {
  const texts = (message.attachments ?? []).filter((a) => a.kind === 'text')
  if (!texts.length) return message.content

  const blocks = texts.map((attachment) => {
    const body = attachments.readText(attachment.id) ?? ''
    const lines = body ? body.split('\n').length : 0
    // A fence long enough that content containing ``` cannot break out of it.
    const longest = Math.max(0, ...[...body.matchAll(/`{3,}/g)].map((m) => m[0].length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    return [
      `Attached file: ${attachment.filename} (${lines} line${lines === 1 ? '' : 's'})`,
      `${fence}${fenceLanguage(attachment.filename)}`,
      body,
      fence
    ].join('\n')
  })

  return [message.content, ...blocks].filter(Boolean).join('\n\n')
}

export function toChatParams(messages: Message[], allowImages = true): ChatMessageParam[] {
  const params: ChatMessageParam[] = []

  // Providers reject an assistant turn whose tool calls have no results, and a
  // tool result with no matching call. Compaction or a deleted message can
  // leave either dangling, so both sides are reconciled before sending.
  const resultIds = new Set(
    messages.filter((m) => m.role === 'tool' && m.toolResult).map((m) => m.toolResult!.toolCallId)
  )
  const emittedCallIds = new Set<string>()

  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.toolResult) continue
      if (!emittedCallIds.has(message.toolResult.toolCallId)) continue
      params.push({
        role: 'tool',
        tool_call_id: message.toolResult.toolCallId,
        content: message.toolResult.content
      })
      continue
    }

    if (message.role === 'system') {
      params.push({ role: 'system', content: message.content })
      continue
    }

    if (message.role === 'assistant') {
      const answered = (message.toolCalls ?? []).filter((call) => resultIds.has(call.id))
      if (!message.content && !answered.length) continue

      for (const call of answered) emittedCallIds.add(call.id)

      params.push({
        role: 'assistant',
        content: message.content,
        ...(answered.length
          ? {
              tool_calls: answered.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: call.arguments || '{}' }
              }))
            }
          : {})
      })
      continue
    }

    const text = inlineTextAttachments(message)
    const images = (message.attachments ?? []).filter((a) => a.kind === 'image')

    if (!images.length) {
      params.push({ role: 'user', content: text })
      continue
    }

    if (!allowImages) {
      // Sending an image to a text-only model is a hard request error, so say
      // what was dropped rather than silently losing it or failing the turn.
      const note = `[${images.length} image${images.length === 1 ? '' : 's'} omitted — the selected model does not accept images]`
      params.push({ role: 'user', content: text ? `${text}\n\n${note}` : note })
      continue
    }

    params.push({
      role: 'user',
      content: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...images.map((image) => ({
          type: 'image_url' as const,
          image_url: { url: attachments.toDataUrl(image) }
        }))
      ]
    })
  }

  return params
}

/* ------------------------------------------------------------------ *
 * Model metadata
 * ------------------------------------------------------------------ */

export function resolveModel(thread: Thread, settings: Settings): string {
  return thread.config.model ?? settings.defaultModel
}

function resolveRouting(thread: Thread, settings: Settings, model: string) {
  return (
    thread.config.providerRouting ??
    settings.modelProviderRouting[model] ??
    settings.defaultProviderRouting
  )
}

/** Whether the model accepts image input at all. */
export async function modelAcceptsImages(model: string): Promise<boolean> {
  try {
    const models = await listModels()
    const found = models.find((m) => m.id === model)
    // Unknown model: assume it does, and let the provider be the authority.
    return found ? found.inputModalities.includes('image') : true
  } catch {
    return true
  }
}

export async function contextLimitFor(model: string): Promise<number | null> {
  try {
    const models = await listModels()
    return models.find((m) => m.id === model)?.contextLength ?? null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Context compaction
 * ------------------------------------------------------------------ */

function estimateContextTokens(messages: Message[], systemTokens: number): number {
  return (
    systemTokens +
    messages.reduce(
      (sum, m) =>
        sum +
        estimateTokens(m.content) +
        estimateTokens(m.toolResult?.content ?? '') +
        estimateTokens(JSON.stringify(m.toolCalls ?? '')),
      0
    )
  )
}

export async function shouldCompact(
  thread: Thread,
  settings: Settings
): Promise<{ needed: boolean; used: number; limit: number | null }> {
  const model = resolveModel(thread, settings)
  const limit = await contextLimitFor(model)
  const messages = repo.getMessages(thread.id)
  const { estimatedTokens } = assembleContext(thread, settings)

  // Prefer the real prompt token count from the last request when we have one.
  const last = [...messages].reverse().find((m) => m.usage)
  const used = last?.usage
    ? last.usage.promptTokens + last.usage.completionTokens
    : estimateContextTokens(messages, estimatedTokens)

  if (!settings.compaction.enabled || !limit) return { needed: false, used, limit }
  return { needed: used > limit * settings.compaction.triggerRatio, used, limit }
}

export async function compactThread(
  threadId: string,
  emit: Emit
): Promise<{ summaryMessageId: string; freedTokens: number } | null> {
  const settings = loadSettings()
  const thread = repo.getThread(threadId)
  if (!thread) return null

  const messages = repo.getMessages(threadId)
  const keep = Math.max(settings.compaction.keepRecentMessages, 2)
  const older = messages.slice(0, Math.max(messages.length - keep, 0))

  if (older.length < 2) return null

  emit({ type: 'compaction-start', threadId })

  const transcript = older
    .map((m) => {
      if (m.role === 'tool') return `TOOL RESULT (${m.toolResult?.name ?? '?'}):\n${m.content}`
      return `${m.role.toUpperCase()}:\n${m.content}`
    })
    .join('\n\n')

  const model = settings.compaction.model ?? resolveModel(thread, settings)

  const result = await complete({
    model,
    messages: [
      { role: 'system', content: settings.compaction.prompt },
      { role: 'user', content: transcript }
    ],
    temperature: 0.3,
    providerRouting: resolveRouting(thread, settings, model),
    attribution: settings.sendAppAttribution
  })

  // The summary stands in for the messages it replaces, so it has to sit where
  // they were — ahead of the recent messages that were kept verbatim.
  const firstKept = messages[older.length]
  const insertAt = firstKept ? (repo.seqOf(firstKept.id) ?? 0) : 0

  const summary = repo.insertMessageBefore(insertAt, {
    threadId,
    role: 'system',
    content: `Summary of the earlier part of this conversation:\n\n${result.content}`,
    model,
    provider: result.provider,
    isCompactionSummary: true
  })

  repo.markCompacted(
    older.map((m) => m.id),
    summary.id
  )

  if (result.usage.totalTokens) {
    repo.recordUsage(threadId, summary.id, model, result.provider, result.usage)
  }

  const freed =
    older.reduce((sum, m) => sum + estimateTokens(m.content), 0) - estimateTokens(summary.content)

  emit({ type: 'compaction-done', threadId, summaryMessageId: summary.id, freedTokens: freed })
  return { summaryMessageId: summary.id, freedTokens: freed }
}

/* ------------------------------------------------------------------ *
 * Tool execution
 * ------------------------------------------------------------------ */

async function requestApproval(
  messageId: string,
  call: ToolCall,
  serverName: string,
  emit: Emit
): Promise<boolean> {
  emit({ type: 'tool-approval-request', messageId, toolCall: call, serverName })
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(call.id, resolve)
  })
}

async function executeToolCall(
  threadId: string,
  assistantMessageId: string,
  call: ToolCall,
  settings: Settings,
  emit: Emit,
  repoPaths: string[] = []
): Promise<ToolResult> {
  const startedAt = Date.now()

  let args: Record<string, unknown> = {}
  try {
    args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {}
  } catch {
    return {
      toolCallId: call.id,
      name: call.name,
      content: `Could not parse the arguments as JSON: ${call.arguments}`,
      isError: true,
      durationMs: Date.now() - startedAt
    }
  }

  const fail = (
    message: string,
    source: 'web' | 'mcp' | 'repo',
    serverId: string | null
  ): ToolResult => {
    repo.recordToolInvocation({
      threadId,
      messageId: assistantMessageId,
      source,
      serverId,
      toolName: call.name,
      isError: true,
      durationMs: Date.now() - startedAt
    })
    return {
      toolCallId: call.id,
      name: call.name,
      content: message,
      isError: true,
      durationMs: Date.now() - startedAt
    }
  }

  try {
    if (REPO_TOOL_NAMES.has(call.name)) {
      // On a worker thread: a fruitless search reads every file, and doing that
      // here would stall streaming and the window with it.
      const content = await runRepoOp(
        call.name.replace('repo_', '') as 'tree' | 'read' | 'search' | 'find',
        repoPaths,
        args
      )

      repo.recordToolInvocation({
        threadId,
        messageId: assistantMessageId,
        source: 'repo',
        serverId: null,
        toolName: call.name,
        isError: false,
        durationMs: Date.now() - startedAt,
        resultChars: content.length
      })
      return {
        toolCallId: call.id,
        name: call.name,
        content,
        isError: false,
        durationMs: Date.now() - startedAt
      }
    }

    if (call.name === 'web_search' || call.name === 'web_fetch') {
      const content =
        call.name === 'web_search'
          ? await runWebSearch(args as { query?: string; max_results?: number }, settings.web)
          : await runWebFetch(args as { url?: string; max_chars?: number }, settings.web)

      repo.recordToolInvocation({
        threadId,
        messageId: assistantMessageId,
        source: 'web',
        serverId: null,
        toolName: call.name,
        isError: false,
        durationMs: Date.now() - startedAt,
        resultChars: content.length
      })
      return {
        toolCallId: call.id,
        name: call.name,
        content,
        isError: false,
        durationMs: Date.now() - startedAt
      }
    }

    if (mcp.toolRequiresApproval(call.name)) {
      const serverName = mcp.serverNameForTool(call.name) ?? 'an MCP server'
      const approved = await requestApproval(assistantMessageId, call, serverName, emit)
      if (!approved) {
        return fail('The user declined this tool call.', 'mcp', null)
      }
    }

    const result = await mcp.callTool(call.name, args)
    repo.recordToolInvocation({
      threadId,
      messageId: assistantMessageId,
      source: 'mcp',
      serverId: result.serverId,
      toolName: result.toolName,
      isError: result.isError,
      durationMs: Date.now() - startedAt,
      resultChars: result.content.length
    })
    return {
      toolCallId: call.id,
      name: call.name,
      content: result.content,
      isError: result.isError,
      durationMs: Date.now() - startedAt
    }
  } catch (err) {
    return fail(
      `Tool failed: ${err instanceof Error ? err.message : String(err)}`,
      REPO_TOOL_NAMES.has(call.name) ? 'repo' : call.name.startsWith('web_') ? 'web' : 'mcp',
      null
    )
  }
}

/* ------------------------------------------------------------------ *
 * Thread titles
 * ------------------------------------------------------------------ */

export async function generateTitle(threadId: string, emit: Emit): Promise<string | null> {
  const settings = loadSettings()
  if (!settings.titleGenerationEnabled) return null

  const thread = repo.getThread(threadId)
  if (!thread) return null

  const messages = repo.getMessages(threadId).filter((m) => m.role === 'user' || m.role === 'assistant')
  if (!messages.length) return null

  const transcript = messages
    .slice(0, 4)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}`)
    .join('\n\n')

  try {
    const result = await complete({
      model: settings.titleModel,
      messages: [
        { role: 'system', content: settings.titlePrompt },
        { role: 'user', content: transcript }
      ],
      temperature: 0.4,
      maxTokens: 24,
      providerRouting: settings.modelProviderRouting[settings.titleModel] ?? null,
      attribution: settings.sendAppAttribution
    })

    const title = result.content
      .trim()
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/[.!?]+$/, '')
      .slice(0, 80)

    if (!title) return null

    repo.updateThread(threadId, { title })
    if (result.usage.totalTokens) {
      // Title generation costs money too; it belongs in the statistics.
      const marker = repo.insertMessage({
        threadId,
        role: 'system',
        content: '',
        model: settings.titleModel,
        compactedInto: 'title'
      })
      repo.recordUsage(threadId, marker.id, settings.titleModel, result.provider, result.usage)
    }

    emit({ type: 'title', threadId, title })
    return title
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Thread tags
 * ------------------------------------------------------------------ */

/** Messages the tagging model is shown, and how much of each. */
const TAG_CONTEXT_MESSAGES = 10
const TAG_CONTEXT_CHARS = 900
/** How much of the library to offer as vocabulary, most-used first. */
const TAG_VOCABULARY = 60

export interface TagEdit {
  add: string[]
  remove: string[]
}

/**
 * Reads the model's answer.
 *
 * Models wrap JSON in prose or a fenced block however firmly they are asked not
 * to, so take the outermost braces rather than trusting the whole reply to
 * parse. Anything unreadable means "change nothing", which is the safe reading:
 * a bad reply must never strip a thread's tags.
 */
export function parseTagEdit(raw: string): TagEdit {
  const empty: TagEdit = { add: [], remove: [] }

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return empty

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return empty
  }

  if (!parsed || typeof parsed !== 'object') return empty
  const record = parsed as Record<string, unknown>

  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

  return { add: list(record.add), remove: list(record.remove) }
}

/**
 * Assembles what would be sent for one thread, or null when there is nothing
 * to tag. Shared by the tagging pass and by the estimate the UI prices, so the
 * figure quoted before a run is arithmetic on the real requests.
 */
function buildTagRequest(
  thread: Thread,
  settings: Settings
): { system: string; brief: string } | null {
  const messages = repo
    .getMessages(thread.id)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
  if (!messages.length) return null

  const transcript = messages
    .slice(-TAG_CONTEXT_MESSAGES)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, TAG_CONTEXT_CHARS)}`)
    .join('\n\n')

  const brief = [
    ...tagBriefPreamble(thread.tags, settings),
    thread.title ? `Conversation name: ${thread.title}` : '',
    '',
    'Conversation:',
    transcript
  ]
    .filter(Boolean)
    .join('\n')

  return { system: settings.tagging.prompt, brief }
}

/**
 * Everything in the brief above the transcript. Its own function so the
 * estimate can measure the same words the request will carry, rather than a
 * copy of them that drifts the moment either is edited.
 */
function tagBriefPreamble(current: string[], settings: Settings): string[] {
  // Manual-only tags are left out entirely: offering a tag the model is not
  // allowed to use spends tokens inviting a suggestion that will be thrown away.
  const library = repo
    .listTags()
    .filter((tag) => !tag.manualOnly)
    .slice(0, TAG_VOCABULARY)
    .map((tag) => tag.name)

  return [
    current.length
      ? `Tags on this conversation: ${current.join(', ')}`
      : 'This conversation has no tags yet.',
    library.length ? `Tags already in use elsewhere: ${library.join(', ')}` : 'No tags exist yet.',
    settings.tagging.allowNewTags
      ? `You may create a tag that does not exist yet when nothing in the list fits. At most ${settings.tagging.maxTagsPerThread} tags in total.`
      : 'You may only use tags from the list above. Do not invent new ones.'
  ]
}

/**
 * Asks the tagging model what this thread should be tagged with, and applies
 * the answer. Runs after every turn, because what a conversation is about is
 * not settled by its first exchange.
 *
 * Tags the user added by hand are never removed here — the model's job is to
 * keep its own suggestions current, not to overrule a person.
 *
 * `force` is for tagging the user asked for outright — a re-tag, or the
 * backfill. The setting governs whether tagging happens *by itself*; it was
 * never meant to refuse a button someone just pressed.
 */
export async function updateTags(
  threadId: string,
  emit: Emit,
  force = false
): Promise<string[] | null> {
  const settings = loadSettings()
  if (!settings.tagging.enabled && !force) return null

  const thread = repo.getThread(threadId)
  if (!thread) return null

  const request = buildTagRequest(thread, settings)
  if (!request) return null
  const current = thread.tags

  try {
    const result = await complete({
      model: settings.tagging.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.brief }
      ],
      temperature: 0.2,
      maxTokens: 200,
      providerRouting: settings.modelProviderRouting[settings.tagging.model] ?? null,
      attribution: settings.sendAppAttribution
    })

    const edit = parseTagEdit(result.content)
    const sources = repo.getThreadTagSources(threadId)
    const library = repo.listTags()
    const known = new Set(library.filter((tag) => !tag.manualOnly).map((tag) => tag.name))
    const manualOnly = new Set(library.filter((tag) => tag.manualOnly).map((tag) => tag.name))

    for (const raw of edit.remove) {
      const name = repo.normalizeTagName(raw)
      // The user's own tags are theirs; the model may only retire its own. A
      // manual-only tag is out of reach even if the model put it there before
      // it was marked — that mark means "this one is mine".
      if (!name || sources[name] !== 'model' || manualOnly.has(name)) continue
      repo.removeThreadTag(threadId, name)
    }

    for (const raw of edit.add) {
      const name = repo.normalizeTagName(raw)
      if (!name || manualOnly.has(name)) continue
      if (!settings.tagging.allowNewTags && !known.has(name)) continue
      repo.addThreadTag(threadId, name, 'model')
    }

    repo.enforceTagLimit(threadId, settings.tagging.maxTagsPerThread)

    const tags = repo.getThreadTags(threadId)

    if (result.usage.totalTokens) {
      // Tagging costs money on every turn; it belongs in the statistics.
      const marker = repo.insertMessage({
        threadId,
        role: 'system',
        content: '',
        model: settings.tagging.model,
        compactedInto: 'tags'
      })
      repo.recordUsage(threadId, marker.id, settings.tagging.model, result.provider, result.usage)
    }

    // Only say so when something moved, so an unchanged thread costs no
    // repaint. Joined on a character a tag cannot contain, since one that
    // contains a space would otherwise compare equal to two that do not.
    if (tags.join('\u0000') !== current.join('\u0000')) {
      emit({ type: 'tags', threadId, tags })
    }
    return tags
  } catch {
    // Tagging is a convenience. A failure must not disturb the conversation.
    return null
  }
}

/**
 * What a tagging reply costs in output tokens.
 *
 * The request caps output at 200, but a reply is two short JSON arrays, so
 * budgeting for the cap would overstate the price several times over. This is
 * what one actually comes back as, rounded up.
 */
const TAG_REPLY_TOKENS = 45

/** What tagging every untagged thread would send, priced by the renderer. */
export function estimateTagBackfill(): TagBackfillEstimate {
  const settings = loadSettings()
  const sizes = repo.untaggedThreadSizes(TAG_CONTEXT_MESSAGES, TAG_CONTEXT_CHARS)

  // An untagged thread has no tags by definition, so the preamble is the same
  // for every one of them and is measured once.
  const perRequest =
    estimateTokens(settings.tagging.prompt) +
    estimateTokens(tagBriefPreamble([], settings).join('\n')) +
    estimateTokens('\nConversation:\n')

  const promptTokens = sizes.reduce(
    (sum, row) =>
      sum +
      perRequest +
      estimateTokens(row.title ? `Conversation name: ${row.title}` : '') +
      Math.ceil(row.chars / 4),
    0
  )

  return {
    model: settings.tagging.model,
    threads: sizes.length,
    promptTokens,
    completionTokens: sizes.length * TAG_REPLY_TOKENS
  }
}

/**
 * The backfill runs one thread at a time so a slow provider cannot turn a
 * library-wide pass into hundreds of simultaneous requests, and so stopping it
 * takes effect on the next thread rather than after all of them.
 */
let backfillRunning = false
let backfillCancelled = false

export function stopTagBackfill(): void {
  if (backfillRunning) backfillCancelled = true
}

export function isTagBackfillRunning(): boolean {
  return backfillRunning
}

/** Tags every thread that carries no tags yet, reporting progress as it goes. */
export async function tagAllUntagged(emit: Emit): Promise<{ tagged: number; total: number }> {
  if (backfillRunning) return { tagged: 0, total: 0 }

  backfillRunning = true
  backfillCancelled = false

  const ids = repo.listUntaggedThreadIds()
  let done = 0
  let tagged = 0

  emit({ type: 'tag-progress', done: 0, total: ids.length, threadId: null, finished: false })

  try {
    for (const id of ids) {
      if (backfillCancelled) break

      emit({ type: 'tag-progress', done, total: ids.length, threadId: id, finished: false })
      const tags = await updateTags(id, emit, true)
      if (tags?.length) tagged++
      done++
    }
  } finally {
    backfillRunning = false
    backfillCancelled = false
    emit({ type: 'tag-progress', done, total: ids.length, threadId: null, finished: true })
  }

  return { tagged, total: ids.length }
}

/* ------------------------------------------------------------------ *
 * The turn
 * ------------------------------------------------------------------ */

export async function sendMessage(req: SendMessageRequest, emit: Emit): Promise<void> {
  const settings = loadSettings()
  let thread = repo.getThread(req.threadId)
  if (!thread) throw new Error(`Unknown thread: ${req.threadId}`)

  const controller = new AbortController()
  abortControllers.set(thread.id, controller)

  try {
    if (req.regenerateFromMessageId) {
      repo.deleteMessagesAfter(thread.id, req.regenerateFromMessageId)
    } else if (req.content.trim() || req.attachments?.length) {
      const userMessage = repo.insertMessage({
        threadId: thread.id,
        role: 'user',
        content: req.content
      })
      for (const pending of (req.attachments ?? []).slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
        try {
          attachments.store(thread.id, userMessage.id, pending)
        } catch (err) {
          // One bad image must not lose the message the user just wrote.
          emit({
            type: 'error',
            messageId: userMessage.id,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }

    // Compact before building the request, so the turn goes out at the smaller size.
    if (settings.compaction.enabled && !settings.compaction.requireConfirmation) {
      const check = await shouldCompact(thread, settings)
      if (check.needed) await compactThread(thread.id, emit)
    }

    const isFirstExchange = repo.getMessages(thread.id).filter((m) => m.role === 'user').length === 1

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      thread = repo.getThread(thread.id)!
      const model = resolveModel(thread, settings)

      // Read the layout before assembling, so the prompt carries it. Cached
      // between turns, so this is usually free.
      if (thread.config.repoPaths?.length) await ensureTree(thread.config.repoPaths)

      const context = assembleContext(thread, settings)
      const history = repo.getMessages(thread.id)
      const allowImages = history.some((m) => m.attachments?.some((a) => a.kind === 'image'))
        ? await modelAcceptsImages(model)
        : true

      const params: ChatMessageParam[] = [
        ...(context.systemText ? [{ role: 'system' as const, content: context.systemText }] : []),
        ...toChatParams(history, allowImages)
      ]

      // OpenRouter silently drops parameters a provider does not implement. For
      // this model several providers do not support tool calling at all, so
      // without this the request routes to one of them, the model never sees
      // the tools, and web search appears to do nothing.
      const routing = resolveRouting(thread, settings, model)
      const routingForTurn = context.tools.length
        ? { ...routing, requireParameters: true }
        : routing

      const assistant = repo.insertMessage({
        threadId: thread.id,
        role: 'assistant',
        content: '',
        status: 'streaming',
        model,
        systemPromptSnapshot: context.segments
      })
      liveStreams.set(assistant.id, {
        threadId: thread.id,
        messageId: assistant.id,
        content: '',
        reasoning: ''
      })
      emit({ type: 'start', messageId: assistant.id, threadId: thread.id })

      let result: StreamResult
      try {
        result = await streamChat(
          {
            model,
            messages: params,
            temperature: thread.config.temperature ?? settings.temperature,
            maxTokens: thread.config.maxTokens ?? settings.maxTokens,
            tools: context.tools.length ? context.tools : undefined,
            providerRouting: routingForTurn,
            includeReasoning: settings.streamReasoning,
            attribution: settings.sendAppAttribution,
            webPlugin: settings.web.engine === 'openrouter' && (thread.config.webAccessEnabled ?? settings.web.enabled),
            signal: controller.signal
          },
          {
            onContent: (delta) => {
              const live = liveStreams.get(assistant.id)
              if (live) live.content += delta
              persistProgress(assistant.id)
              emit({ type: 'content', messageId: assistant.id, delta })
            },
            onReasoning: (delta) => {
              const live = liveStreams.get(assistant.id)
              if (live) live.reasoning += delta
              emit({ type: 'reasoning', messageId: assistant.id, delta })
            },
            onProvider: () => undefined
          }
        )
      } catch (err) {
        const aborted = controller.signal.aborted
        const message =
          err instanceof OpenRouterError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err)

        // A turn that produced nothing leaves nothing behind. Keeping the empty
        // placeholder would show a bubble that never says anything, and on a
        // later launch it would still claim to be streaming.
        liveStreams.delete(assistant.id)
        lastPersisted.delete(assistant.id)
        const current = repo.getMessage(assistant.id)
        const producedNothing =
          !current?.content && !current?.reasoning && !current?.toolCalls?.length

        if (aborted) {
          if (producedNothing) {
            repo.deleteMessage(assistant.id)
            emit({ type: 'aborted', messageId: assistant.id, threadId: thread.id })
          } else {
            const finished = repo.updateMessage(assistant.id, { status: 'aborted' })
            emit({ type: 'done', messageId: assistant.id, message: finished! })
          }
          return
        }

        // Errors keep their message so the failure is visible in the transcript.
        repo.updateMessage(assistant.id, { status: 'error', error: message })
        emit({ type: 'error', messageId: assistant.id, error: message })
        return
      }

      liveStreams.delete(assistant.id)
      lastPersisted.delete(assistant.id)
      const stored = repo.updateMessage(assistant.id, {
        content: result.content,
        reasoning: result.reasoning || null,
        provider: result.provider,
        toolCalls: result.toolCalls.length ? result.toolCalls : null,
        status: 'complete'
      })!

      if (result.usage.totalTokens || result.usage.costUsd) {
        repo.recordUsage(thread.id, assistant.id, model, result.provider, result.usage)
        emit({ type: 'usage', messageId: assistant.id, usage: result.usage })
      }

      if (!result.toolCalls.length) {
        emit({ type: 'done', messageId: assistant.id, message: repo.getMessage(assistant.id)! })
        break
      }

      emit({ type: 'tool-call', messageId: assistant.id, toolCalls: result.toolCalls })
      emit({ type: 'done', messageId: assistant.id, message: stored })

      for (const call of result.toolCalls) {
        if (controller.signal.aborted) return

        const toolResult = await executeToolCall(
          thread.id,
          assistant.id,
          call,
          settings,
          emit,
          thread.config.repoPaths ?? []
        )
        const toolMessage = repo.insertMessage({
          threadId: thread.id,
          role: 'tool',
          content: toolResult.content,
          toolResult,
          status: toolResult.isError ? 'error' : 'complete'
        })
        emit({ type: 'tool-result', messageId: toolMessage.id, result: toolResult })
      }
    }

    if (isFirstExchange && !thread.title) {
      await generateTitle(thread.id, emit)
    }

    // Every turn, not only the first: a conversation drifts, and its tags
    // should follow it rather than describe where it started.
    await updateTags(thread.id, emit)
  } finally {
    abortControllers.delete(req.threadId)
  }
}

/** Used by the UI when the user asks for a fresh title on demand. */
export async function retitle(threadId: string, emit: Emit): Promise<string | null> {
  return generateTitle(threadId, emit)
}

/** Used by the UI when the user asks for the tags to be revisited now. */
export async function retag(threadId: string, emit: Emit): Promise<string[] | null> {
  return updateTags(threadId, emit, true)
}

export function newThreadId(): string {
  return randomUUID()
}
