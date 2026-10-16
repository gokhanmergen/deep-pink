// These checks need Electron because the app's database uses Electron's
// better-sqlite3 ABI and the search transport uses Electron sessions.
const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const RESET = '\u001b[0m'

function suite(name, body) {
  app.disableHardwareAcceleration()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-pink-test-'))
  app.setPath('userData', tmpDir)

  const failures = []
  let passed = 0
  const check = (label, condition, detail) => {
    if (condition) {
      passed += 1
      console.log(`  ${GREEN}✓${RESET} ${label}`)
    } else {
      failures.push(label)
      console.log(`  ${RED}✗ ${label}${RESET}`)
      if (detail !== undefined) console.log(`    ${JSON.stringify(detail)}`)
    }
  }

  app.whenReady().then(async () => {
    console.log(`\n${name}`)
    let subject
    try {
      subject = require(path.join(__dirname, '..', '..', '.test-build', 'bundle.js'))
      await body({ check, subject })
    } catch (error) {
      failures.push('suite threw')
      console.error(`  ${RED}✗ suite threw: ${error?.stack ?? error}${RESET}`)
    } finally {
      try {
        subject?.closeDb()
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    }

    console.log(
      failures.length
        ? `\n${RED}${failures.length} failed${RESET}, ${passed} passed`
        : `\n${GREEN}${passed} passed${RESET}`
    )
    app.exit(failures.length ? 1 : 0)
  })
}

module.exports = { suite }
