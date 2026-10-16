import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { DEFAULT_PROVIDER_ROUTING } from '@shared/defaults'
import type { SystemPromptSegment, Usage, WebServerSettings, WebServerStatus } from '@shared/types'
import { getDb } from './db'
import * as repo from './db/repo'
import { complete, knownModel, OpenRouterError } from './providers/openrouter'
import { loadSettings } from './settings'

const MAX_BODY_BYTES = 256 * 1024
const MAX_PROMPT_CHARS = 100_000
const MAX_PARALLEL_PROMPTS = 4
const RESULT_LIFETIME_MS = 24 * 60 * 60 * 1000

interface PromptResult {
  id: string
  prompt: string
  reply: string
  model: string
  systemPrompt: string
  provider: string | null
  usage: Usage
  createdAt: number
  repliedAt: number
  threadId: string | null
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

let server: Server | null = null
let status: WebServerStatus = { state: 'stopped', port: 3789, error: null }
let openThread: ((threadId: string) => void) | null = null
let threadCreated: (() => void) | null = null
let wanted: { settings: WebServerSettings; hideExperimental: boolean } | null = null
let configuration = Promise.resolve()
let configurationRevision = 0
let activePrompts = 0

const results = new Map<string, PromptResult>()
const controllers = new Set<AbortController>()
const statusListeners = new Set<(next: WebServerStatus) => void>()

function publish(next: WebServerStatus): void {
  status = next
  for (const listener of statusListeners) listener(next)
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('webServer:status', next)
  }
}

function localHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function isLoopbackHost(header: string | undefined): boolean {
  if (!header) return false
  try {
    const url = new URL(`http://${header}`)
    return !url.username && !url.password && localHostname(url.hostname)
  } catch {
    return false
  }
}

function localOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && localHostname(url.hostname)
  } catch {
    return false
  }
}

function json(res: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(body)
}

async function requestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type'] ?? ''
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, 'Send a JSON request body with Content-Type: application/json.')
  }

  const chunks: Buffer[] = []
  let bytes = 0
  let tooLarge = false
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) {
      tooLarge = true
      continue
    }
    chunks.push(buffer)
  }
  if (tooLarge) throw new HttpError(413, 'The JSON request body is too large.')

  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'The request body must be a JSON object.')
  }
  return value as Record<string, unknown>
}

function expireResults(): void {
  const before = Date.now() - RESULT_LIFETIME_MS
  for (const [id, result] of results) {
    if (result.createdAt < before) results.delete(id)
  }
}

async function promptEndpoint(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (activePrompts >= MAX_PARALLEL_PROMPTS) {
    throw new HttpError(429, 'The web server is busy. Try again shortly.')
  }
  activePrompts += 1
  let controller: AbortController | null = null
  try {
    const body = await requestJson(req)
    const prompt = typeof body.prompt === 'string' ? body.prompt : ''
    if (!prompt.trim()) throw new HttpError(400, 'A non-empty "prompt" string is required.')
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new HttpError(
        413,
        `The prompt must be ${MAX_PROMPT_CHARS.toLocaleString()} characters or fewer.`
      )
    }

    const settings = loadSettings()
    if (!settings.webServer.enabled || settings.hideExperimental) {
      throw new HttpError(503, 'The experimental web server is disabled in Deep Pink settings.')
    }
    if (!settings.hasApiKey) throw new HttpError(503, 'Add an OpenRouter API key in Deep Pink settings.')

    const requestController = new AbortController()
    controller = requestController
    controllers.add(requestController)
    res.on('close', () => {
      if (!res.writableEnded) requestController.abort()
    })

    /*
     * This request intentionally does not use the chat engine. The request is
     * a single text exchange with only the prompt saved on the Web server
     * settings page: no tools, MCP, repo access, skills, web plugin, or global
     * prompt layers are assembled here.
     */
    const modelInfo = knownModel(settings.webServer.model)
    if (
      modelInfo &&
      (!modelInfo.inputModalities.includes('text') ||
        !modelInfo.outputModalities.includes('text'))
    ) {
      throw new HttpError(400, 'The selected web server model does not support text replies.')
    }
    const requestedAt = Date.now()
    const answer = await complete({
      model: settings.webServer.model,
      messages: [
        ...(settings.webServer.systemPrompt.trim()
          ? [{ role: 'system' as const, content: settings.webServer.systemPrompt }]
          : []),
        { role: 'user', content: prompt }
      ],
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      providerRouting: DEFAULT_PROVIDER_ROUTING,
      modalities: modelInfo?.outputModalities.includes('image') ? ['text'] : undefined,
      attribution: settings.sendAppAttribution,
      signal: requestController.signal
    })

    if (requestController.signal.aborted) return
    expireResults()
    const id = randomUUID()
    const record: PromptResult = {
      id,
      prompt,
      reply: answer.content,
      model: settings.webServer.model,
      systemPrompt: settings.webServer.systemPrompt,
      provider: answer.provider,
      usage: answer.usage,
      createdAt: requestedAt,
      repliedAt: Date.now(),
      threadId: null
    }
    results.set(id, record)
    json(res, 200, { id, prompt, reply: record.reply, model: record.model })
  } finally {
    activePrompts -= 1
    if (controller) controllers.delete(controller)
  }
}

function threadTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  return compact.length > 80 ? `${compact.slice(0, 77).trimEnd()}…` : compact
}

function promptSnapshot(text: string): SystemPromptSegment[] {
  if (!text.trim()) return []
  return [
    {
      id: 'web-server',
      source: 'thread',
      label: 'Web server system prompt',
      origin: 'Web server settings',
      text,
      tokens: Math.ceil(text.length / 4),
      enabled: true,
      removable: true
    }
  ]
}

function openEndpoint(res: ServerResponse, id: unknown): void {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'A result "id" is required.')
  expireResults()
  const result = results.get(id)
  if (!result) throw new HttpError(404, 'No web server result was found for that id.')

  if (!result.threadId) {
    const systemPromptSnapshot = promptSnapshot(result.systemPrompt)
    const thread = getDb().transaction(() => {
      const created = repo.createThread(threadTitle(result.prompt), {
        model: result.model,
        systemPrompt: result.systemPrompt || null,
        webAccessEnabled: false,
        enabledMcpServers: [],
        chartsEnabled: false,
        // Keep future turns in this thread isolated too until the user changes
        // its settings. The transcript remains an ordinary, editable thread.
        disabledPromptSegments: ['base', 'datetime', 'tools', 'web', 'skills', 'charts', 'repo']
      })
      repo.insertMessage({
        threadId: created.id,
        role: 'user',
        content: result.prompt,
        createdAt: result.createdAt
      })
      const assistantMessage = repo.insertMessage({
        threadId: created.id,
        role: 'assistant',
        content: result.reply,
        createdAt: result.repliedAt,
        model: result.model,
        provider: result.provider,
        status: 'complete',
        systemPromptSnapshot
      })
      repo.recordUsage(created.id, assistantMessage.id, result.model, result.provider, result.usage)
      return created
    })()
    result.threadId = thread.id
    threadCreated?.()
  }

  openThread?.(result.threadId)
  json(res, 200, { id: result.id, threadId: result.threadId, opened: true })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackHost(req.headers.host)) {
    json(res, 403, { error: 'The web server only accepts localhost requests.' })
    return
  }

  const origin = req.headers.origin
  if (origin) {
    if (!localOrigin(origin)) {
      json(res, 403, { error: 'Browser requests are accepted only from localhost origins.' })
      return
    }
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(origin ? 204 : 403)
    res.end()
    return
  }

  const current = loadSettings()
  if (!current.webServer.enabled || current.hideExperimental) {
    json(res, 503, { error: 'The experimental web server is disabled in Deep Pink settings.' })
    return
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS')
    json(res, 405, { error: 'Use POST for the web server endpoints.' })
    return
  }

  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/v1/prompt') {
      await promptEndpoint(req, res)
    } else if (path === '/v1/open') {
      const body = await requestJson(req)
      openEndpoint(res, body.id)
    } else {
      json(res, 404, { error: 'Endpoint not found.' })
    }
  } catch (err) {
    if (res.headersSent || res.destroyed) return
    const statusCode =
      err instanceof HttpError ? err.status : err instanceof OpenRouterError ? 502 : 500
    const message = err instanceof Error ? err.message : String(err)
    json(res, statusCode, { error: message })
  }
}

async function closeServerInstance(current: Server): Promise<void> {
  if (!current?.listening) return
  current.closeAllConnections()
  await new Promise<void>((resolve) => current.close(() => resolve()))
}

async function closeCurrent(): Promise<void> {
  const current = server
  server = null
  for (const controller of controllers) controller.abort()
  if (current) await closeServerInstance(current)
}

async function reconcile(revision: number): Promise<void> {
  if (revision !== configurationRevision) return
  const target = wanted
  if (!target || target.hideExperimental || !target.settings.enabled) {
    if (server) await closeCurrent()
    if (revision !== configurationRevision) return
    publish({ state: 'stopped', port: target?.settings.port ?? status.port, error: null })
    return
  }

  if (server?.listening && status.port === target.settings.port) {
    publish({ state: 'running', port: status.port, error: null })
    return
  }
  if (server) await closeCurrent()
  if (revision !== configurationRevision) return

  const next = createServer((req, res) => {
    void handleRequest(req, res)
  })
  next.requestTimeout = 30_000
  next.headersTimeout = 30_000
  next.keepAliveTimeout = 5_000
  server = next
  publish({ state: 'starting', port: target.settings.port, error: null })

  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (err: Error): void => reject(err)
      next.once('error', failed)
      next.listen(target.settings.port, '127.0.0.1', () => {
        next.removeListener('error', failed)
        resolve()
      })
    })
    if (revision !== configurationRevision) {
      if (server === next) server = null
      await closeServerInstance(next)
      return
    }
    next.on('error', (err) => {
      if (server !== next) return
      server = null
      publish({
        state: 'error',
        port: target.settings.port,
        error: err.message || 'The web server stopped unexpectedly.'
      })
    })
    publish({ state: 'running', port: target.settings.port, error: null })
  } catch (err) {
    if (server === next) server = null
    if (revision !== configurationRevision) {
      await closeServerInstance(next)
      return
    }
    publish({
      state: 'error',
      port: target.settings.port,
      error: err instanceof Error ? err.message : String(err)
    })
    if (next.listening) next.close()
  }
}

/** Starts, reconfigures or stops the localhost listener after a settings change. */
export function configure(settings: WebServerSettings, hideExperimental: boolean): Promise<void> {
  wanted = { settings, hideExperimental }
  const revision = ++configurationRevision
  configuration = configuration.then(
    () => reconcile(revision),
    () => reconcile(revision)
  )
  return configuration
}

/** Stops the listener and any provider calls during app shutdown. */
export function shutdown(): void {
  configurationRevision += 1
  wanted = null
  for (const controller of controllers) controller.abort()
  const current = server
  server = null
  if (current?.listening) {
    current.closeAllConnections()
    current.close()
  }
  publish({ state: 'stopped', port: status.port, error: null })
}

export function getStatus(): WebServerStatus {
  return { ...status }
}

export function onStatus(listener: (next: WebServerStatus) => void): () => void {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

export function setOpenThreadHandler(handler: (threadId: string) => void): void {
  openThread = handler
}

export function setThreadCreatedHandler(handler: () => void): void {
  threadCreated = handler
}
