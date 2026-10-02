/**
 * Whether there is a newer Deep Pink, and what to do about it.
 *
 * Two halves, and the split is the whole design. Windows and macOS have a
 * copy of the app that the app itself put there, so it can put a newer one
 * there. A Linux machine mostly does not: the copy came from pacman, or apt,
 * or a Nix configuration, and something else owns it. An app that overwrote
 * itself in `/opt` would be lying to the package manager that put it there,
 * and the next `pacman -Syu` would either undo it or refuse.
 *
 * So on Linux the app does not update itself. It notices, says so, and says
 * the one command that works for the way this copy was actually installed —
 * which it can tell from where it is running, without asking anybody.
 */

/** How this copy got onto the machine, which decides what to advise. */
export type InstallKind =
  | 'appimage'
  | 'pacman'
  | 'apt'
  | 'dnf'
  | 'nix'
  | 'tarball'
  | 'mac'
  | 'windows'
  | 'unknown'

export interface UpdateConfig {
  /** Look for a newer version at all. */
  check: boolean
  /**
   * Fetch and install it without being asked, where that is possible.
   *
   * Only consulted where `canSelfInstall` is true. On Linux it is ignored
   * rather than hidden, because a machine that installs from a tarball today
   * may install from a package tomorrow and the preference should survive.
   */
  autoInstall: boolean
}

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = { check: true, autoInstall: true }

export interface UpdateStatus {
  currentVersion: string
  /** The newest published version, or null if it has not been asked yet. */
  latestVersion: string | null
  /** Where to read about it, for anyone who would rather look first. */
  releaseUrl: string | null
  checkedAt: number | null
  installKind: InstallKind
  /** True where the app can replace itself; false where something else owns it. */
  canSelfInstall: boolean
  /** Downloaded and waiting for a restart. */
  readyToInstall: boolean
  error: string | null
}

/**
 * Whether `latest` is newer than `current`.
 *
 * Numeric by part, so 0.10.0 beats 0.9.0, and prereleases sort below the
 * matching release, so 0.18.0 is newer than 0.18.0-indev.
 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (value: string): { core: number[]; prerelease: string[] | null } | null => {
    const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
    if (!match) return null
    return {
      core: match.slice(1, 4).map(Number),
      prerelease: match[4] ? match[4].split('.') : null
    }
  }

  const a = parse(latest)
  const b = parse(current)
  if (!a || !b) return false

  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i]
  }

  // A final release follows every prerelease carrying the same core version.
  if (!a.prerelease || !b.prerelease) return Boolean(b.prerelease && !a.prerelease)

  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i]
    const right = b.prerelease[i]
    if (left === undefined || right === undefined) return right === undefined && left !== undefined
    if (left === right) continue
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return Number(left) > Number(right)
    if (leftNumeric !== rightNumeric) return !leftNumeric
    return left > right
  }
  return false
}

/**
 * The one command that updates this copy, or null where there is not one.
 *
 * One line, and the right one, because the point of saying anything at all is
 * to save the reader working out which of five packaging formats they used
 * eight weeks ago. Where there is no command — an AppImage, a tarball, a Nix
 * configuration that is a file rather than an instruction — it says what to
 * do instead, in `howToUpdate`.
 */
export function updateCommand(kind: InstallKind): string | null {
  switch (kind) {
    case 'pacman':
      return 'sudo pacman -Syu deep-pink'
    case 'apt':
      return 'sudo apt update && sudo apt install --only-upgrade deep-pink'
    case 'dnf':
      return 'sudo dnf upgrade deep-pink'
    default:
      return null
  }
}

/** What to tell somebody who cannot be given a command to run. */
export function howToUpdate(kind: InstallKind): string {
  switch (kind) {
    case 'pacman':
    case 'apt':
    case 'dnf':
      return 'Update it with your package manager:'
    case 'nix':
      return 'This copy comes from your Nix store. Update the flake input or channel it came from, then rebuild.'
    case 'appimage':
      return 'Download the new AppImage and replace the one you are running. Or install the package for your distribution, which updates with the rest of the machine.'
    case 'tarball':
      return 'Download the new tarball and unpack it over this copy.'
    case 'mac':
    case 'windows':
      return 'Download the installer and run it.'
    default:
      return 'Download the new version from the releases page.'
  }
}
