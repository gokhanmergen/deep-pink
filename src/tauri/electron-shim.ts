import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

type Handler = (event: unknown, ...args: any[]) => unknown
const handlers = new Map<string, Handler>()
const eventClients = new Set<ServerResponse<IncomingMessage>>()
const activeInvocations = new Set<Promise<unknown>>()
let acceptingInvocations = true

export const ipcMain = {
  handle(channel: string, handler: Handler): void {
    handlers.set(channel, handler)
  }
}

export async function invoke(channel: string, args: unknown[]): Promise<unknown> {
  if (!acceptingInvocations) throw new Error('The local app service is shutting down')
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No backend handler for ${channel}`)
  const pending = Promise.resolve(handler({ sender: {} }, ...args))
  activeInvocations.add(pending)
  try {
    return await pending
  } finally {
    activeInvocations.delete(pending)
  }
}

export async function drainInvocations(): Promise<void> {
  acceptingInvocations = false
  while (activeInvocations.size) {
    await Promise.allSettled([...activeInvocations])
  }
}

export function send(channel: string, payload: unknown): void {
  const data = JSON.stringify({ channel, payload })
  for (const client of eventClients) {
    try {
      client.write(`event: message\ndata: ${data}\n\n`)
    } catch {
      eventClients.delete(client)
    }
  }
}

export function addEventClient(response: ServerResponse<IncomingMessage>): void {
  eventClients.add(response)
  response.on('close', () => eventClients.delete(response))
}

export function closeEventClients(): void {
  for (const client of eventClients) {
    try {
      client.end()
    } catch {
      eventClients.delete(client)
    }
  }
  eventClients.clear()
}

function userDataPath(): string {
  const path = process.env.DEEP_PINK_USER_DATA_DIR
  if (!path) throw new Error('Tauri did not provide the application data directory')
  return path
}

export const app = {
  getPath(name: string): string {
    if (name === 'userData') return userDataPath()
    if (name === 'downloads') return process.env.DEEP_PINK_DOWNLOADS_DIR || userDataPath()
    if (name === 'home') return process.env.HOME || process.cwd()
    return userDataPath()
  },
  getVersion(): string {
    return process.env.DEEP_PINK_VERSION || '0.0.0'
  },
  getName(): string {
    return 'Deep Pink'
  },
  getLocale(): string {
    return Intl.DateTimeFormat().resolvedOptions().locale
  },
  getAppPath(): string {
    return process.resourcesPath || process.cwd()
  },
  get isPackaged(): boolean {
    return process.env.DEEP_PINK_PACKAGED === '1'
  }
}

export const BrowserWindow = {
  getAllWindows(): Array<{ isDestroyed: () => boolean; webContents: { send: typeof send } }> {
    return [
      {
        isDestroyed: () => false,
        webContents: { send }
      }
    ]
  },
  fromWebContents(): { isDestroyed: () => boolean; webContents: { send: typeof send } } | undefined {
    return this.getAllWindows()[0]
  }
}

export const protocol = {
  registerSchemesAsPrivileged(): void {},
  handle(): void {}
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return Buffer.from(process.env.DEEP_PINK_STORAGE_KEY ?? '', 'hex').length === 32
  },
  encryptString(value: string): Buffer {
    const key = Buffer.from(process.env.DEEP_PINK_STORAGE_KEY ?? '', 'hex')
    if (key.length !== 32) throw new Error('The OS credential store is unavailable')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from('DPS1'), iv, cipher.getAuthTag(), encrypted])
  },
  decryptString(value: Buffer): string {
    if (value.length < 32 || value.subarray(0, 4).toString('ascii') !== 'DPS1') {
      throw new Error('This secret was encrypted by another desktop runtime')
    }
    const key = Buffer.from(process.env.DEEP_PINK_STORAGE_KEY ?? '', 'hex')
    if (key.length !== 32) throw new Error('The OS credential store is unavailable')
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(4, 16))
    decipher.setAuthTag(value.subarray(16, 32))
    return Buffer.concat([decipher.update(value.subarray(32)), decipher.final()]).toString('utf8')
  }
}

export const dialog = {
  async showOpenDialog(): Promise<{ canceled: true; filePaths: [] }> {
    return { canceled: true, filePaths: [] }
  },
  async showSaveDialog(): Promise<{ canceled: true; filePath: undefined }> {
    return { canceled: true, filePath: undefined }
  }
}

function openWithSystem(path: string): Promise<void> {
  const platform = process.platform
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', path] : [path]
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => (error ? reject(error) : resolve()))
  })
}

export const shell = {
  openPath(path: string): Promise<string> {
    return openWithSystem(path).then(() => '')
  },
  openExternal(url: string): Promise<void> {
    return openWithSystem(url)
  },
  showItemInFolder(path: string): Promise<void> {
    return openWithSystem(dirname(path))
  }
}

export const clipboard = {
  writeImage(): void {
    // Tauri handles clipboard writes in the renderer using its native plugin.
  }
}

function imageSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16)
    if (kind === 'VP8X') {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3)
      }
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      return {
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10)
      }
    }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break
      const marker = bytes[offset + 1]
      const length = bytes.readUInt16BE(offset + 2)
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
  }
  return { width: 0, height: 0 }
}

export const nativeImage = {
  createFromBuffer(value: Buffer): { getSize: () => { width: number; height: number }; isEmpty: () => boolean } {
    const size = imageSize(value)
    return { getSize: () => size, isEmpty: () => !size.width || !size.height }
  },
  createFromPath(path: string): { isEmpty: () => boolean } {
    try {
      const size = imageSize(readFileSync(path))
      return { isEmpty: () => !size.width || !size.height }
    } catch {
      return { isEmpty: () => true }
    }
  }
}
