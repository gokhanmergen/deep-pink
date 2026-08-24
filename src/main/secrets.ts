import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * Secrets, held in the OS keyring-backed encryption that Electron's safeStorage
 * provides (libsecret / kwallet on Linux, the Keychain on macOS).
 *
 * Each lives in its own file rather than in the settings store, so none of them
 * can be swept into an export, a sync or a bug report — and none of them is
 * ever sent over IPC to the renderer, which is told only whether one is set.
 */

/**
 * The files. Named rather than derived from the caller's string so nothing can
 * ask for a path, and `openrouter.key` keeps the name it has always had so an
 * upgrade does not lose the key that is already in it.
 */
const FILES: Record<SecretName, string> = {
  openrouter: 'openrouter.key',
  'sync-key': 'sync.key',
  'sync-s3-secret': 'sync-s3.key'
}

export type SecretName = 'openrouter' | 'sync-key' | 'sync-s3-secret'

const cache = new Map<SecretName, string | null>()

function pathOf(name: SecretName): string {
  return join(app.getPath('userData'), FILES[name])
}

export function setSecret(name: SecretName, value: string | null): void {
  const trimmed = value?.trim() ?? ''
  const path = pathOf(name)

  if (!trimmed) {
    if (existsSync(path)) unlinkSync(path)
    cache.set(name, null)
    return
  }

  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(path, safeStorage.encryptString(trimmed), { mode: 0o600 })
  } else {
    // No keyring available (common on bare headless Linux). Store plaintext
    // with owner-only permissions and let the UI say so rather than silently
    // failing to remember anything.
    writeFileSync(path, `plain:${trimmed}`, { mode: 0o600 })
  }
  cache.set(name, trimmed)
}

export function getSecret(name: SecretName): string | null {
  const hit = cache.get(name)
  if (hit !== undefined) return hit

  const path = pathOf(name)
  if (!existsSync(path)) {
    cache.set(name, null)
    return null
  }

  let value: string | null = null
  try {
    const raw = readFileSync(path)
    const asText = raw.toString('utf8')
    value = asText.startsWith('plain:') ? asText.slice('plain:'.length) : safeStorage.decryptString(raw)
  } catch {
    value = null
  }

  cache.set(name, value)
  return value
}

/* The OpenRouter key, which the rest of the app knows by name. */

export function setApiKey(key: string): void {
  setSecret('openrouter', key)
}

export function getApiKey(): string | null {
  return getSecret('openrouter')
}

export function hasApiKey(): boolean {
  return Boolean(getApiKey())
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}
