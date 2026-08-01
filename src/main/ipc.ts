import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
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
import { ensureTree } from './tools/repoService'
import * as engine from './chat/engine'
import { assembleContext } from './chat/prompt'
import { getCredits, listEndpoints, listModels } from './providers/openrouter'
import { loadSettings, saveSettings } from './settings'
import { isEncryptionAvailable, setApiKey } from './secrets'

const CHAT_EVENT = 'chat:event'
const MCP_STATUS_EVENT = 'mcp:status'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

const emit = (event: StreamEvent): void => broadcast(CHAT_EVENT, event)

export function registerIpc(): void {
  mcp.setStatusListener(() => broadcast(MCP_STATUS_EVENT, mcp.getStatuses()))

  /* ---------------- settings ---------------- */

  ipcMain.handle('settings:get', (): Settings => loadSettings())

  ipcMain.handle('settings:save', (_e, patch: SettingsPatch): Settings => saveSettings(patch))

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
    ) => repo.updateThread(id, patch)
  )
  ipcMain.handle('threads:delete', (_e, id: string) => {
    engine.abortThread(id)
    repo.deleteThread(id)
  })
  ipcMain.handle('threads:branch', (_e, id: string, messageId: string) =>
    repo.branchThread(id, messageId)
  )

  /* ---------------- messages ---------------- */

  ipcMain.handle('messages:list', (_e, threadId: string, includeCompacted = false): Message[] =>
    repo.getMessages(threadId, includeCompacted)
  )
  ipcMain.handle('messages:delete', (_e, id: string) => repo.deleteMessage(id))
  ipcMain.handle('messages:deleteAfter', (_e, threadId: string, messageId: string) =>
    repo.deleteMessagesAfter(threadId, messageId)
  )
  ipcMain.handle('messages:update', (_e, id: string, patch: Partial<Message>) =>
    repo.updateMessage(id, patch)
  )

  /* ---------------- chat ---------------- */

  ipcMain.handle('chat:send', async (_e, req: SendMessageRequest) => {
    try {
      await engine.sendMessage(req, emit)
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
  ipcMain.handle('mcp:create', (_e, input: Partial<McpServerConfig>) => mcp.createServer(input))
  ipcMain.handle('mcp:update', (_e, id: string, patch: Partial<McpServerConfig>) =>
    mcp.updateServer(id, patch)
  )
  ipcMain.handle('mcp:delete', (_e, id: string) => mcp.removeServer(id))
  ipcMain.handle('mcp:connect', (_e, id: string) => mcp.connect(id))
  ipcMain.handle('mcp:disconnect', (_e, id: string) => mcp.disconnect(id))

  /* ---------------- data ---------------- */

  ipcMain.handle('data:path', () => dbPath())
  ipcMain.handle('data:reveal', () => shell.showItemInFolder(dbPath()))
  ipcMain.handle('data:wipe', () => repo.wipeAllData())
  ipcMain.handle('data:exportThread', (_e, threadId: string) => {
    const thread = repo.getThread(threadId)
    if (!thread) return null
    return {
      thread,
      messages: repo.getMessages(threadId, true),
      exportedAt: new Date().toISOString()
    }
  })

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
      title: 'Choose a ChatGPT export',
      message: 'Select the .zip you downloaded, or conversations.json from inside it',
      properties: ['openFile'],
      filters: [
        { name: 'ChatGPT export', extensions: ['zip', 'json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('import:preview', (_e, path: string) => importer.preview(path))
  ipcMain.handle('import:run', (_e, path: string) => importer.importFile(path))

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

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    return shell.openExternal(url)
  })
}
