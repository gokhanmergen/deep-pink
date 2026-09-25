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
const launchedAsQuickQuestion = process.argv.includes('--quick-question')
let mainWindow: BrowserWindow | null = null
let quickQuestionWindow: BrowserWindow | null = null
let canOpenWindows = false
let pendingLaunch: 'main' | 'quick-question' | null = null

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

  // In background mode the close button means "put the main window away".
  // The preloaded Quick Question window keeps the process ready for the WM.
  win.on('close', (event) => {
    if (loadSettings().quickQuestion.keepRunning) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // The launcher is preloaded while the app is open. Without background
    // mode it should not keep a supposedly closed app alive by itself.
    if (!loadSettings().quickQuestion.keepRunning) {
      if (quickQuestionWindow && !quickQuestionWindow.isDestroyed()) {
        quickQuestionWindow.destroy()
      }
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
   * So the window is shown at once. It is not empty when it arrives:
   * `backgroundColor` paints immediately, and `index.html` carries a static
   * skeleton of the app's own chrome that the HTML parser puts up without
   * waiting for any script. What the reader sees is the app appearing in a
   * quarter of a second and filling in, rather than a quarter of a second of
   * nothing followed by two seconds more of it.
   */
  win.show()

  return win
}

function createQuickQuestionWindow(): BrowserWindow {
  if (quickQuestionWindow && !quickQuestionWindow.isDestroyed()) return quickQuestionWindow

  const win = new BrowserWindow({
    width: 560,
    height: 390,
    minWidth: 430,
    minHeight: 300,
    show: false,
    center: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0a0a0d',
    ...(process.platform === 'linux' ? { icon: join(__dirname, '../../build/icon.png') } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  })
  quickQuestionWindow = win
  win.on('hide', () => {
    if (!win.isDestroyed()) win.webContents.send('quick-question:hidden')
  })
  win.on('close', (event) => {
    // Keep it warm while the full app is open, or when background mode has
    // explicitly asked the process to remain available after closing it.
    if (
      loadSettings().quickQuestion.keepRunning ||
      (mainWindow && !mainWindow.isDestroyed())
    ) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (quickQuestionWindow === win) quickQuestionWindow = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL('/quick-question.html', process.env['ELECTRON_RENDERER_URL']).toString()
    win.loadURL(url)
  } else {
    win.loadFile(join(__dirname, '../renderer/quick-question.html'))
  }

  // A small static skeleton is already in the HTML, so it can be shown before
  // React has parsed the popup bundle. It stays hidden until the WM invokes it.
  return win
}

function openQuickQuestion(): void {
  const win = createQuickQuestionWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.focus()
  if (!win.webContents.isLoading()) win.webContents.send('quick-question:opened')
}

function openMainWindow(): void {
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

app.on('second-instance', (_event, commandLine) => {
  const launch = commandLine.includes('--quick-question') ? 'quick-question' : 'main'
  if (!canOpenWindows) {
    pendingLaunch = launch
    return
  }
  if (launch === 'quick-question') openQuickQuestion()
  else openMainWindow()
})

app.whenReady().then(async () => {
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
  const launch = pendingLaunch ?? (launchedAsQuickQuestion ? 'quick-question' : 'main')
  pendingLaunch = null
  if (launch === 'quick-question') openQuickQuestion()
  else createWindow()
  // Warm the compact renderer while the full app remains usable. When the
  // background setting is off, closing the main window also destroys it.
  createQuickQuestionWindow()

  // Connecting MCP servers spawns processes; do it after the window is up so
  // a slow or broken server never delays first paint. Not at all while the
  // experimental parts are hidden: these are processes on your machine, and
  // starting them for a feature the app is not showing is the one version of
  // this that could surprise somebody badly.
  if (!loadSettings().hideExperimental) mcp.connectAll().catch(() => undefined)

  // Naming is one request per thread, so it happens behind the first paint and
  // the renderer picks each one up through the event it emits. It keeps
  // looking while the app is open, rather than only now: a name lost to a
  // closed window or a blinked network used to wait for the next start.
  startNaming()

  // And whether there is a newer one. A network round trip, so it waits until
  // there is a window to tell.
  startUpdateChecks()

  // Sync runs behind the window too: the first thing it does is a network
  // round trip, and nothing on screen should be waiting on it.
  startSync()

  app.on('activate', () => {
    openMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (loadSettings().quickQuestion.keepRunning) return
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
