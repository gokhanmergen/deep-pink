import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import pkg from '../package.json' with { type: 'json' }

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tauriRoot = join(repoRoot, 'src-tauri')
const backendPackage = join(tauriRoot, 'backend')
const backendModules = join(backendPackage, 'node_modules')
const resourceRoot = join(tauriRoot, 'resources')
const binariesRoot = join(tauriRoot, 'binaries')

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 22) {
  throw new Error(`Tauri sidecar builds require Node.js 22 or newer; found ${process.versions.node}.`)
}

if (!process.env.TAURI_ENV_TARGET_TRIPLE && !process.env.CI) {
  console.log('Preparing a Tauri sidecar for the current machine.')
}

const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE || inferHostTriple()
assertNativeTarget(targetTriple)

const sqliteTarget = betterSqliteTarget()
const sqliteBinding = join(backendModules, 'better-sqlite3', 'prebuilds', `${sqliteTarget}.node`)
if (!statExists(sqliteBinding)) {
  console.log('Installing the Node-runtime SQLite binding for the Tauri sidecar.')
  const result = spawnSync('npm', ['ci', '--prefix', backendPackage, '--no-audit', '--no-fund'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (!statExists(sqliteBinding)) {
  throw new Error(`better-sqlite3 did not build for the sidecar's Node runtime: ${sqliteBinding}`)
}

rmSync(resourceRoot, { recursive: true, force: true })
mkdirSync(resourceRoot, { recursive: true })
await build({
  entryPoints: [join(repoRoot, 'src/tauri/backend.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: join(resourceRoot, 'backend.cjs'),
  external: ['better-sqlite3'],
  alias: {
    electron: join(repoRoot, 'src/tauri/electron-shim.ts'),
    '@shared': join(repoRoot, 'src/shared')
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: false,
  logLevel: 'info'
})

await build({
  entryPoints: [join(repoRoot, 'src/main/tools/repoWorker.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: join(resourceRoot, 'repoWorker.js'),
  sourcemap: false,
  logLevel: 'info'
})

cpSync(backendModules, join(resourceRoot, 'node_modules'), { recursive: true, dereference: true })
const prebuildDir = join(resourceRoot, 'node_modules', 'better-sqlite3', 'prebuilds')
for (const filename of readdirSync(prebuildDir)) {
  if (filename !== `${sqliteTarget}.node`) rmSync(join(prebuildDir, filename), { force: true })
}

const binaryName = `deep-pink-node-${targetTriple}${targetTriple.includes('windows') ? '.exe' : ''}`
const binaryPath = join(binariesRoot, binaryName)
mkdirSync(binariesRoot, { recursive: true })
copyFileSync(process.execPath, binaryPath)
if (process.platform !== 'win32') chmodSync(binaryPath, 0o755)

console.log(`Built ${binaryName} and the Tauri Node backend resources.`)

function statExists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function inferHostTriple() {
  const rustc = spawnSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' })
  if (rustc.status === 0 && rustc.stdout.trim()) return rustc.stdout.trim()
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`
  if (process.platform === 'linux') return `${arch}-unknown-linux-gnu`
  throw new Error(`Cannot infer a Tauri target triple for ${process.platform}-${process.arch}`)
}

function assertNativeTarget(triple) {
  const osMatches =
    (process.platform === 'linux' && triple.includes('linux')) ||
    (process.platform === 'darwin' && triple.includes('apple-darwin')) ||
    (process.platform === 'win32' && triple.includes('windows'))
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  if (!osMatches || !triple.startsWith(arch)) {
    throw new Error(
      `The bundled Node runtime and SQLite module are for ${process.platform}-${process.arch}, but Tauri targets ${triple}. Build on a matching machine so the Node runtime and native SQLite binding agree.`
    )
  }
}

function betterSqliteTarget() {
  const osName = process.platform === 'win32' ? 'win32' : process.platform
  const isMusl =
    process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime
  return `${osName}${isMusl ? 'musl' : ''}-${process.arch}`
}
