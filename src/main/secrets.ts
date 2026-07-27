import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * The OpenRouter API key is held in the OS keyring-backed encryption that
 * Electron's safeStorage provides (libsecret / kwallet on Linux). It is written
 * to its own file rather than the settings store so it never gets swept into a
 * settings export, and it is never sent over IPC to the renderer.
 */

const FILE = () => join(app.getPath('userData'), 'openrouter.key')

let cached: string | null = null
let loaded = false

export function setApiKey(key: string): void {
  const trimmed = key.trim()
  const path = FILE()

  if (!trimmed) {
    if (existsSync(path)) unlinkSync(path)
    cached = null
    loaded = true
    return
  }

  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(path, safeStorage.encryptString(trimmed), { mode: 0o600 })
  } else {
    // No keyring available (common on bare headless Linux). Store plaintext with
    // owner-only permissions and let the UI say so rather than silently failing.
    writeFileSync(path, `plain:${trimmed}`, { mode: 0o600 })
  }
  cached = trimmed
  loaded = true
}

export function getApiKey(): string | null {
  if (loaded) return cached

  loaded = true
  const path = FILE()
  if (!existsSync(path)) {
    cached = null
    return null
  }

  try {
    const raw = readFileSync(path)
    const asText = raw.toString('utf8')
    if (asText.startsWith('plain:')) {
      cached = asText.slice('plain:'.length)
    } else {
      cached = safeStorage.decryptString(raw)
    }
  } catch {
    cached = null
  }
  return cached
}

export function hasApiKey(): boolean {
  return Boolean(getApiKey())
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}
