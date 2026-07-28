#!/usr/bin/env node
/**
 * Bundles the modules under test into CommonJS, then runs each test file inside
 * Electron. Electron is required because better-sqlite3 is built against its
 * ABI and because safeStorage exists nowhere else.
 *
 * On a headless Linux machine, run this under xvfb-run.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const buildDir = join(root, '.test-build')
const testDir = join(root, 'test')

mkdirSync(buildDir, { recursive: true })

const bundle = spawnSync(
  'npx',
  [
    'esbuild',
    join(testDir, 'support', 'entry.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:electron',
    '--external:better-sqlite3',
    `--alias:@=${join(root, 'src', 'main')}`,
    `--alias:@shared=${join(root, 'src', 'shared')}`,
    `--outfile=${join(buildDir, 'bundle.js')}`
  ],
  { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] }
)

if (bundle.status !== 0) {
  console.error('Could not bundle the modules under test.')
  process.exit(1)
}

// The layout suite boots the real app, so it needs a current build.
const app = spawnSync('npx', ['electron-vite', 'build'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit']
})

if (app.status !== 0) {
  console.error('Could not build the app.')
  process.exit(1)
}

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()

let failed = 0

for (const file of files) {
  // These suites never open a window, so Chromium's sandbox has nothing to
  // protect — and its setuid helper is not correctly owned in most CI images.
  const run = spawnSync('npx', ['electron', '--no-sandbox', join(testDir, file)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  if (run.status !== 0) failed++
}

console.log('')
if (failed) {
  console.error(`${failed} of ${files.length} test files failed.`)
  process.exit(1)
}
console.log(`${files.length} test files passed.`)
