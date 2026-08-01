import { randomUUID } from 'node:crypto'
import type {
  Message,
  SendMessageRequest,
  Settings,
  StreamEvent,
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
import {
  REPO_TOOL_NAMES,
  runRepoFind,
  runRepoRead,
  runRepoSearch,
  runRepoTree
} from '../tools/repo'
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
      const content =
        call.name === 'repo_tree'
          ? runRepoTree(repoPaths, args)
          : call.name === 'repo_read'
            ? runRepoRead(repoPaths, args)
            : call.name === 'repo_search'
              ? runRepoSearch(repoPaths, args)
              : runRepoFind(repoPaths, args)

      repo.recordToolInvocation({
        threadId,
        messageId: assistantMessageId,
        source: 'repo',
        serverId: null,
        toolName: call.name,
        isError: false,
        durationMs: Date.now() - startedAt
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
        durationMs: Date.now() - startedAt
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
      durationMs: Date.now() - startedAt
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
  } finally {
    abortControllers.delete(req.threadId)
  }
}

/** Used by the UI when the user asks for a fresh title on demand. */
export async function retitle(threadId: string, emit: Emit): Promise<string | null> {
  return generateTitle(threadId, emit)
}

export function newThreadId(): string {
  return randomUUID()
}
