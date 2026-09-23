import type {
  Message,
  SendMessageRequest,
  Settings,
  StreamEvent,
  Thread,
  ToolCall,
  ToolResult,
  Usage
} from '@shared/types'
import { takeKeyPointMarkers } from '@shared/keyPointPrompt'
import { LOAD_SKILL, type Skill } from '@shared/skills'
import { reasoningParam, resolveReasoning } from '@shared/reasoning'
import { keyPointCeiling } from '@shared/defaults'
import * as repo from '../db/repo'
import * as mcp from '../mcp/host'
import { loadSettings } from '../settings'
import { reportProblem } from '../report'
import {
  OpenRouterError,
  complete,
  knownModel,
  listModels,
  streamChat,
  type ChatMessageParam,
  type Citation,
  type StreamResult
} from '../providers/openrouter'
import { runWebFetch, runWebSearch } from '../tools/web'
import { runLoadSkill } from '../tools/skills'
import { REPO_TOOL_NAMES } from '../tools/repo'
import { ensureTree, runRepoOp } from '../tools/repoService'
import { nativeImage } from 'electron'
import * as attachments from '../attachments'
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../attachments'
import { assembleContext, estimateTokens, skillsFor } from './prompt'

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

/**
 * Every thread with a turn in flight, which is the only reliable answer.
 *
 * The renderer keeps its own idea of this, assembled from the events it has
 * seen, and an assembled idea can be wrong in one direction forever: a
 * terminal event that never arrives, or arrives naming a message the renderer
 * has no record of, leaves a row claiming a reply is still coming. This is
 * held by the controller that is created before the turn starts and removed
 * in its `finally`, so it is right however the turn ended.
 */
export function generatingThreads(): string[] {
  return [...abortControllers.keys()]
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

/**
 * The `reasoning` field for a turn, or null for a model that has no opinion.
 *
 * Nothing is sent to a model the catalogue says cannot reason. It would be
 * ignored by most and rejected by some, and either way asking a model that
 * does not think how hard to think is the app talking to itself. A model the
 * catalogue has never heard of is asked anyway — the same bet the skills
 * catalogue makes, and for the same reason: most can, and being wrong costs a
 * parameter that gets ignored rather than a feature that silently vanishes.
 */
export function reasoningFor(
  thread: Thread,
  settings: Settings,
  model: string
): Record<string, unknown> | null {
  const info = knownModel(model)
  if (info && !info.supportsReasoning) return null
  return reasoningParam(
    resolveReasoning(thread.config.reasoning, settings.reasoning),
    settings.streamReasoning
  )
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

/**
 * What to ask this model to answer with, or nothing for an ordinary one.
 *
 * The model's own list rather than a guess, in both directions. A model that
 * can draw does not unless `modalities` says so; a model that cannot draw
 * rejects the parameter rather than ignoring it; and a model that draws and
 * *only* draws rejects being asked for text alongside — "No endpoints found
 * that support the requested output modalities: image, text" is a 404, not a
 * worse answer. So an unknown model is asked for nothing special, which is
 * the opposite of `modelAcceptsImages` above and for the opposite reason:
 * there, guessing wrong drops an attachment the provider would have taken;
 * here, guessing wrong fails the whole turn.
 */
export async function outputModalitiesFor(model: string): Promise<string[] | undefined> {
  try {
    const models = await listModels()
    const found = models.find((m) => m.id === model)
    if (!found?.outputModalities.includes('image')) return undefined
    return found.outputModalities
  } catch {
    return undefined
  }
}

/** `data:image/png;base64,…` split into the parts the store wants. */
function readDataUrl(url: string): { mime: string; data: string } | null {
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const head = url.slice(5, comma)
  if (!head.endsWith(';base64')) return null
  return { mime: head.slice(0, -';base64'.length), data: url.slice(comma + 1) }
}

/**
 * Keeps a drawn picture the way the reader's own pictures are kept.
 *
 * Deliberately the same path: `attachments.store` writes the file, gives it a
 * `dpimg://` address and a row against the message, and from that point
 * nothing downstream knows or cares that a model made it. The transcript
 * draws it, the viewer opens it, export packs it and sync carries it, all
 * without a line of new code — which is the whole reason it is stored rather
 * than left as a data URL in the message text.
 */
async function keepImage(
  threadId: string,
  messageId: string,
  dataUrl: string,
  emit: Emit
): Promise<void> {
  try {
    const parsed = readDataUrl(dataUrl)
    if (!parsed) return

    /*
     * Measured, because an image with no size never loads.
     *
     * The reader's own pictures are measured in the composer before they are
     * stored, so their `<img>` carries width and height and reserves space.
     * Stored without them a generated one is a zero-by-zero box — and a
     * zero-by-zero box that is also `loading="lazy"` is never in the
     * viewport, so the browser never asks for it. Measured here: the element
     * sat with `complete: false` for as long as it was watched.
     *
     * `nativeImage` reads the header of anything Chromium can display, which
     * is the same set this is allowed to store, so there is no format list
     * here to fall behind.
     */
    const size = nativeImage.createFromBuffer(Buffer.from(parsed.data, 'base64')).getSize()

    const stored = attachments.store(threadId, messageId, {
      mime: parsed.mime,
      // Named after the turn rather than given something generic, so a folder
      // of saved pictures says which conversation each came out of.
      filename: `generated-${messageId.slice(0, 8)}-${Date.now()}.${parsed.mime.split('/')[1] || 'png'}`,
      data: parsed.data,
      width: size.width || null,
      height: size.height || null
    })
    emit({ type: 'image', messageId, attachment: stored })
  } catch (err) {
    /*
     * A picture that could not be kept is not a turn that failed.
     *
     * `store` refuses an unsupported format or anything past the size limit,
     * and the reply's words are already on screen. Said out loud because the
     * alternative is a model that appears to have drawn nothing.
     */
    reportProblem(err, 'Could not keep a generated image')
  }
}

/**
 * The pages OpenRouter's own search read, shown the way a search is shown.
 *
 * The `:online` plugin searches server-side. There is no tool call to watch,
 * so a web-enabled turn produced an answer with nothing to say where it came
 * from — the same question asked with the built-in `web_search` left a "Ran
 * web_search" step in the transcript with the results inside it, and asked
 * through OpenRouter left nothing at all.
 *
 * So the citations become one, through the same `tool` message the built-in
 * search writes: same row, same disclosure, same name, and counted in the
 * statistics alongside it — because it is the same thing happening, only
 * somewhere else.
 *
 * The row is written after the reply, because the reply already exists and is
 * already streaming by the time OpenRouter mentions what it read. Where it is
 * *drawn* is a separate question, answered in the renderer: the assistant
 * message it belongs to is named in the `toolCallId`, and that is what puts
 * the step back where a tool round would have been. See `liftPluginSearches`.
 */
function keepCitations(
  threadId: string,
  assistantMessageId: string,
  citations: Citation[],
  emit: Emit
): void {
  if (!citations.length) return

  const content = citations
    .map((c, i) => `${i + 1}. ${c.title}\n   ${c.url}${c.snippet ? `\n   ${c.snippet}` : ''}`)
    .join('\n\n')

  const toolResult: ToolResult = {
    // Its own id, and deliberately not one a model could have produced: no
    // call was made, so nothing may later be matched back to one.
    // `toChatParams` drops a result whose call it never saw, which is what
    // should happen — the search belonged to that turn.
    toolCallId: `openrouter-search-${assistantMessageId}`,
    name: 'web_search',
    content,
    isError: false,
    // The search happened inside a turn that was already being timed.
    // Claiming a duration of its own would be inventing one, and the
    // transcript now leaves the figure out rather than printing "0ms".
    durationMs: 0
  }

  const message = repo.insertMessage({
    threadId,
    role: 'tool',
    content,
    toolResult,
    status: 'complete'
  })
  repo.recordToolInvocation({
    threadId,
    messageId: assistantMessageId,
    source: 'web',
    serverId: null,
    toolName: 'web_search',
    isError: false,
    durationMs: 0,
    resultChars: content.length
  })
  emit({ type: 'tool-result', threadId, messageId: message.id, result: toolResult })
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

export async function shouldCompact(
  thread: Thread,
  settings: Settings
): Promise<{ needed: boolean; used: number; limit: number | null }> {
  const model = resolveModel(thread, settings)
  const limit = await contextLimitFor(model)

  /*
   * Counted in the database rather than here.
   *
   * This runs every time a conversation is opened, and it used to begin by
   * loading every message in that conversation — with its usage row and its
   * attachments — only to add up the lengths of the text. On a long thread
   * that was the whole cost of opening it. `contextEstimate` asks SQLite for
   * the same three numbers and reads no messages at all.
   */
  const estimate = repo.contextEstimate(thread.id)
  const { estimatedTokens } = assembleContext(thread, settings)
  const used = estimate.measured ?? estimate.fromText + estimatedTokens

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
  repoPaths: string[] = [],
  skills: Skill[] = []
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
    source: 'web' | 'mcp' | 'repo' | 'skill',
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
    /*
     * A skill's instructions, which is a read from a constant rather than a
     * call out to anything — but it is a tool round all the same, and it is
     * the one the transcript most wants to show: "Ran load_skill" is the
     * model saying out loud that it decided a chart was worth drawing.
     */
    if (call.name === LOAD_SKILL) {
      const content = runLoadSkill(args, skills)
      repo.recordToolInvocation({
        threadId,
        messageId: assistantMessageId,
        source: 'skill',
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
      REPO_TOOL_NAMES.has(call.name)
        ? 'repo'
        : call.name === LOAD_SKILL
          ? 'skill'
          : call.name.startsWith('web_')
            ? 'web'
            : 'mcp',
      null
    )
  }
}

/* ------------------------------------------------------------------ *
 * Thread titles
 * ------------------------------------------------------------------ */

/**
 * Threads wearing a name written before the answer existed.
 *
 * Held in memory rather than on the thread, because it is only true for the
 * length of one turn — a few seconds — and a column for it would have to be
 * migrated, synced, and reasoned about on the other machine. The cost of
 * losing it is that a session killed mid-turn keeps the provisional name, which
 * is a name taken from the question rather than the whole exchange. That is a
 * slightly worse title, not a wrong one.
 */
const provisionalTitles = new Set<string>()

/**
 * A name from the question alone, before there is an answer to read.
 *
 * Naming has always waited for the reply, which is the better material and the
 * wrong moment: the row sits unnamed for exactly as long as you are watching
 * it, and gets its name at the point you no longer need one. This writes a
 * name from what you just asked — usually within a second, from a small model
 * — and marks it to be replaced by the considered one when the turn ends.
 *
 * Never awaited by the turn. It is a label for a list, and a conversation must
 * not wait on one.
 */
export async function pregenerateTitle(threadId: string, prompt: string, emit: Emit): Promise<void> {
  const settings = loadSettings()
  if (!settings.titleGenerationEnabled || !settings.titlePregenEnabled) return
  if (!prompt.trim()) return

  const thread = repo.getThread(threadId)
  if (!thread || thread.title || thread.temporary) return

  const model = settings.titlePregenModel || settings.titleModel

  try {
    const result = await complete({
      model,
      messages: [
        { role: 'system', content: settings.titlePrompt },
        { role: 'user', content: `USER: ${prompt.slice(0, 1500)}` }
      ],
      temperature: 0.4,
      maxTokens: 24,
      providerRouting: settings.modelProviderRouting[model] ?? null,
      attribution: settings.sendAppAttribution
    })

    const title = cleanTitle(result.content)
    if (!title) return

    /*
     * Only if it is still nameless.
     *
     * A slow pregeneration can land after the turn it was started for has
     * already ended and been named properly, and writing then would replace a
     * title that read the whole exchange with one that read the first line of
     * it. Re-read rather than trusting the row from before the request.
     */
    const now = repo.getThread(threadId)
    if (!now || now.title) return

    repo.updateThread(threadId, { title })
    provisionalTitles.add(threadId)
    recordTitleCost(threadId, model, result)
    emit({ type: 'title', threadId, title })
  } catch {
    // A name nobody has yet is not worth an error. The turn will produce one.
  }
}

/** The shape a title has to be in: one line, no quotes, no full stop. */
function cleanTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/[.!?]+$/, '')
    .slice(0, 80)
}

/**
 * Naming costs money, so it goes in the statistics like everything else.
 *
 * A hidden marker message carries the usage, which is how a cost with no
 * message of its own is recorded — `compacted_into = 'title'` keeps it out of
 * the transcript and out of the thread's length.
 */
function recordTitleCost(
  threadId: string,
  model: string,
  result: { provider: string | null; usage: Usage }
): void {
  if (!result.usage.totalTokens) return
  const marker = repo.insertMessage({
    threadId,
    role: 'system',
    content: '',
    model,
    compactedInto: 'title'
  })
  repo.recordUsage(threadId, marker.id, model, result.provider, result.usage)
}

/**
 * Threads a name is being fetched for right now.
 *
 * Two things ask: the end of every turn, and the sweep. Without this they can
 * ask at the same moment for the same thread, and the reader pays for two
 * titles to get one.
 */
const naming = new Set<string>()

/**
 * How many times a name is worth asking for, and how long to wait between.
 *
 * One attempt used to be all there was, and a single failure meant the thread
 * stayed unnamed until some later start of the app swept it up. Measured on a
 * real library (2026-09-22): of 540 threads carrying a naming record, 33 were
 * named more than two minutes after the conversation happened and the worst
 * was named eighteen days later — which is eighteen days of a row that said
 * nothing about what was in it.
 *
 * The model itself is not the problem: twelve title requests in a row, on the
 * model this defaults to, answered twelve times. What fails is the moment —
 * a network that came back a second later, a VPN reconnecting, a request
 * still in flight when the window closed. All of which a second attempt a few
 * seconds later survives.
 *
 * Three attempts and no more. This is one small request per conversation and
 * the backoff is generous, so it cannot become a burst; the earlier lesson
 * that a retry can make things worse was about four requests in 1.6 seconds,
 * which this is the opposite of.
 */
/**
 * Says that no name is coming, so the row can stop pretending one is.
 *
 * The sidebar shimmers where a name will go, and for a long time the only
 * thing that ended the shimmer was a two-minute clock — a hundred and
 * nineteen seconds of a finished conversation looking like one still being
 * written, because nothing ever said the request had already failed.
 *
 * Only from where naming actually gives up. A caller that declined because
 * another attempt is in flight has not given up on anything.
 */
function giveUp(threadId: string, emit: Emit): null {
  if (!repo.getThread(threadId)?.title) emit({ type: 'title', threadId, title: null })
  return null
}

/**
 * Why naming last failed, for whoever asked for it by hand.
 *
 * A name that fails on its own is a convenience that did not happen, and
 * saying so would be interrupting. A name somebody pressed a button for is a
 * question they asked, and "Could not generate a name" is not an answer to
 * it — the reason is almost always something they can act on, and almost
 * always the same one: a title model served by a single provider that is
 * rate limiting. Told which model and what it said, the fix is thirty
 * seconds in Settings. Told nothing, it is a mystery that recurs.
 */
let lastNameFailure: string | null = null

const NAME_ATTEMPTS = 3
const WAIT_BEFORE_RETRY = [2000, 6000]

export async function generateTitle(threadId: string, emit: Emit): Promise<string | null> {
  const settings = loadSettings()
  if (!settings.titleGenerationEnabled) return null

  const thread = repo.getThread(threadId)
  if (!thread) return null
  /*
   * Someone is already asking. Say nothing and let them answer.
   *
   * Returning quietly matters more than it looks: the sidebar stops
   * shimmering when naming reports that nothing is coming, and a second
   * caller declining is not that — the first is still working, and the row
   * would flicker to "Untitled" and back.
   */
  if (naming.has(threadId)) return null

  const messages = repo.getMessages(threadId).filter((m) => m.role === 'user' || m.role === 'assistant')
  if (!messages.length) return null

  const transcript = messages
    .slice(0, 4)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}`)
    .join('\n\n')

  naming.add(threadId)
  try {
    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((wake) => setTimeout(wake, WAIT_BEFORE_RETRY[attempt - 1]))
        // Something else may have named it while this was waiting — the sweep,
        // or the reader typing one in.
        if (repo.getThread(threadId)?.title) return null
      }

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

        const title = cleanTitle(result.content)
        // An answer that cleaned away to nothing is an answer. Asking the same
        // model the same question again would produce the same nothing.
        if (!title) return giveUp(threadId, emit)

        repo.updateThread(threadId, { title })
        // Whatever it was called before, this one read the whole exchange. A
        // pregeneration still in flight checks for a title and will stand down.
        provisionalTitles.delete(threadId)
        recordTitleCost(threadId, settings.titleModel, result)

        lastNameFailure = null
        emit({ type: 'title', threadId, title })
        return title
      } catch (err) {
        /*
         * Said out loud, which it never used to be.
         *
         * `catch { return null }` is how a thread could go eighteen days
         * without a name and leave nothing behind explaining it. Naming is
         * still a convenience and still must not disturb the conversation,
         * but a convenience that fails silently is one nobody can fix.
         */
        const why = err instanceof Error ? err.message : String(err)
        if (attempt === NAME_ATTEMPTS - 1) {
          reportProblem(why, `Could not name a thread after ${NAME_ATTEMPTS} attempts`)
          lastNameFailure = `${settings.titleModel}: ${why}`
          return giveUp(threadId, emit)
        }
        // Not reported: a retry that succeeds is not a failure the reader
        // needs told about, and three toasts for one name would be worse than
        // the silence this replaced. Only the giving-up above is said aloud.
        console.log(`Naming a thread failed (${why}); trying again.`)
      }
    }
    return null
  } finally {
    naming.delete(threadId)
  }
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
      // A name for the row while the reply is still being written. Started
      // here, not awaited: the answer is what you are waiting for.
      void pregenerateTitle(thread.id, req.content, emit)

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
            reasoning: reasoningFor(thread, settings, model),
            attribution: settings.sendAppAttribution,
            webPlugin:
              !settings.hideExperimental &&
              settings.web.engine === 'openrouter' &&
              (thread.config.webAccessEnabled ?? settings.web.enabled),
            modalities: await outputModalitiesFor(model),
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
            onImage: (dataUrl) => void keepImage(req.threadId, assistant.id, dataUrl, emit),
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
          !current?.content &&
          !current?.reasoning &&
          !current?.toolCalls?.length &&
          // A drawn picture is something produced, and the only thing that
          // survives a turn where the model said nothing about it. Deleting
          // the message here would take the attachment row with it and leave
          // the file to be swept.
          !current?.attachments.length

        if (aborted) {
          if (producedNothing) {
            repo.deleteMessage(assistant.id)
            emit({ type: 'aborted', messageId: assistant.id, threadId: thread.id })
          } else {
            /*
             * `done` carries the finished message, so there has to be one.
             *
             * The row can be gone by now — the thread was swept, or the reply
             * was regenerated over — and `done` with nothing in it used to
             * throw in the renderer's handler, which stopped the rest of that
             * handler running and left the row saying a reply was still on its
             * way. Nothing to show is what `aborted` means.
             */
            const finished = repo.updateMessage(assistant.id, { status: 'aborted' })
            if (finished) emit({ type: 'done', messageId: assistant.id, message: finished })
            else emit({ type: 'aborted', messageId: assistant.id, threadId: thread.id })
          }
          return
        }

        // Errors keep their message so the failure is visible in the transcript.
        repo.updateMessage(assistant.id, { status: 'error', error: message })
        emit({ type: 'error', messageId: assistant.id, threadId: thread.id, error: message })
        return
      }

      liveStreams.delete(assistant.id)
      lastPersisted.delete(assistant.id)
      /*
       * The model may have named its own key sentences on the way past.
       *
       * Taken out of the text before it is stored, so the marker never
       * reaches an export, the clipboard, or the next turn's context — it is
       * invisible on screen either way, since raw HTML in a reply is not
       * rendered, but invisible is not the same as gone.
       */
      const marked =
        settings.keyPointEnabled && settings.keyPointSource === 'self'
          ? takeKeyPointMarkers(result.content, keyPointCeiling(settings.keyPointMany))
          : { content: result.content, keyPoints: [] }

      const stored = repo.updateMessage(assistant.id, {
        content: marked.content,
        reasoning: result.reasoning || null,
        provider: result.provider,
        toolCalls: result.toolCalls.length ? result.toolCalls : null,
        status: 'complete'
      })
      if (marked.keyPoints.length) repo.setKeyPoints(assistant.id, marked.keyPoints)

      // Gone from under the turn. Say so and stop, rather than carry a null
      // through three more emits.
      if (!stored) {
        emit({ type: 'aborted', messageId: assistant.id, threadId: thread.id })
        return
      }

      if (result.usage.totalTokens || result.usage.costUsd) {
        repo.recordUsage(thread.id, assistant.id, model, result.provider, result.usage)
        emit({ type: 'usage', messageId: assistant.id, usage: result.usage })
      }

      keepCitations(req.threadId, assistant.id, result.citations, emit)

      if (!result.toolCalls.length) {
        const complete = repo.getMessage(assistant.id)
        if (complete) emit({ type: 'done', messageId: assistant.id, message: complete })
        else emit({ type: 'aborted', messageId: assistant.id, threadId: thread.id })
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
          thread.config.repoPaths ?? [],
          skillsFor(thread, settings)
        )
        const toolMessage = repo.insertMessage({
          threadId: thread.id,
          role: 'tool',
          content: toolResult.content,
          toolResult,
          status: toolResult.isError ? 'error' : 'complete'
        })
        emit({ type: 'tool-result', threadId: thread.id, messageId: toolMessage.id, result: toolResult })
      }
    }

  } finally {
    abortControllers.delete(req.threadId)

    // Naming happens here rather than at the end of the turn, and on any turn
    // rather than only the first.
    //
    // Every way a turn can end short of completing used to skip it and nothing
    // came back to it later: stopping the reply returns out of the tool loop, a
    // failed request throws past it, and a first exchange that errored left the
    // thread permanently unnamed because the retry was no longer "the first".
    // A thread with something in it and no name gets one, whenever that is.
    await nameIfUnnamed(req.threadId, emit)
  }
}

/**
 * Names a thread if it has no name and has something to name it after.
 *
 * Cheap to call on every turn: it reads one row, and the request itself only
 * happens when the name is still missing.
 */
async function nameIfUnnamed(threadId: string, emit: Emit): Promise<void> {
  try {
    const thread = repo.getThread(threadId)
    // A provisional name is one this is meant to replace: it was written from
    // the question alone, and the exchange it was standing in for now exists.
    if (!thread || (thread.title && !provisionalTitles.has(threadId))) return
    // A temporary chat is not named: it would be a request paid for to label
    // something that is about to stop existing, and it already reads as
    // "Temporary chat" wherever it appears.
    if (thread.temporary) return
    await generateTitle(threadId, emit)
  } catch {
    // Naming is a convenience. A failure must not disturb the conversation.
  }
}

/**
 * Names every thread that still has none, at startup.
 *
 * The turn-by-turn attempt covers a thread that is still being used; this is
 * for the ones that are not — the app was closed mid-reply, or the request that
 * would have named it failed and the conversation was never returned to. One at
 * a time, oldest first, and capped, so a library that has been running untitled
 * for months does not open with a hundred simultaneous requests.
 */
export async function nameUntitledThreads(emit: Emit): Promise<number> {
  const settings = loadSettings()
  if (!settings.titleGenerationEnabled) return 0
  // Without a key every attempt fails identically; the thread keeps its place
  // in the queue and is named on the first start after one is added.
  if (!settings.hasApiKey) return 0

  let named = 0
  for (const id of repo.listUntitledThreadIds(TITLE_SWEEP_LIMIT)) {
    const title = await generateTitle(id, emit)
    if (title) named++
  }
  return named
}

/** How many threads one startup will name, so a backlog is worked through. */
const TITLE_SWEEP_LIMIT = 25

/** Used by the UI when the user asks for a fresh title on demand. */
/**
 * A name asked for deliberately, and the reason if there is not one.
 *
 * The only caller that wants the reason: naming that happens on its own says
 * nothing when it fails, because a toast for something nobody asked for is an
 * interruption. This is a button somebody pressed.
 */
export async function retitle(
  threadId: string,
  emit: Emit
): Promise<{ title: string | null; error: string | null }> {
  lastNameFailure = null
  const title = await generateTitle(threadId, emit)
  return { title, error: title ? null : lastNameFailure }
}
