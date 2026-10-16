#!/usr/bin/env node
/**
 * Runs only the checks that guard persisted user data and network boundaries.
 * No renderer build or full app launch is needed for these module-level checks.
 */
import { readdirSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const buildDir = join(root, '.test-build')
const testDir = join(root, 'test')
const bundlePath = join(buildDir, 'bundle.js')
const mainRoot = join(root, 'src', 'main')
const sharedRoot = join(root, 'src', 'shared')

mkdirSync(buildDir, { recursive: true })

try {
  await build({
    entryPoints: [join(testDir, 'support', 'entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'better-sqlite3'],
    define: { __APP_VERSION__: JSON.stringify(version) },
    alias: { '@shared': sharedRoot, '@': mainRoot },
    outfile: bundlePath,
    logLevel: 'silent'
  })
} catch (error) {
  console.error(error)
  console.error('Could not bundle the essential checks.')
  process.exit(1)
}

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()

for (const file of files) {
  try {
    new Function(readFileSync(join(testDir, file), 'utf8'))
  } catch (error) {
    console.error(`${file} does not parse: ${error.message}`)
    process.exit(1)
  }
}

const electronBinary = require('electron')
let failed = 0

for (const file of files) {
  const run = spawnSync(electronBinary, ['--no-sandbox', join(testDir, file)], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    }
  })
  if (run.status !== 0) failed += 1
}

console.log('')
if (failed) {
  console.error(`${failed} of ${files.length} essential test files failed.`)
  process.exit(1)
}
console.log(`${files.length} essential test file passed.`)
