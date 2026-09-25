import { unlinkSync } from 'node:fs'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { askQuickQuestion } from './quickQuestion'

const PROTOCOL_VERSION = '1'
const MAX_FRAME_BYTES = 1_048_576
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

type LocalIpcOptions = {
  openMainWindow: () => void
  onClientCountChange?: (count: number) => void
}

let server: Server | null = null
let socketPath: string | null = null
const clients = new Set<Socket>()

function localSocketPath(): { directory: string; path: string; isRuntimeDir: boolean } {
  const uid = process.getuid?.() ?? 0
  const runtimeDir = process.env['XDG_RUNTIME_DIR']
  if (runtimeDir) {
    return {
      directory: runtimeDir,
      path: join(runtimeDir, `deep-pink-${uid}.sock`),
      isRuntimeDir: true
    }
  }

  const cacheHome = process.env['XDG_CACHE_HOME'] || join(homedir(), '.cache')
  const directory = join(cacheHome, 'deep-pink')
  return { directory, path: join(directory, 'ipc.sock'), isRuntimeDir: false }
}

function encode(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64')
}

function decode(payload: string): string {
  if (!BASE64.test(payload)) throw new Error('Invalid base64 payload.')
  return Buffer.from(payload, 'base64').toString('utf8')
}

function response(socket: Socket, id: string, status: 'ok' | 'error', payload: string): void {
  if (socket.destroyed) return
  socket.write(`RES\t${PROTOCOL_VERSION}\t${id}\t${status}\t${encode(payload)}\n`)
}

function event(socket: Socket, id: string, name: string, payload: string): void {
  if (socket.destroyed) return
  socket.write(`EVT\t${PROTOCOL_VERSION}\t${id}\t${name}\t${encode(payload)}\n`)
}

async function prepareSocketDirectory(
  directory: string,
  isRuntimeDir: boolean
): Promise<void> {
  const uid = process.getuid?.() ?? 0
  if (isRuntimeDir) {
    const info = await lstat(directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== uid ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error('XDG_RUNTIME_DIR must be a private directory owned by this user.')
    }
    return
  }

  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) {
    throw new Error('The Deep Pink IPC directory must be a real directory owned by this user.')
  }
  await chmod(directory, 0o700)
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (!info.isSocket() || info.uid !== (process.getuid?.() ?? 0)) {
      throw new Error('Refusing to replace a non-socket or another user’s IPC path.')
    }
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function handleClient(socket: Socket, options: LocalIpcOptions): void {
  const requests = new Map<string, AbortController>()
  let pending = ''
  socket.setNoDelay(true)
  socket.on('error', () => undefined)
  clients.add(socket)
  options.onClientCountChange?.(clients.size)

  socket.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
        socket.destroy(new Error('IPC frame is too large.'))
        return
      }
      pending = pending.slice(newline + 1)
      if (line) void handleFrame(socket, line, requests, options)
      newline = pending.indexOf('\n')
    }
    if (Buffer.byteLength(pending, 'utf8') > MAX_FRAME_BYTES) {
      socket.destroy(new Error('IPC frame is too large.'))
    }
  })

  socket.on('close', () => {
    for (const controller of requests.values()) controller.abort()
    requests.clear()
    clients.delete(socket)
    options.onClientCountChange?.(clients.size)
  })
}

async function handleFrame(
  socket: Socket,
  line: string,
  requests: Map<string, AbortController>,
  options: LocalIpcOptions
): Promise<void> {
  const fields = line.split('\t')
  if (fields.length !== 5 || fields[0] !== 'REQ' || fields[1] !== PROTOCOL_VERSION) {
    socket.destroy(new Error('Invalid Deep Pink IPC frame.'))
    return
  }

  const [, , id, method, rawPayload] = fields
  if (!REQUEST_ID.test(id) || !/^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(method)) {
    socket.destroy(new Error('Invalid Deep Pink IPC request identifier or method.'))
    return
  }

  let payload: string
  try {
    payload = decode(rawPayload)
  } catch (error) {
    response(socket, id, 'error', error instanceof Error ? error.message : String(error))
    return
  }

  try {
    if (method === 'system.ping') {
      response(socket, id, 'ok', 'pong')
      return
    }

    if (method === 'app.openMain') {
      options.openMainWindow()
      response(socket, id, 'ok', 'opened')
      return
    }

    if (method === 'quickQuestion.cancel') {
      const target = payload.trim()
      const controller = requests.get(target)
      controller?.abort()
      response(socket, id, 'ok', controller ? 'cancelled' : 'not-running')
      return
    }

    if (method === 'quickQuestion.ask') {
      if (requests.has(id)) throw new Error('This request identifier is already active.')
      const controller = new AbortController()
      requests.set(id, controller)
      try {
        const answer = await askQuickQuestion(payload, controller.signal, (content) => {
          if (socket.destroyed || requests.get(id) !== controller) return
          event(socket, id, 'quickQuestion.content', content)
        })
        response(socket, id, 'ok', answer)
      } catch (error) {
        response(socket, id, 'error', error instanceof Error ? error.message : String(error))
      } finally {
        if (requests.get(id) === controller) requests.delete(id)
      }
      return
    }

    throw new Error(`Unknown Deep Pink IPC method: ${method}`)
  } catch (error) {
    response(socket, id, 'error', error instanceof Error ? error.message : String(error))
  }
}

export async function startLocalIpc(options: LocalIpcOptions): Promise<void> {
  if (process.platform !== 'linux') return
  if (server) return

  const location = localSocketPath()
  if (Buffer.byteLength(location.path, 'utf8') >= 104) {
    throw new Error('The Deep Pink IPC socket path is too long.')
  }
  await prepareSocketDirectory(location.directory, location.isRuntimeDir)
  await removeStaleSocket(location.path)

  const instance = createServer((socket) => handleClient(socket, options))
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    instance.once('error', onError)
    instance.listen(location.path, () => {
      instance.removeListener('error', onError)
      instance.on('error', (error) => console.error('Deep Pink IPC socket error:', error))
      resolve()
    })
  })
  try {
    await chmod(location.path, 0o600)
  } catch (error) {
    const closed = new Promise<void>((resolve) => instance.close(() => resolve()))
    for (const socket of clients) socket.destroy()
    await closed
    await unlink(location.path).catch(() => undefined)
    throw error
  }
  server = instance
  socketPath = location.path
}

export async function stopLocalIpc(): Promise<void> {
  const instance = server
  const path = socketPath
  server = null
  socketPath = null
  if (!instance) return

  const closed = new Promise<void>((resolve) => instance.close(() => resolve()))
  for (const socket of clients) socket.destroy()
  // before-quit is not cancellable here, so remove the filesystem entry before
  // awaiting socket closure. A hard app exit must not leave a stale endpoint.
  if (path) {
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await closed
}
