import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { ChatModel, ProviderStatus, Usage } from '@shared/types'
import { modelIdForProvider, providerModelId } from '@shared/modelProviders'
import type { ChatRequest, ContentPart, StreamHandlers, StreamResult } from './types'

interface RpcMessage {
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface CodexRawModel {
  id: string
  model: string
  displayName: string
  description?: string
  inputModalities?: string[]
  supportedReasoningEfforts?: { reasoningEffort: string }[]
  hidden?: boolean
}

interface CodexThreadStart {
  thread: { id: string }
}

interface CodexModelList {
  data: CodexRawModel[]
  nextCursor?: string | null
}

interface CodexTokenUsage {
  total?: {
    totalTokens?: number
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    reasoningOutputTokens?: number
  }
  last?: {
    totalTokens?: number
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    reasoningOutputTokens?: number
  }
  modelContextWindow?: number | null
}

const MODEL_CACHE_MS = 5 * 60 * 1000
const MAX_STDERR = 12_000
const REASONING_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

let modelCache: { at: number; models: ChatModel[] } | null = null
let modelError: string | null = null
const contextWindows = new Map<string, number>()

function binaryCandidates(): string[] {
  const suffix = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const home = homedir()
  const nvmBinDirs = (() => {
    const versions = join(home, '.nvm', 'versions', 'node')
    try {
      return readdirSync(versions).map((version) => join(versions, version, 'bin'))
    } catch {
      return []
    }
  })()
  const wellKnown = process.platform === 'darwin'
    ? [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        join(home, '.local', 'bin'),
        join(home, '.codex', 'bin'),
        join(home, '.codex', 'packages', 'standalone', 'current', 'bin')
      ]
    : process.platform === 'win32'
      ? [
          join(home, 'AppData', 'Roaming', 'npm'),
          join(home, '.local', 'bin'),
          join(home, '.codex', 'bin'),
          join(home, '.codex', 'packages', 'standalone', 'current', 'bin')
        ]
      : [
          join(home, '.local', 'bin'),
          join(home, '.npm-global', 'bin'),
          join(home, '.codex', 'bin'),
          join(home, '.codex', 'packages', 'standalone', 'current', 'bin'),
          join(home, '.volta', 'bin'),
          join(home, '.asdf', 'shims'),
          join(home, '.bun', 'bin'),
          ...nvmBinDirs
        ]
  return [...new Set([...pathEntries, ...wellKnown])].flatMap((directory) =>
    suffix.map((extension) => join(directory, `codex${extension}`))
  )
}

function codexBinary(): string | null {
  return binaryCandidates().find((candidate) => {
    try {
      const stat = statSync(candidate)
      return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)
    } catch {
      return false
    }
  }) ?? null
}

export function status(): ProviderStatus['codex'] {
  return {
    available: codexBinary() !== null,
    error: modelError
  }
}

function providerError(error: unknown, stderr = ''): Error {
  const message = error instanceof Error ? error.message : String(error)
  const diagnostic = stderr.trim().slice(-MAX_STDERR)
  if (/ENOENT/.test(message)) {
    return new Error('Codex CLI was not found. Install the Codex CLI and make the `codex` command available to Deep Pink.')
  }
  if (/not logged in|unauthenticated|authentication|login required/i.test(`${message}\n${diagnostic}`)) {
    return new Error('Codex is not signed in on this desktop. Run `codex login` in a terminal, then refresh the model list.')
  }
  return new Error(diagnostic ? `${message}\n${diagnostic}` : message)
}

class AppServer {
  private child: ChildProcessWithoutNullStreams
  private lines: Interface
  private sequence = 0
  private pending = new Map<string | number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()
  private stderr = ''
  private closed = false
  onNotification: (method: string, params: Record<string, unknown>) => void = () => undefined
  onExit: ((error: Error) => void) | null = null

  constructor(binary: string) {
    this.child = spawn(binary, [
      'app-server', '--listen', 'stdio://',
      '--disable', 'shell_tool',
      '--disable', 'unified_exec',
      '--disable', 'shell_snapshot',
      '--disable', 'apps',
      '--disable', 'plugins',
      '--disable', 'web_search_request',
      '--disable', 'browser_use',
      '--disable', 'computer_use',
      '--disable', 'image_generation',
      // Deep Pink's Codex chats do not inherit the user's unrelated MCP tools.
      '-c', 'mcp_servers={}',
      '-c', 'web_search="disabled"'
    ], {
      stdio: 'pipe',
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)
    })
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', (line) => this.receive(line))
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-MAX_STDERR)
    })
    this.child.on('error', (error) => this.failAll(providerError(error, this.stderr)))
    this.child.on('close', (code, signal) => {
      this.closed = true
      const error = providerError(new Error(`Codex App Server exited (${signal ?? code ?? 'unknown'})`), this.stderr)
      this.failAll(error)
      this.onExit?.(error)
    })
  }

  private receive(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      return
    }

    if (message.method) {
      if (message.id !== undefined) {
        // No App Server initiated operation needs approval or a user response in
        // chat mode. Reject server requests so a turn cannot hang waiting for UI.
        this.write({
          id: message.id,
          error: { code: -32601, message: 'Deep Pink chat mode does not handle App Server requests.' }
        })
      } else {
        this.onNotification(message.method, message.params ?? {})
      }
      return
    }

    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'Codex App Server request failed.'))
    } else {
      pending.resolve(message.result)
    }
  }

  private write(value: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin.writable) throw new Error('Codex App Server is not running.')
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params })
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      try {
        this.write({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'deep_pink', title: 'Deep Pink', version: __APP_VERSION__ }
    })
    this.notify('initialized')
  }

  diagnostics(): string {
    return this.stderr
  }

  kill(): void {
    this.child.kill()
  }

  async stop(): Promise<void> {
    if (this.closed) return
    this.lines.close()
    this.child.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill()
        resolve()
      }, 800)
      this.child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

async function withAppServer<T>(run: (server: AppServer) => Promise<T>): Promise<T> {
  const binary = codexBinary()
  if (!binary) throw providerError(new Error('ENOENT'))
  const server = new AppServer(binary)
  try {
    await server.initialize()
    return await run(server)
  } catch (error) {
    throw providerError(error, server.diagnostics())
  } finally {
    await server.stop()
  }
}

function toModel(raw: CodexRawModel): ChatModel {
  const reasoningEfforts = (raw.supportedReasoningEfforts ?? [])
    .map((option) => option.reasoningEffort)
    .sort((a, b) => {
      const rank = (effort: string): number => {
        const index = REASONING_EFFORT_ORDER.indexOf(effort)
        return index < 0 ? Number.MAX_SAFE_INTEGER : index
      }
      return rank(a) - rank(b)
    })
  return {
    id: modelIdForProvider('codex', raw.model || raw.id),
    provider: 'codex',
    name: raw.displayName || raw.model || raw.id,
    description: raw.description ?? '',
    contextLength: 0,
    pricing: {
      prompt: 0,
      completion: 0,
      request: 0,
      image: 0,
      webSearch: 0,
      internalReasoning: 0,
      inputCacheRead: 0,
      inputCacheWrite: 0,
      imageOutput: 0
    },
    supportedParameters: reasoningEfforts.length ? ['reasoning'] : [],
    inputModalities: raw.inputModalities?.length ? raw.inputModalities : ['text'],
    outputModalities: ['text'],
    supportsTools: false,
    supportsReasoning: reasoningEfforts.length > 0,
    reasoningEfforts,
    created: 0
  }
}

export async function listModels(force = false): Promise<ChatModel[]> {
  if (!force && modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models
  try {
    const models = await withAppServer(async (server) => {
      const all: CodexRawModel[] = []
      let cursor: string | null = null
      do {
        const page: CodexModelList = await server.request<CodexModelList>('model/list', {
          includeHidden: false,
          limit: 100,
          ...(cursor ? { cursor } : {})
        })
        all.push(...page.data.filter((model: CodexRawModel) => !model.hidden))
        cursor = page.nextCursor ?? null
      } while (cursor)
      return all.map(toModel)
    })
    modelCache = { at: Date.now(), models }
    modelError = null
    return models
  } catch (error) {
    modelError = error instanceof Error ? error.message : String(error)
    if (modelCache) return modelCache.models
    throw error
  }
}

export function knownModel(id: string): ChatModel | null {
  if (!id.startsWith('codex:')) return null
  return modelCache?.models.find((model) => model.id === id) ?? null
}

export function contextLimitFor(id: string): number | null {
  return contextWindows.get(providerModelId(id)) ?? null
}

function dataUrl(value: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(value)
  if (!match) return null
  return { mime: match[1], bytes: Buffer.from(match[2], 'base64') }
}

function imageExtension(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
}

function transcriptFrom(messages: ChatRequest['messages']): {
  instructions: string
  text: string
  images: { label: string; bytes: Buffer; mime: string; path?: string }[]
} {
  const instructions = messages.filter((message) => message.role === 'system')
    .map((message) => typeof message.content === 'string' ? message.content : '')
    .filter(Boolean)
    .join('\n\n')
  const images: { label: string; bytes: Buffer; mime: string }[] = []
  const lines: string[] = []

  for (const message of messages) {
    if (message.role === 'system') continue
    const label = message.role === 'tool'
      ? `Tool result${message.name ? ` (${message.name})` : ''}`
      : message.role === 'assistant' ? 'Assistant' : 'User'
    const contentParts: ContentPart[] = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content
    const content: string[] = []
    for (const part of contentParts) {
      if (part.type === 'text') {
        content.push(part.text)
      } else {
        const decoded = dataUrl(part.image_url.url)
        if (!decoded) continue
        const imageLabel = `Image attachment ${images.length + 1}`
        images.push({ label: imageLabel, ...decoded })
        content.push(`[${imageLabel}]`)
      }
    }
    const calls = message.role === 'assistant' && message.tool_calls?.length
      ? `\nTool calls: ${message.tool_calls.map((call) => `${call.function.name} ${call.function.arguments}`).join('\n')}`
      : ''
    lines.push(`${label}:\n${content.join('\n')}${calls}`)
  }

  return {
    instructions: [
      'Answer as a conversational assistant. Use the provided conversation as context.',
      'Do not use shell commands, edit files, access the network, or call tools. Deep Pink chat mode only displays a text reply.',
      instructions
    ].filter(Boolean).join('\n\n'),
    text: lines.join('\n\n') || 'Please respond to the user.',
    images
  }
}

function codexEffort(request: ChatRequest, modelId: string): string | undefined {
  const reasoning = request.reasoning
  const supported = knownModel(modelId)?.reasoningEfforts ?? []
  if (!supported.length) return undefined
  if (!reasoning || reasoning['enabled'] === false) return supported[0]
  const value = reasoning['effort']
  if (typeof value !== 'string' && reasoning['max_tokens'] == null) return undefined
  const budget = Number(reasoning['max_tokens'])
  const preferred = typeof value === 'string'
    ? value
    : budget <= 1024 ? 'low'
      : budget <= 4096 ? 'medium'
        : budget <= 8192 ? 'high'
          : budget <= 16_384 ? 'xhigh' : 'max'
  if (!supported.length || supported.includes(preferred)) return preferred
  const target = REASONING_EFFORT_ORDER.indexOf(preferred)
  return [...supported].sort((a, b) =>
    Math.abs(REASONING_EFFORT_ORDER.indexOf(a) - target) - Math.abs(REASONING_EFFORT_ORDER.indexOf(b) - target)
  )[0]
}

function emptyUsage(startedAt: number): Usage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    latencyMs: Date.now() - startedAt,
    timeToFirstTokenMs: null,
    reasoningMs: null,
    tokensPerSecond: null,
    generationId: null
  }
}

function tokenUsage(raw: CodexTokenUsage | null, startedAt: number): Usage {
  const usage = emptyUsage(startedAt)
  const last = raw?.last
  if (!last) return usage
  usage.promptTokens = last.inputTokens ?? 0
  usage.completionTokens = last.outputTokens ?? 0
  usage.reasoningTokens = last.reasoningOutputTokens ?? 0
  usage.cachedTokens = last.cachedInputTokens ?? 0
  usage.totalTokens = last.totalTokens ?? usage.promptTokens + usage.completionTokens
  return usage
}

export async function streamChat(
  request: ChatRequest,
  handlers: StreamHandlers = {}
): Promise<StreamResult> {
  const startedAt = Date.now()
  const modelId = providerModelId(request.model)
  const conversation = transcriptFrom(request.messages)
  const includeReasoning = request.reasoning?.['exclude'] !== true
  const workspace = mkdtempSync(join(tmpdir(), 'deep-pink-codex-'))
  let firstTokenAt: number | null = null
  let reasoningStartedAt: number | null = null
  let reasoningEndedAt: number | null = null
  let content = ''
  let reasoning = ''
  let rawUsage: CodexTokenUsage | null = null
  let threadId: string | null = null
  let doneResolve: (event: Record<string, unknown>) => void = () => undefined
  let doneReject: (error: Error) => void = () => undefined
  const turnDone = new Promise<Record<string, unknown>>((resolve, reject) => {
    doneResolve = resolve
    doneReject = reject
  })
  void turnDone.catch(() => undefined)

  try {
    request.signal?.throwIfAborted()
    for (const [index, image] of conversation.images.entries()) {
      const file = join(workspace, `image-${index + 1}.${imageExtension(image.mime)}`)
      writeFileSync(file, image.bytes, { mode: 0o600 })
      image.path = file
    }
    // Add file references after the conversation text was built, without making
    // prior image bytes part of the local database or an App Server transcript.
    const imageInputs = conversation.images.flatMap((image) =>
      image.path ? [{ type: 'localImage', path: image.path }] : []
    )

    const result = await withAppServer(async (server) => {
      server.onExit = doneReject
      server.onNotification = (method, params) => {
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          firstTokenAt ??= Date.now()
          content += params.delta
          handlers.onContent?.(params.delta)
        } else if (
          includeReasoning &&
          method === 'item/reasoning/summaryTextDelta' &&
          typeof params.delta === 'string'
        ) {
          firstTokenAt ??= Date.now()
          reasoningStartedAt ??= Date.now()
          reasoning += params.delta
          handlers.onReasoning?.(params.delta)
        } else if (method === 'thread/tokenUsage/updated') {
          rawUsage = (params.tokenUsage as CodexTokenUsage | undefined) ?? rawUsage
          const contextWindow = rawUsage?.modelContextWindow
          if (typeof contextWindow === 'number' && contextWindow > 0) {
            contextWindows.set(modelId, contextWindow)
          }
        } else if (method === 'turn/completed') {
          const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined
          if (turn?.status === 'completed') doneResolve(params)
          else doneReject(new Error(turn?.error?.message ?? `Codex turn ${turn?.status ?? 'failed'}.`))
        }
      }

      const thread = await server.request<CodexThreadStart>('thread/start', {
        model: modelId,
        cwd: workspace,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions: conversation.instructions,
      })
      threadId = thread.thread.id

      request.signal?.throwIfAborted()
      let interruptTimer: ReturnType<typeof setTimeout> | null = null
      const onAbort = (): void => {
        if (!threadId) return
        void server.request('turn/interrupt', { threadId }).catch(() => undefined)
        interruptTimer = setTimeout(() => {
          if (!request.signal?.aborted) return
          server.kill()
        }, 2500)
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await server.request('turn/start', {
          threadId,
          model: modelId,
          cwd: workspace,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          input: [
            { type: 'text', text: conversation.text, text_elements: [] },
            ...imageInputs
          ],
          ...(codexEffort(request, request.model) ? { effort: codexEffort(request, request.model) } : {})
        })
        await turnDone
      } finally {
        if (interruptTimer) clearTimeout(interruptTimer)
        request.signal?.removeEventListener('abort', onAbort)
      }

      return tokenUsage(rawUsage, startedAt)
    })

    reasoningEndedAt = reasoningStartedAt === null || !content ? null : Date.now()
    const usage = result
    const finishedAt = Date.now()
    usage.latencyMs = finishedAt - startedAt
    usage.timeToFirstTokenMs = firstTokenAt === null ? null : firstTokenAt - startedAt
    usage.reasoningMs = reasoningStartedAt === null ? null : (reasoningEndedAt ?? finishedAt) - reasoningStartedAt
    usage.tokensPerSecond = usage.completionTokens > 0 && firstTokenAt !== null
      ? usage.completionTokens / Math.max((finishedAt - firstTokenAt) / 1000, 0.001)
      : null
    handlers.onProvider?.('Codex')
    return {
      content,
      reasoning,
      images: [],
      citations: [],
      toolCalls: [],
      finishReason: 'stop',
      provider: 'Codex',
      usage
    }
  } catch (error) {
    if (request.signal?.aborted) throw error
    throw providerError(error)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

export async function complete(request: Omit<ChatRequest, 'tools'>): Promise<StreamResult> {
  return streamChat({ ...request, includeReasoning: false })
}
