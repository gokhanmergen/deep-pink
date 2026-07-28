// A very small test harness. These tests run inside Electron because the app's
// storage layer uses better-sqlite3 built against Electron's ABI, and because
// safeStorage only exists there.
const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const GREEN = '[32m'
const RED = '[31m'
const DIM = '[2m'
const RESET = '[0m'

/**
 * @param {string} suiteName
 * @param {(t: {check: Function, section: Function, subject: any, tmpDir: string, getWindow: Function}) => Promise<void> | void} body
 * @param {{bootApp?: boolean}} [options] `bootApp` starts the real built app
 *   first, so a suite can inspect the UI it actually renders.
 */
function suite(suiteName, body, options = {}) {
  app.disableHardwareAcceleration()

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-pink-test-'))
  app.setPath('userData', tmpDir)

  if (options.bootApp) {
    const built = path.join(__dirname, '..', '..', 'out', 'main', 'index.js')
    if (!fs.existsSync(built)) {
      console.error(`\n${RED}${suiteName} needs a build — run electron-vite build first.${RESET}`)
      app.exit(1)
      return
    }
    // Registers its own whenReady handler first, so the window exists by the
    // time this suite's handler runs.
    require(built)
  }

  const failures = []
  let passed = 0

  const check = (name, condition, detail) => {
    if (condition) {
      passed++
      console.log(`  ${GREEN}✓${RESET} ${name}`)
    } else {
      failures.push(name)
      console.log(`  ${RED}✗ ${name}${RESET}`)
      if (detail !== undefined) {
        console.log(`    ${DIM}${JSON.stringify(detail)}${RESET}`)
      }
    }
  }

  const section = (title) => console.log(`\n${DIM}${title}${RESET}`)

  app.whenReady().then(async () => {
    console.log(`\n${suiteName}`)
    try {
      const subject = require(path.join(__dirname, '..', '..', '.test-build', 'bundle.js'))
      const { BrowserWindow } = require('electron')
      const getWindow = () => BrowserWindow.getAllWindows()[0]
      await body({ check, section, subject, tmpDir, getWindow })
    } catch (err) {
      failures.push('suite threw')
      console.log(`  ${RED}✗ suite threw: ${err && err.stack ? err.stack : err}${RESET}`)
    }

    fs.rmSync(tmpDir, { recursive: true, force: true })

    console.log(
      failures.length
        ? `\n${RED}${failures.length} failed${RESET}, ${passed} passed`
        : `\n${GREEN}${passed} passed${RESET}`
    )
    app.exit(failures.length ? 1 : 0)
  })
}

/** Builds a fake streaming Response, chopped into small chunks on purpose. */
function sseResponse(lines) {
  const body = lines.map((line) => `${line}\n`).join('')
  const chunks = []
  for (let i = 0; i < body.length; i += 7) chunks.push(body.slice(i, i + 7))

  const encoder = new TextEncoder()
  let index = 0

  return {
    ok: true,
    status: 200,
    headers: new Map(),
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: encoder.encode(chunks[index++]) }
            : { done: true, value: undefined },
        releaseLock: () => undefined
      })
    }
  }
}

/** Writes a throwaway API key so the OpenRouter client will send a request. */
function writeTestApiKey() {
  const { safeStorage } = require('electron')
  const keyPath = path.join(app.getPath('userData'), 'openrouter.key')
  fs.writeFileSync(
    keyPath,
    safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString('sk-or-test')
      : 'plain:sk-or-test'
  )
}

/** A fully-formed Message, so tests only state the fields they care about. */
function message(overrides) {
  return {
    id: 'm',
    threadId: 't',
    role: 'user',
    content: '',
    reasoning: null,
    createdAt: 0,
    model: null,
    provider: null,
    status: 'complete',
    error: null,
    toolCalls: null,
    toolResult: null,
    systemPromptSnapshot: null,
    isCompactionSummary: false,
    compactedInto: null,
    usage: null,
    ...overrides
  }
}

/** Resolves after `ms`, for the few places where a render has to settle. */
function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = { suite, sseResponse, writeTestApiKey, message, settle }
