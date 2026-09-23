import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync } from 'node:fs'
import { closeDb, getDb } from '../main/db/index'
import { deleteEmptyThreads, deleteTemporaryThreads, reconcileInterruptedMessages } from '../main/db/repo'
import { loadSettings } from '../main/settings'
import { registerIpc, startNaming, startSync, startUpdateChecks } from '../main/ipc'
import * as attachments from '../main/attachments'
import * as engine from '../main/chat/engine'
import { shutdownRepoWorker } from '../main/tools/repoService'
import * as mcp from '../main/mcp/host'
import { reportUncaught } from '../main/report'
import { addEventClient, closeEventClients, drainInvocations, invoke, send } from './electron-shim'

declare const __APP_VERSION__: string

reportUncaught()

const host = '127.0.0.1'
const port = Number(process.env.DEEP_PINK_SERVICE_PORT)
const token = process.env.DEEP_PINK_SERVICE_TOKEN ?? ''
const dataDir = process.env.DEEP_PINK_USER_DATA_DIR
const maxRequestBytes = 240 * 1024 * 1024
const allowedOrigins = new Set(
  (process.env.DEEP_PINK_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
)
let backgroundStartupTimer: ReturnType<typeof setTimeout> | null = null
let attachmentCleanup: Promise<number> | null = null
let stopAttachmentCleanup = false

if (!dataDir || !Number.isInteger(port) || port < 1 || port > 65535 || token.length < 32) {
  throw new Error('Tauri did not provide a valid backend launch configuration')
}

mkdirSync(dataDir, { recursive: true, mode: 0o700 })

const setCors = (request: IncomingMessage, response: ServerResponse<IncomingMessage>): boolean => {
  const origin = request.headers.origin
  if (!origin) return true
  if (!allowedOrigins.has(origin)) return false
  response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DeepPink-Token')
  response.setHeader('Access-Control-Max-Age', '600')
  return true
}

function authorized(request: IncomingMessage, url: URL): boolean {
  return request.headers['x-deeppink-token'] === token || url.searchParams.get('token') === token
}

function replyJson(response: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  const encoded = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(encoded)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const pieces: Buffer[] = []
  let bytes = 0
  for await (const part of request) {
    const piece = Buffer.isBuffer(part) ? part : Buffer.from(part)
    bytes += piece.length
    if (bytes > maxRequestBytes) throw new Error('Request exceeded the attachment size limit')
    pieces.push(piece)
  }
  return JSON.parse(Buffer.concat(pieces).toString('utf8'))
}

function serveAttachment(id: string, response: ServerResponse<IncomingMessage>): void {
  const path = attachments.filePath(id)
  if (!path) {
    response.writeHead(404).end()
    return
  }

  try {
    const bytes = readFileSync(path)
    const row = getDb().prepare('SELECT mime FROM attachments WHERE id = ?').get(id) as
      | { mime: string }
      | undefined
    response.writeHead(200, {
      'Content-Type': row?.mime ?? 'application/octet-stream',
      'Content-Length': bytes.length,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    })
    response.end(bytes)
  } catch {
    response.writeHead(404).end()
  }
}

async function start(): Promise<void> {
  getDb()
  const { removed, settled } = reconcileInterruptedMessages()
  if (removed || settled) {
    console.log(`Recovered from an interrupted session: removed ${removed} empty replies, settled ${settled}.`)
  }
  deleteEmptyThreads()
  deleteTemporaryThreads()

  registerIpc()

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`)
    if (!setCors(request, response)) {
      response.writeHead(403).end()
      return
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      if (!authorized(request, url)) return replyJson(response, 401, { error: 'Unauthorized' })
      return replyJson(response, 200, { ready: true, version: __APP_VERSION__ })
    }

    if (url.pathname === '/events' && request.method === 'GET') {
      if (!authorized(request, url)) return replyJson(response, 401, { error: 'Unauthorized' })
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      response.write(': connected\n\n')
      addEventClient(response)
      return
    }

    if (url.pathname === '/shutdown' && request.method === 'POST') {
      if (!authorized(request, url)) return replyJson(response, 401, { error: 'Unauthorized' })
      await shutdownResources()
      replyJson(response, 200, { stopped: true })
      closeEventClients()
      server.close(() => process.exit(0))
      return
    }

    if (url.pathname.startsWith('/attachment/') && request.method === 'GET') {
      if (!authorized(request, url)) return response.writeHead(401).end()
      const id = decodeURIComponent(url.pathname.slice('/attachment/'.length))
      return serveAttachment(id, response)
    }

    if (url.pathname === '/invoke' && request.method === 'POST') {
      if (!authorized(request, url)) return replyJson(response, 401, { error: 'Unauthorized' })
      try {
        const body = (await readJson(request)) as { channel?: unknown; args?: unknown }
        if (typeof body.channel !== 'string' || !Array.isArray(body.args)) {
          return replyJson(response, 400, { error: 'Expected an IPC channel and argument list' })
        }
        const value = await invoke(body.channel, body.args)
        return replyJson(response, 200, { value })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return replyJson(response, 500, { error: message })
      }
    }

    response.writeHead(404).end()
  })

  server.requestTimeout = 5 * 60 * 1000
  server.headersTimeout = 60 * 1000
  server.listen(port, host, () => {
    console.log(`Deep Pink Tauri backend ready on ${host}:${port}`)
    send('backend:ready', { version: __APP_VERSION__ })

    // Network checks, background workers and attachment cleanup are useful
    // after launch, but none is needed to draw the first screen. Start them
    // after the renderer has had time to connect and initialize its store.
    backgroundStartupTimer = setTimeout(() => {
      backgroundStartupTimer = null
      if (!loadSettings().hideExperimental) void mcp.connectAll().catch(() => undefined)
      startNaming()
      startUpdateChecks()
      startSync()

      // Orphan collection can scan a large attachment directory. It streams
      // its filesystem work and yields between entries so it does not stall
      // the service while the user is chatting.
      attachmentCleanup = attachments
        .collectOrphansAsync(() => stopAttachmentCleanup)
        .then((removed) => {
          if (removed) console.log(`Removed ${removed} orphaned attachment file(s).`)
          return removed
        })
        .catch((error: unknown) => {
          console.error('Could not collect orphaned attachment files.', error)
          return 0
        })
    }, 1500)
    backgroundStartupTimer.unref()
  })

  let cleanup: Promise<void> | null = null
  const shutdownResources = (): Promise<void> => {
    if (cleanup) return cleanup
    cleanup = (async () => {
      stopAttachmentCleanup = true
      if (backgroundStartupTimer) {
        clearTimeout(backgroundStartupTimer)
        backgroundStartupTimer = null
      }
      if (attachmentCleanup) await attachmentCleanup
      const draining = drainInvocations()
      for (const threadId of engine.generatingThreads()) engine.abortThread(threadId)
      await mcp.disconnectAll().catch(() => undefined)
      await draining
      deleteTemporaryThreads()
      await shutdownRepoWorker().catch(() => undefined)
      closeDb()
    })()
    return cleanup
  }

  process.once('SIGTERM', () => {
    void shutdownResources().finally(() => {
      closeEventClients()
      server.close(() => process.exit(0))
    })
  })
  process.once('SIGINT', () => {
    void shutdownResources().finally(() => {
      closeEventClients()
      server.close(() => process.exit(0))
    })
  })
}

void start().catch((error) => {
  console.error('Tauri backend startup failed:', error)
  process.exitCode = 1
})
