#!/usr/bin/env node
/**
 * Bundles the modules under test into CommonJS, then runs each test file inside
 * Electron. Electron is required because better-sqlite3 is built against its
 * ABI and because safeStorage exists nowhere else.
 *
 * On a headless Linux machine, run this under xvfb-run.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const buildDir = join(root, '.test-build')
const testDir = join(root, 'test')

mkdirSync(buildDir, { recursive: true })

const bundle = spawnSync(
  'pnpm',
  [
    'exec',
    'esbuild',
    join(testDir, 'support', 'entry.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:electron',
    '--external:better-sqlite3',
    `--define:__APP_VERSION__=${JSON.stringify(version)}`,
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
const app = spawnSync('pnpm', ['exec', 'electron-vite', 'build'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit']
})

if (app.status !== 0) {
  console.error('Could not build the app.')
  process.exit(1)
}

// The renderer store is bundled on its own: it reads `window.deepPink` at
// module scope, so its test installs a stub bridge before requiring it.
const storeBundle = spawnSync(
  'pnpm',
  [
    'exec',
    'esbuild',
    join(testDir, 'support', 'entry-store.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:electron',
    `--alias:@renderer=${join(root, 'src', 'renderer', 'src')}`,
    `--alias:@shared=${join(root, 'src', 'shared')}`,
    `--outfile=${join(buildDir, 'store.js')}`
  ],
  { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] }
)

if (storeBundle.status !== 0) {
  console.error('Could not bundle the renderer store.')
  process.exit(1)
}

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()

// A test file that does not parse takes Electron down before it prints
// anything, which looks like a hang rather than a syntax error. Check first.
for (const file of files) {
  try {
    new Function(readFileSync(join(testDir, file), 'utf8'))
  } catch (err) {
    console.error(`${file} does not parse: ${err.message}`)
    process.exit(1)
  }
}

let failed = 0

for (const file of files) {
  // These suites never open a window, so Chromium's sandbox has nothing to
  // protect — and its setuid helper is not correctly owned in most CI images.
  const run = spawnSync('pnpm', ['exec', 'electron', '--no-sandbox', join(testDir, file)], {
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
