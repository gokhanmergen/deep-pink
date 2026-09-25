import { existsSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

function bundledLauncherPath(): string {
  const packaged = join(process.resourcesPath, 'native', 'deep-pink-launcher')
  const appBundle = join(__dirname, '../../build/native/deep-pink-launcher')
  return app.isPackaged && existsSync(packaged) ? packaged : appBundle
}

export function installedLauncherPath(): string | null {
  if (process.platform !== 'linux') return null
  const path = join(app.getPath('userData'), 'native', 'deep-pink-launcher')
  try {
    return statSync(path).isFile() ? path : null
  } catch {
    return null
  }
}

/** Copies the tiny GTK binary to a stable, user-writable path for WM bindings. */
export async function prepareNativeLauncher(): Promise<string | null> {
  if (process.platform !== 'linux') return null

  const source = bundledLauncherPath()
  try {
    if (!(await stat(source)).isFile()) return null
  } catch {
    return null
  }

  const directory = join(app.getPath('userData'), 'native')
  const destination = join(directory, 'deep-pink-launcher')
  const temporary = `${destination}.${process.pid}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  await copyFile(source, temporary)
  await chmod(temporary, 0o700)
  await rename(temporary, destination)
  await rm(join(directory, 'deep-pink-quick'), { force: true })

  const executable =
    process.env['DEEP_PINK_EXECUTABLE'] ||
    (app.isPackaged ? process.env['APPIMAGE'] || process.execPath : null)
  if (executable) {
    // APPIMAGE is the stable command needed to restart an AppImage after its
    // temporary mount has gone away. Nix supplies its wrapper explicitly.
    await writeFile(join(directory, 'deep-pink-executable'), `${executable}\n`, {
      mode: 0o600
    })
    await chmod(join(directory, 'deep-pink-executable'), 0o600)
  }
  return destination
}
