import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import type {
  ExportFormat,
  SyncConfig,
  Folder,
  McpServerConfig,
  Message,
  SendMessageRequest,
  Settings,
  SettingsPatch,
  StreamEvent,
  Thread,
  ThreadConfig
} from '@shared/types'
import * as repo from './db/repo'
import { dbPath } from './db/index'
import * as mcp from './mcp/host'
import * as attachments from './attachments'
import * as importer from './import/index'
import * as exporter from './export/index'
import * as sync from './sync/engine'
import { ensureTree } from './tools/repoService'
import * as engine from './chat/engine'
import { assembleContext } from './chat/prompt'
import { getCredits, listEndpoints, listModels } from './providers/openrouter'
import { loadSettings, saveSettings } from './settings'
import { isEncryptionAvailable, setApiKey } from './secrets'

const CHAT_EVENT = 'chat:event'
const MCP_STATUS_EVENT = 'mcp:status'
const SYNC_EVENT = 'sync:event'
const SYNC_PROGRESS = 'sync:progress'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

const emit = (event: StreamEvent): void => broadcast(CHAT_EVENT, event)

/**
 * Names anything still unnamed — because the app was closed mid-reply, or the
 * request that would have named it failed and the thread was never returned to.
 *
 * Runs after the window is up so it never delays first paint; each name lands
 * in the list through the same event a name generated mid-conversation does.
 */
export async function nameUnnamedThreads(): Promise<void> {
  try {
    const named = await engine.nameUntitledThreads(emit)
    if (named) console.log(`Named ${named} thread(s) that had gone unnamed.`)
  } catch {
    /* naming is a convenience; never let it take the start-up with it */
  }
}

/**
 * Syncing on its own, which is the only way it is any use.
 *
 * A run happens shortly after anything changes, on a slow timer for whatever
 * changed on another machine, and once at start-up. Debounced rather than
 * immediate: a reply streaming in changes its row on every chunk, and syncing
 * each of those would be a request per token.
 */
const SYNC_INTERVAL_MS = 5 * 60 * 1000
const SYNC_DEBOUNCE_MS = 8000

let syncTimer: ReturnType<typeof setTimeout> | null = null
let syncInterval: ReturnType<typeof setInterval> | null = null

async function runSync(automatic = false): Promise<import('@shared/types').SyncResult> {
  const before = repo.listThreads(true).length

  // Say it has started before the first request goes out, so the indicator
  // moves on the click rather than after the round trip.
  broadcast(SYNC_EVENT, sync.state())

  // Throttled: a first sync is one of these per object, and a window redrawing
  // a progress bar ten thousand times is slower than the upload.
  let lastSent = 0
  const result = await sync.run({
    automatic,
    onProgress: (progress) => {
      const now = Date.now()
      const milestone = progress.phase === 'done' || progress.phase === 'error'
      if (!milestone && now - lastSent < 90) return
      lastSent = now
      broadcast(SYNC_PROGRESS, progress)
    }
  })

  broadcast(SYNC_EVENT, sync.state())
  // Something arrived: the window is showing a list that is now out of date.
  if (result.pulled > 0 || result.deleted > 0 || before !== repo.listThreads(true).length) {
    broadcast('sync:changed', null)
  }
  return result
}

/** Whether the timer should be doing anything at all right now. */
function syncWanted(): boolean {
  const state = sync.state()
  return state.ready && state.config.enabled && !state.paused
}

/** Asks for a sync in a moment, collapsing a burst of changes into one. */
export function syncSoon(delay = SYNC_DEBOUNCE_MS): void {
  if (!syncWanted()) return
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    // Checked again on the way out: the pause may have arrived while waiting.
    if (syncWanted()) void runSync(true)
  }, delay)
}

/** Starts the background loop. Called once the window is up. */
export function startSync(): void {
  if (syncInterval) return
  syncInterval = setInterval(() => {
    if (syncWanted()) void runSync(true)
  }, SYNC_INTERVAL_MS)
  syncSoon(4000)
}

export function registerIpc(): void {
  mcp.setStatusListener(() => broadcast(MCP_STATUS_EVENT, mcp.getStatuses()))

  /* ---------------- settings ---------------- */

  ipcMain.handle('settings:get', (): Settings => loadSettings())

  ipcMain.handle('settings:save', (_e, patch: SettingsPatch): Settings => {
    const next = saveSettings(patch)
    syncSoon()
    return next
  })

  ipcMain.handle('settings:setApiKey', (_e, key: string): Settings => {
    setApiKey(key)
    return loadSettings()
  })

  ipcMain.handle('settings:encryptionAvailable', (): boolean => isEncryptionAvailable())

  /* ---------------- models ---------------- */

  ipcMain.handle('models:list', (_e, force = false) => listModels(force))
  ipcMain.handle('models:endpoints', (_e, modelId: string, force = false) =>
    listEndpoints(modelId, force)
  )

  /* ---------------- threads ---------------- */

  ipcMain.handle('threads:list', (_e, includeArchived = false): Thread[] =>
    repo.listThreads(includeArchived)
  )
  ipcMain.handle('threads:get', (_e, id: string) => repo.getThread(id))
  ipcMain.handle('threads:create', (_e, config?: Partial<ThreadConfig>) =>
    repo.createThread('', config)
  )
  ipcMain.handle(
    'threads:update',
    (
      _e,
      id: string,
      patch: Partial<Pick<Thread, 'title' | 'pinned' | 'archived'>> & {
        config?: Partial<ThreadConfig>
      }
    ) => {
      const next = repo.updateThread(id, patch)
      syncSoon()
      return next
    }
  )
  ipcMain.handle('threads:delete', (_e, id: string) => {
    engine.abortThread(id)
    repo.deleteThread(id)
    syncSoon()
  })
  ipcMain.handle('threads:branch', (_e, id: string, messageId: string) => {
    const branched = repo.branchThread(id, messageId)
    syncSoon()
    return branched
  })
  // Filing a thread is its own call rather than part of `threads:update`, which
  // would stamp it as edited and reorder the list under the cursor.
  ipcMain.handle('threads:setFolder', (_e, id: string, folderId: string | null) => {
    const filed = repo.setThreadFolder(id, folderId)
    syncSoon()
    return filed
  })

  /* ---------------- folders ---------------- */

  ipcMain.handle('folders:list', (): Folder[] => repo.listFolders())
  ipcMain.handle('folders:create', (_e, name: string) => {
    const folder = repo.createFolder(name)
    syncSoon()
    return folder
  })
  ipcMain.handle('folders:update', (_e, id: string, patch: { name?: string; pinned?: boolean }) => {
    const folder = repo.updateFolder(id, patch)
    syncSoon()
    return folder
  })
  ipcMain.handle('folders:delete', (_e, id: string) => {
    repo.deleteFolder(id)
    syncSoon()
  })

  /* ---------------- messages ---------------- */

  ipcMain.handle('messages:list', (_e, threadId: string, includeCompacted = false): Message[] =>
    repo.getMessages(threadId, includeCompacted)
  )
  ipcMain.handle('messages:delete', (_e, id: string) => {
    repo.deleteMessage(id)
    syncSoon()
  })
  ipcMain.handle('messages:deleteAfter', (_e, threadId: string, messageId: string) => {
    repo.deleteMessagesAfter(threadId, messageId)
    syncSoon()
  })
  ipcMain.handle('messages:update', (_e, id: string, patch: Partial<Message>) => {
    const next = repo.updateMessage(id, patch)
    syncSoon()
    return next
  })

  /* ---------------- chat ---------------- */

  ipcMain.handle('chat:send', async (_e, req: SendMessageRequest) => {
    try {
      await engine.sendMessage(req, emit)
      // A finished turn is the moment a conversation is worth carrying.
      syncSoon()
    } catch (err) {
      emit({
        type: 'error',
        messageId: '',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  ipcMain.handle('chat:abort', (_e, threadId: string) => engine.abortThread(threadId))
  ipcMain.handle('chat:isGenerating', (_e, threadId: string) => engine.isGenerating(threadId))
  ipcMain.handle('chat:approveTool', (_e, toolCallId: string, approved: boolean) =>
    engine.resolveToolApproval(toolCallId, approved)
  )
  // What a reply has streamed so far, for a window that was not watching.
  ipcMain.handle('chat:liveStreams', (_e, threadId: string) => engine.liveStreamsFor(threadId))

  ipcMain.handle('chat:retitle', (_e, threadId: string) => engine.retitle(threadId, emit))
  ipcMain.handle('chat:compact', (_e, threadId: string) => engine.compactThread(threadId, emit))
  ipcMain.handle('chat:compactionStatus', async (_e, threadId: string) => {
    const thread = repo.getThread(threadId)
    if (!thread) return { needed: false, used: 0, limit: null }
    return engine.shouldCompact(thread, loadSettings())
  })

  /* ---------------- system prompt transparency ---------------- */

  ipcMain.handle('prompt:preview', (_e, threadId: string) => {
    const thread = repo.getThread(threadId)
    if (!thread) return null
    const context = assembleContext(thread, loadSettings())
    return {
      segments: context.segments,
      systemText: context.systemText,
      estimatedTokens: context.estimatedTokens,
      toolCount: context.tools.length
    }
  })

  /* ---------------- search ---------------- */

  ipcMain.handle('search:query', (_e, query: string, limit = 50) => repo.search(query, limit))

  /* ---------------- statistics ---------------- */

  ipcMain.handle('stats:thread', async (_e, threadId: string) => {
    const thread = repo.getThread(threadId)
    const settings = loadSettings()
    const model = thread ? engine.resolveModel(thread, settings) : settings.defaultModel
    const limit = await engine.contextLimitFor(model)
    return repo.getThreadStats(threadId, limit)
  })

  ipcMain.handle('stats:global', () => repo.getGlobalStats())

  ipcMain.handle('stats:credits', () => getCredits(loadSettings().sendAppAttribution))

  /* ---------------- MCP ---------------- */

  ipcMain.handle('mcp:statuses', () => mcp.getStatuses())
  ipcMain.handle('mcp:configs', () => mcp.getConfigs())
  ipcMain.handle('mcp:create', (_e, input: Partial<McpServerConfig>) => {
    const server = mcp.createServer(input)
    syncSoon()
    return server
  })
  ipcMain.handle('mcp:update', async (_e, id: string, patch: Partial<McpServerConfig>) => {
    const server = await mcp.updateServer(id, patch)
    syncSoon()
    return server
  })
  ipcMain.handle('mcp:delete', async (_e, id: string) => {
    await mcp.removeServer(id)
    syncSoon()
  })
  ipcMain.handle('mcp:connect', (_e, id: string) => mcp.connect(id))
  ipcMain.handle('mcp:disconnect', (_e, id: string) => mcp.disconnect(id))

  /* ---------------- data ---------------- */

  ipcMain.handle('data:path', () => dbPath())
  ipcMain.handle('data:reveal', () => shell.showItemInFolder(dbPath()))
  ipcMain.handle('data:wipe', () => repo.wipeAllData())
  /**
   * Writes a thread to a file the user chooses.
   *
   * The save dialog is here rather than a download in the renderer because a
   * download lands wherever Chromium decides, with no say from anyone; this
   * asks, and returns where it went so the app can say so.
   */
  ipcMain.handle(
    'data:exportThread',
    async (event, threadId: string, format: ExportFormat): Promise<string | null> => {
      const file = exporter.fileFor(threadId, format, __APP_VERSION__)
      if (!file) return null

      const window = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showSaveDialog(window ?? BrowserWindow.getAllWindows()[0], {
        title: format === 'markdown' ? 'Export as Markdown' : 'Export thread',
        defaultPath: join(app.getPath('downloads'), file.filename),
        filters:
          format === 'markdown'
            ? [{ name: 'Markdown', extensions: ['md'] }]
            : [{ name: 'Deep Pink thread', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) return null

      exporter.write(result.filePath, file.contents)
      return result.filePath
    }
  )

  /* ---------------- about ---------------- */

  // Read from Electron rather than written down anywhere, so a release cannot
  // ship an About box claiming the wrong version.
  ipcMain.handle('app:info', () => ({
    version: __APP_VERSION__,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  }))

  /* ---------------- attached repositories ---------------- */

  ipcMain.handle('repo:choose', async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window ?? BrowserWindow.getAllWindows()[0], {
      title: 'Attach a code repository',
      message: 'The model can read this directory and everything under it. It cannot change anything.',
      buttonLabel: 'Attach',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // Directories get moved and deleted; the composer shows which are still there.
  ipcMain.handle('repo:status', (_e, paths: string[]) => {
    // Attaching one is the moment to start reading its layout, so the first
    // turn does not have to wait for it.
    if (paths.length) void ensureTree(paths)
    return paths.map((path) => {
      let available = false
      try {
        available = statSync(path).isDirectory()
      } catch {
        available = false
      }
      return { path, name: basename(path), available }
    })
  })

  /* ---------------- import ---------------- */

  ipcMain.handle('import:choose', async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window ?? BrowserWindow.getAllWindows()[0], {
      title: 'Import conversations',
      message: 'A ChatGPT export, or a thread exported from Deep Pink',
      properties: ['openFile'],
      filters: [
        { name: 'Conversations', extensions: ['zip', 'json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  /**
   * Which models this account can actually reach, so an import can say when a
   * thread names one it cannot. Null when the catalogue could not be fetched —
   * an import must not fail, or lie, because the network is down.
   */
  async function knownModels(): Promise<Set<string> | null> {
    try {
      return new Set((await listModels()).map((model) => model.id))
    } catch {
      return null
    }
  }

  ipcMain.handle('import:preview', async (_e, path: string) =>
    importer.preview(path, await knownModels())
  )
  ipcMain.handle('import:run', async (_e, path: string) => {
    const result = await importer.importFile(path, await knownModels())
    // A library that has just arrived is the biggest thing sync will ever be
    // asked to carry; there is no reason to make it wait for the slow timer.
    syncSoon()
    return result
  })

  /* ---------------- sync ---------------- */

  ipcMain.handle('sync:state', () => sync.state())

  ipcMain.handle('sync:save', (_e, patch: Partial<SyncConfig>) => {
    const next = sync.saveConfig(patch)
    // Turning it on is a reason to sync; so is pointing it at a new bucket.
    if (next.ready && next.config.enabled) syncSoon(1500)
    return next
  })

  ipcMain.handle('sync:createKey', () => sync.createKey())
  ipcMain.handle('sync:importKey', (_e, text: string) => {
    sync.importKey(text)
    return sync.state()
  })
  ipcMain.handle('sync:revealKey', () => sync.revealKey())
  ipcMain.handle('sync:setSecret', (_e, secret: string) => {
    sync.setS3Secret(secret)
    return sync.state()
  })
  ipcMain.handle('sync:pause', (_e, until: number | null) => {
    const next = sync.pause(until)
    // Nothing queued should fire after this; anything running is stopping.
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = null
    broadcast(SYNC_EVENT, next)
    return next
  })

  ipcMain.handle('sync:resume', () => {
    const next = sync.resume()
    broadcast(SYNC_EVENT, next)
    if (next.ready && next.config.enabled) syncSoon(1000)
    return next
  })

  ipcMain.handle('sync:disconnect', () => sync.disconnect())
  ipcMain.handle('sync:test', () => sync.testConnection())
  ipcMain.handle('sync:run', () => runSync())

  /* ---------------- window ---------------- */

  // Chromium's own zoom, which scales the whole interface rather than only text.
  // Each step multiplies by 1.2, and the range keeps it legible at both ends.
  const ZOOM_STEP = 0.5
  const ZOOM_MIN = -3
  const ZOOM_MAX = 4

  ipcMain.handle('window:zoom', (event, direction: 'in' | 'out' | 'reset'): number => {
    const contents = event.sender
    const current = contents.getZoomLevel()

    const next =
      direction === 'reset'
        ? 0
        : Math.min(
            Math.max(current + (direction === 'in' ? ZOOM_STEP : -ZOOM_STEP), ZOOM_MIN),
            ZOOM_MAX
          )

    contents.setZoomLevel(next)
    // Remember it, so the window comes back the size the user left it.
    saveSettings({ ui: { zoomLevel: next } })
    return next
  })

  // Opens an image the user attached themselves, in whatever their desktop uses
  // for images. Resolved from the database, so only stored attachments are
  // reachable — a path never comes from the renderer.
  ipcMain.handle('attachments:open', async (_e, id: string) => {
    const path = attachments.filePath(id)
    if (!path) return
    await shell.openPath(path)
  })

  // Full text of a text attachment, fetched only when the reader expands it.
  ipcMain.handle('attachments:text', (_e, id: string) => attachments.readText(id))

  /**
   * Saves a copy of an attachment wherever the user says.
   *
   * The renderer passes an id, never a path: the only file this can read is one
   * the app already stored, and the only one it can write is the one chosen in
   * the dialog below.
   */
  ipcMain.handle(
    'attachments:save',
    async (event, id: string): Promise<string | null> => {
      const source = attachments.filePath(id)
      if (!source) return null

      const window = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showSaveDialog(window ?? BrowserWindow.getAllWindows()[0], {
        title: 'Save image',
        defaultPath: join(app.getPath('downloads'), attachments.nameOf(id) || basename(source))
      })
      if (result.canceled || !result.filePath) return null

      return attachments.copyTo(id, result.filePath) ? result.filePath : null
    }
  )

  // Onto the system clipboard as an image, so it can be pasted into anything
  // that takes one rather than only into a file manager.
  ipcMain.handle('attachments:copy', (_e, id: string): boolean => {
    const path = attachments.filePath(id)
    if (!path) return false
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    return shell.openExternal(url)
  })
}
