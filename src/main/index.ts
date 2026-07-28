import { join } from 'node:path'
import { BrowserWindow, app, shell } from 'electron'
import { closeDb, getDb } from './db/index'
import { reconcileInterruptedMessages } from './db/repo'
import { registerIpc } from './ipc'
import * as mcp from './mcp/host'

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  })

  win.once('ready-to-show', () => win.show())

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
  win.webContents.on('did-finish-load', reportState)

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

  return win
}

// One database, one writer. Two copies of the app on the same profile interleave
// their writes, which shows up as messages from one appearing mid-conversation
// in the other.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
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

  registerIpc()
  createWindow()

  // Connecting MCP servers spawns processes; do it after the window is up so
  // a slow or broken server never delays first paint.
  mcp.connectAll().catch(() => undefined)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await mcp.disconnectAll().catch(() => undefined)
  closeDb()
})

// This app talks to OpenRouter and to hosts the user asks for. Nothing else.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const isDevServer = isDev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? '\0')
    if (!isDevServer && !url.startsWith('file://')) event.preventDefault()
  })
})
