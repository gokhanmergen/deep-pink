import { statSync } from 'node:fs'
import { chmod, copyFile, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

function bundledLauncherPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'deep-pink-quick')
    : join(__dirname, '../../build/native/deep-pink-quick')
}

export function installedLauncherPath(): string | null {
  if (process.platform !== 'linux') return null
  const path = join(app.getPath('userData'), 'native', 'deep-pink-quick')
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
  const destination = join(directory, 'deep-pink-quick')
  const temporary = `${destination}.${process.pid}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  await copyFile(source, temporary)
  await chmod(temporary, 0o700)
  await rename(temporary, destination)

  if (app.isPackaged) {
    // APPIMAGE is the stable command needed to restart an AppImage after its
    // temporary mount has gone away. Other Linux packages use process.execPath.
    const executable = process.env['APPIMAGE'] || process.execPath
    await writeFile(join(directory, 'deep-pink-executable'), `${executable}\n`, {
      mode: 0o600
    })
    await chmod(join(directory, 'deep-pink-executable'), 0o600)
  }
  return destination
}
