import { join } from 'node:path'
import { BrowserWindow, app, shell } from 'electron'
import { closeDb, getDb } from './db/index'
import { deleteEmptyThreads, deleteTemporaryThreads, reconcileInterruptedMessages } from './db/repo'
import { loadSettings } from './settings'
import { registerIpc, startNaming, startSync, startUpdateChecks } from './ipc'
import * as attachments from './attachments'
import { shutdownRepoWorker } from './tools/repoService'
import * as mcp from './mcp/host'
import { reportUncaught } from './report'

/*
 * Before anything that can fail.
 *
 * A throw nobody caught used to be a stack trace on a stream nobody running
 * the packaged app is reading, and an unhandled rejection is, in current
 * Node, a process that stops there. Either way the window's account of what
 * happened was that nothing did. See `reportProblem`.
 */
reportUncaught()

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let backgroundTasksStarted = false
let canOpenWindows = false

function startBackgroundTasks(): void {
  if (backgroundTasksStarted) return
  backgroundTasksStarted = true
  if (!loadSettings().hideExperimental) mcp.connectAll().catch(() => undefined)
  startNaming()
  startUpdateChecks()
  startSync()
}

function createWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    // Packaged builds get their icon from the bundle or the .desktop entry;
    // this is what gives the window one while developing on Linux.
    ...(process.platform === 'linux' ? { icon: join(__dirname, '../../build/icon.png') } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  })
  mainWindow = win

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })

  // The renderer switches its draggable regions off in fullscreen, so it needs
  // to know. `maximize` is reported too because tiling compositors use it.
  const reportState = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send('window:state', {
      fullscreen: win.isFullScreen(),
      maximized: win.isMaximized()
    })
  }
  win.on('enter-full-screen', reportState)
  win.on('leave-full-screen', reportState)
  win.on('maximize', reportState)
  win.on('unmaximize', reportState)
  win.webContents.on('did-finish-load', () => {
    reportState()
    // Restore the zoom the user left the app at. This has to happen after load,
    // because Chromium resets the level for each new page.
    const { zoomLevel } = loadSettings().ui
    if (zoomLevel !== 0) win.webContents.setZoomLevel(zoomLevel)
  })

  // Links always open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  /*
   * Shown as soon as it is loading, not when it is ready.
   *
   * `ready-to-show` is the usual advice and it was costing the whole of
   * startup. It waits for a first paint, an empty `#root` gives Chromium
   * nothing to paint, and so the window stayed hidden until React had
   * mounted — the entire renderer bundle parsed and executed. Measured on a
   * real library (2026-09-21): 216ms to get this far and then 1,761ms of
   * nothing on screen. `dom-ready` is no better, because a module script is
   * deferred and the DOM is not called ready until it has run.
   *
   * So the visible main window is shown at once. It is not empty when it arrives:
   * `backgroundColor` paints immediately, and `index.html` carries a static
   * skeleton of the app's own chrome that the HTML parser puts up without
   * waiting for any script. What the reader sees is the app appearing in a
   * quarter of a second and filling in, rather than a quarter of a second of
   * nothing followed by two seconds more of it.
   */
  win.show()

  return win
}

function openMainWindow(): void {
  startBackgroundTasks()
  const win = createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// Must happen before the app is ready: Chromium decides how to treat a custom
// scheme at startup, and attachments are served over one.
attachments.registerScheme()

// One database, one writer. Two copies of the app on the same profile interleave
// their writes, which shows up as messages from one appearing mid-conversation
// in the other.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  if (!canOpenWindows) return
  openMainWindow()
})

app.whenReady().then(() => {
  // Open the database first — everything else assumes migrations have run.
  getDb()

  // Clear up anything a previous run left mid-flight before the UI reads it.
  const { removed, settled } = reconcileInterruptedMessages()
  if (removed || settled) {
    console.log(
      `Recovered from an interrupted session: removed ${removed} empty ${
        removed === 1 ? 'reply' : 'replies'
      }, settled ${settled}.`
    )
  }

  // Before the window, not after: the renderer reads the thread list as it
  // starts, and a thread swept away underneath it would sit in the sidebar
  // until something else refreshed. One statement, so nothing is waiting on it.
  const emptied = deleteEmptyThreads()
  if (emptied) console.log(`Removed ${emptied} empty thread(s) left open.`)

  // The other half of a temporary chat's promise. `before-quit` handles the
  // ordinary ending; this one covers every other way a session can stop —
  // a crash, a kill, a machine that lost power — and it runs before the window
  // so no temporary chat is ever on screen twice.
  const expired = deleteTemporaryThreads()
  if (expired) console.log(`Removed ${expired} temporary chat(s) from the last session.`)

  attachments.registerProtocolHandler()
  const orphans = attachments.collectOrphans()
  if (orphans) console.log(`Removed ${orphans} orphaned attachment file(s).`)

  registerIpc()
  canOpenWindows = true
  createWindow()
  startBackgroundTasks()

  app.on('activate', () => {
    openMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  // First, and synchronously: an async handler does not hold the app open, so
  // anything awaited before this may simply not happen. A temporary chat has to
  // be gone before the database closes, not merely scheduled to be.
  deleteTemporaryThreads()

  await mcp.disconnectAll().catch(() => undefined)
  await shutdownRepoWorker().catch(() => undefined)
  closeDb()
})

// This app talks to OpenRouter and to hosts the user asks for. Nothing else.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const isDevServer = isDev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? '\0')
    if (!isDevServer && !url.startsWith('file://')) event.preventDefault()
  })
})
