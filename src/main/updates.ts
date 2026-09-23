import * as repo from './db/repo'
import {
  DEFAULT_UPDATE_CONFIG,
  isNewer,
  type InstallKind,
  type UpdateConfig,
  type UpdateStatus
} from '@shared/updates'

/**
 * Noticing that there is a newer Deep Pink.
 *
 * One unauthenticated request to GitHub's releases endpoint. This reports the
 * latest version and links to its release page; installation stays with the
 * package or installer that delivered this copy of the app.
 */

const LATEST = 'https://api.github.com/repos/gokhanmergen/deep-pink/releases/latest'

/** Its own key, the way sync has one — this is not a chat setting. */
const CONFIG_KEY = 'updates'

/**
 * How often to look, once the app is running.
 *
 * Six hours. A desktop app is left open for days, and a release happens a few
 * times a month: anything more often is asking a question whose answer cannot
 * have changed. The check at startup is the one that matters.
 */
const LOOK_EVERY = 6 * 60 * 60 * 1000

/** Long enough to be a real timeout, short enough not to hang a launch. */
const GIVE_UP_AFTER = 10_000

let status: UpdateStatus = {
  /*
   * The version in `package.json`, baked in at build time, which is what the
   * About box already reports. Not `app.getVersion()`: unpackaged that
   * answers with Electron's own version — measured at "38.8.6" against an
   * app at 0.13.3 — and a comparison against that says every release is
   * older than what is running.
   */
  currentVersion: __APP_VERSION__,
  latestVersion: null,
  releaseUrl: null,
  checkedAt: null,
  installKind: 'unknown',
  canSelfInstall: false,
  readyToInstall: false,
  error: null
}

let watching: ReturnType<typeof setInterval> | null = null
let announce: ((status: UpdateStatus) => void) | null = null

export function loadUpdateConfig(): UpdateConfig {
  return { ...DEFAULT_UPDATE_CONFIG, ...repo.getSetting<Partial<UpdateConfig>>(CONFIG_KEY, {}) }
}

export function saveUpdateConfig(patch: Partial<UpdateConfig>): UpdateConfig {
  const next = { ...loadUpdateConfig(), ...patch }
  repo.setSetting(CONFIG_KEY, next)
  if (next.check) startWatchingForUpdates()
  return next
}

/**
 * How this copy was installed, worked out from where it is running.
 *
 * No subprocesses and no guessing at the distribution: the path the binary
 * sits at says which of these it is, because each packaging format puts it
 * somewhere only that format uses. Only the last case has to look further,
 * and by then the question is narrow enough for `/etc/os-release` to answer.
 */
export function detectInstallKind(): InstallKind {
  // The Node executable runs as a bundled Tauri sidecar, so its path says
  // nothing about how the desktop application itself was installed.
  if (process.env.DEEP_PINK_RUNTIME === 'tauri') return 'tauri'
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'win32') return 'windows'

  /*
   * An AppImage, and this one rather than some other.
   *
   * `APPIMAGE` alone is not the test, because the variable is inherited:
   * anything launched from inside an AppImage sees the path of *that* one.
   * Measured on this machine (2026-09-22) — `APPIMAGE` was set to an entirely
   * unrelated app, and a package install would have been told to download a
   * new AppImage. Tying it to `APPDIR`, which is the mount this binary is
   * actually running out of, is what makes it a question about this process.
   */
  const appDir = process.env.APPDIR
  if (appDir && process.execPath.startsWith(appDir)) return 'appimage'

  const where = process.execPath
  if (where.startsWith('/nix/store/')) return 'nix'

  /*
   * `/opt` is where deb, rpm and pacman all put it, and nothing else does —
   * a tarball is unpacked wherever the reader felt like. Which of the three
   * it was is a question about the machine rather than the path.
   */
  if (where.startsWith('/opt/')) {
    const os = readOsRelease()
    if (/\b(arch|manjaro|endeavouros|cachyos|garuda)\b/.test(os)) return 'pacman'
    if (/\b(debian|ubuntu|linuxmint|pop|elementary)\b/.test(os)) return 'apt'
    if (/\b(fedora|rhel|centos|opensuse|suse)\b/.test(os)) return 'dnf'
    return 'unknown'
  }

  return 'tarball'
}

/** `ID` and `ID_LIKE` from `/etc/os-release`, or nothing if it is not there. */
function readOsRelease(): string {
  try {
    // Required lazily: every other platform gets here without needing it, and
    // this runs once.
    const text = require('node:fs').readFileSync('/etc/os-release', 'utf8') as string
    return text
      .split('\n')
      .filter((line) => line.startsWith('ID=') || line.startsWith('ID_LIKE='))
      .join(' ')
      .toLowerCase()
      .replace(/["']/g, '')
  } catch {
    return ''
  }
}

/**
 * Whether the app can replace its own copy.
 *
 * Windows only, and the honesty is the point. `electron-updater` can install
 * an NSIS update in place. macOS is listed as a self-installer everywhere
 * else and is not one here: Squirrel refuses a bundle that is not signed with
 * a Developer ID, and this project signs ad-hoc because it has no such
 * identity — so a mac would download an update it could never apply. Better
 * to tell a mac the same thing Linux is told and let the reader run the
 * installer they already trust.
 */
export function canSelfInstall(kind: InstallKind): boolean {
  return kind === 'windows'
}

export function updateStatus(): UpdateStatus {
  return status
}

/** Told about a new status, so the window can show it without polling. */
export function onUpdateStatus(fn: (status: UpdateStatus) => void): void {
  announce = fn
}

function publish(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  announce?.(status)
}

/**
 * Asks once, and keeps whatever it learns.
 *
 * Every failure here is the same failure — no network, GitHub rate-limiting an
 * unauthenticated caller, a machine that has never been online — and none of
 * them is worth interrupting anybody over. The error is kept so the settings
 * panel can say why it does not know, rather than silently claiming the app
 * is current.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const kind = detectInstallKind()
  publish({ installKind: kind, canSelfInstall: canSelfInstall(kind) })

  try {
    const res = await fetch(LATEST, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'deep-pink' },
      signal: AbortSignal.timeout(GIVE_UP_AFTER)
    })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)

    const body = (await res.json()) as { tag_name?: string; html_url?: string }
    const tag = String(body.tag_name ?? '').replace(/^v/, '')
    if (!tag) throw new Error('That release has no version on it')

    publish({
      latestVersion: tag,
      releaseUrl: body.html_url ?? null,
      checkedAt: Date.now(),
      error: null
    })
  } catch (err) {
    publish({
      checkedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err)
    })
  }

  return status
}

/** True when there is something newer than what is running. */
export function updateAvailable(): boolean {
  return Boolean(status.latestVersion && isNewer(status.latestVersion, status.currentVersion))
}

/**
 * Looks now, and again occasionally, unless asked not to.
 *
 * Behind the window like naming and sync: this is a network round trip, and
 * nothing on screen is waiting for it.
 */
export function startWatchingForUpdates(): void {
  if (!loadUpdateConfig().check) return
  void checkForUpdate()
  if (watching) return
  watching = setInterval(() => {
    if (loadUpdateConfig().check) void checkForUpdate()
  }, LOOK_EVERY)
  watching.unref?.()
}
