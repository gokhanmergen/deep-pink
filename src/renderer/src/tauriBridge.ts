import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open, save } from '@tauri-apps/plugin-dialog'
import { writeImage } from '@tauri-apps/plugin-clipboard-manager'
import { openPath, openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { downloadDir, join } from '@tauri-apps/api/path'
import { createDeepPinkApi } from '../../preload/api'
import type { ExportFormat } from '@shared/types'

interface RuntimeConfig {
  url: string
  token: string
  platform: string
}

type ApiListener = (...args: any[]) => void
const unlistenByHandler = new Map<ApiListener, () => void>()
const listeners = new Map<string, Set<(payload: unknown) => void>>()
let eventsPromise: Promise<void> | null = null
let config: RuntimeConfig

function backendUrl(path: string): string {
  return `${config.url}${path}`
}

async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('X-DeepPink-Token', config.token)
  return fetch(backendUrl(path), { ...init, headers })
}

async function waitForBackend(runtime: RuntimeConfig): Promise<void> {
  config = runtime
  let lastError: unknown
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await backendFetch('/health')
      if (response.ok) return
      lastError = new Error(`Backend responded with ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The local app service did not start: ${String(lastError ?? 'no response')}`)
}

async function startEvents(): Promise<void> {
  if (eventsPromise) return eventsPromise
  eventsPromise = (async () => {
    let delay = 500
    while (true) {
      try {
        const response = await backendFetch('/events')
        if (!response.ok || !response.body) throw new Error(`Event stream returned ${response.status}`)
        delay = 500
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const message = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = message
              .split(/\r?\n/)
              .find((line) => line.startsWith('data:'))
              ?.slice(5)
              .trim()
            if (data) {
              try {
                const event = JSON.parse(data) as { channel: string; payload: unknown }
                for (const listener of listeners.get(event.channel) ?? []) listener(event.payload)
              } catch (error) {
                console.error('Could not read a backend event', error)
              }
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch (error) {
        console.error('The local app event stream disconnected', error)
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 5000)
    }
  })()
  return eventsPromise
}

function subscribe(channel: string, listener: (payload: unknown) => void): () => void {
  const channelListeners = listeners.get(channel) ?? new Set()
  channelListeners.add(listener)
  listeners.set(channel, channelListeners)
  void startEvents()
  return () => {
    channelListeners.delete(listener)
    if (!channelListeners.size) listeners.delete(channel)
  }
}

async function invokeBackend<T>(channel: string, args: unknown[]): Promise<T> {
  const response = await backendFetch('/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args })
  })
  const body = (await response.json()) as { value?: T; error?: string }
  if (!response.ok) throw new Error(body.error ?? `Backend call failed (${response.status})`)
  return body.value as T
}

async function invokeNative(channel: string, args: unknown[]): Promise<unknown> {
  if (channel === 'repo:choose') {
    return open({
      title: 'Attach a code repository',
      directory: true,
      multiple: false
    })
  }

  if (channel === 'import:choose') {
    return open({
      title: 'Import conversations',
      multiple: false,
      filters: [
        { name: 'Conversations', extensions: ['zip', 'json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
  }

  if (channel === 'data:reveal') {
    const path = await invokeBackend<string>('data:path', [])
    await revealItemInDir(path)
    return
  }

  if (channel === 'data:exportThread') {
    const [threadId, format] = args as [string, ExportFormat]
    const file = await invokeBackend<{ filename: string; contents: string } | null>(
      'tauri:exportFile',
      [threadId, format]
    )
    if (!file) return null
    const filter = format === 'markdown'
      ? [{ name: 'Markdown', extensions: ['md'] }]
      : [{ name: 'Deep Pink thread', extensions: ['json'] }]
    const path = await save({
      title: format === 'markdown' ? 'Export as Markdown' : 'Export thread',
      defaultPath: await join(await downloadDir(), file.filename),
      filters: filter
    })
    if (!path) return null
    await invokeBackend('tauri:writeExport', [path, file.contents])
    return path
  }

  if (channel === 'attachments:save') {
    const [id] = args as [string]
    const source = await invokeBackend<string | null>('tauri:attachmentPath', [id])
    if (!source) return null
    const filename = await invokeBackend<string | null>('tauri:attachmentName', [id])
    const path = await save({
      title: 'Save image',
      defaultPath: await join(await downloadDir(), filename || source.split(/[\\/]/).pop() || 'image'),
      filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    })
    if (!path) return null
    return (await invokeBackend<boolean>('tauri:attachmentCopyTo', [id, path])) ? path : null
  }

  if (channel === 'attachments:open') {
    const [id] = args as [string]
    const path = await invokeBackend<string | null>('tauri:attachmentPath', [id])
    if (path) await openPath(path)
    return
  }

  if (channel === 'attachments:copy') {
    const [id] = args as [string]
    const image = await invokeBackend<{ mime: string; data: string } | null>(
      'tauri:attachmentClipboard',
      [id]
    )
    if (!image) return false
    const binary = atob(image.data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    await writeImage(bytes)
    return true
  }

  if (channel === 'shell:openExternal') {
    const [value] = args as [string]
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    await openUrl(url.href)
    return
  }

  if (channel === 'window:zoom') {
    const [direction] = args as ['in' | 'out' | 'reset']
    const settings = await invokeBackend<{ ui: { zoomLevel: number } }>('settings:get', [])
    const current = settings.ui.zoomLevel ?? 0
    const next = direction === 'reset' ? 0 : Math.min(Math.max(current + (direction === 'in' ? 0.5 : -0.5), -3), 4)
    document.documentElement.style.zoom = String(Math.pow(1.2, next))
    await invokeBackend('settings:save', [{ ui: { zoomLevel: next } }])
    return next
  }

  return invokeBackend(channel, args)
}

async function announceWindowState(): Promise<void> {
  const current = getCurrentWindow()
  const [fullscreen, maximized] = await Promise.all([current.isFullscreen(), current.isMaximized()])
  for (const listener of listeners.get('window:state') ?? []) {
    listener({ fullscreen, maximized })
  }
}

export async function installTauriBridge(): Promise<void> {
  const runtime = await tauriInvoke<RuntimeConfig>('backend_config')
  await waitForBackend(runtime)
  void startEvents()

  const api = createDeepPinkApi(
    {
      invoke: (channel, ...args) => invokeNative(channel, args),
      on: (channel, handler) => {
        const unsubscribe = subscribe(channel, (payload) => handler(undefined, payload))
        unlistenByHandler.set(handler, unsubscribe)
        if (channel === 'window:state') void announceWindowState()
      },
      removeListener: (_channel, handler) => {
        unlistenByHandler.get(handler)?.()
        unlistenByHandler.delete(handler)
      }
    },
    runtime.platform,
    false
  )
  Object.defineProperty(window, 'deepPink', { configurable: false, value: api })

  try {
    const settings = await invokeBackend<{ ui: { zoomLevel: number } }>('settings:get', [])
    document.documentElement.style.zoom = String(Math.pow(1.2, settings.ui.zoomLevel ?? 0))
  } catch (error) {
    console.error('Could not restore the window zoom level', error)
  }

  const current = getCurrentWindow()
  await current.onResized(() => void announceWindowState())
  await current.onMoved(() => void announceWindowState())
}
