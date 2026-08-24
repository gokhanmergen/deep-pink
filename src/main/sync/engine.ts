import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { SyncConfig, SyncResult, SyncScopes, SyncState } from '@shared/types'
import { getDb } from '../db/index'
import { getSetting, setSetting } from '../db/repo'
import { getSecret, setSecret } from '../secrets'
import * as vault from './crypto'
import { S3Client, type Fetcher, type S3Config } from './s3'
import * as records from './records'

/**
 * Sync.
 *
 * One bucket, any number of machines, and a server that is told nothing. Each
 * machine keeps a manifest — a list of every record it knows about and which
 * revision it saw — and writes it under a name only the key can compute. To
 * sync is to read everybody's manifest, work out for each record who has the
 * newest copy, take what is newer than yours and offer what is newer than
 * theirs.
 *
 * ## Why manifests rather than a shared index
 *
 * Because two machines writing one index is a lost update, and locking a bucket
 * is not a thing you can do portably. A machine only ever writes its own
 * manifest, so there is nothing to race over; the merge happens on the way in,
 * where a conflict is a comparison rather than a corruption.
 *
 * ## Records are immutable
 *
 * An object's name includes the revision it holds, so a given version of a
 * record always lands in the same place and is written identically by whoever
 * has it. Nothing is ever overwritten, two machines pushing the same version
 * write the same bytes, and superseded versions are collected afterwards.
 *
 * ## What wins
 *
 * The highest revision, and a deletion beats a record of the same age. Last
 * write wins is the honest model for one person's conversations across their
 * own machines: there are no concurrent editors to reconcile, only a laptop
 * that was asleep.
 */

const MANIFEST_VERSION = 1

/** Where a manifest, a record and a probe live, under the configured prefix. */
const MANIFEST_DIR = 'm/'
const RECORD_DIR = 'r/'

/** Old enough that every machine has certainly seen it. */
const TOMBSTONE_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000

interface ManifestEntry {
  rev: number
  /** Present and true when this is the record of a deletion. */
  deleted?: true
}

interface DeviceManifest {
  version: number
  device: string
  name: string
  at: number
  /** Keyed by `${kind}:${id}`. */
  entries: Record<string, ManifestEntry>
}

/** The part of the configuration that is not a secret, as stored locally. */
interface StoredSync extends SyncConfig {
  deviceId: string
  lastSyncedAt: number | null
  lastError: string | null
  lastResult: SyncResult | null
}

export const DEFAULT_SCOPES: SyncScopes = { conversations: true, settings: true }

function defaults(): StoredSync {
  return {
    enabled: false,
    endpoint: '',
    region: 'auto',
    bucket: '',
    prefix: 'deep-pink',
    accessKeyId: '',
    scopes: { ...DEFAULT_SCOPES },
    deviceName: hostname() || 'This machine',
    deviceId: randomUUID(),
    lastSyncedAt: null,
    lastError: null,
    lastResult: null
  }
}

const SETTING = 'sync'

function stored(): StoredSync {
  const saved = getSetting<Partial<StoredSync>>(SETTING, {})
  const merged = { ...defaults(), ...saved, scopes: { ...DEFAULT_SCOPES, ...saved.scopes } }

  // The device id is generated once and kept: it is what distinguishes this
  // machine's manifest from every other, and a new one each run would leave a
  // trail of abandoned manifests in the bucket.
  if (!saved.deviceId) setSetting(SETTING, merged)
  return merged
}

function store(next: Partial<StoredSync>): StoredSync {
  const merged = { ...stored(), ...next }
  setSetting(SETTING, merged)
  return merged
}

/* ------------------------------------------------------------------ *
 * Keys and credentials
 * ------------------------------------------------------------------ */

const KEY_SECRET = 'sync-key'
const S3_SECRET = 'sync-s3-secret'

function encryptionKey(): Buffer | null {
  const text = getSecret(KEY_SECRET)
  return text ? vault.parseKey(text) : null
}

/** Makes one and keeps it. Refuses to replace one that is already here. */
export function createKey(): string {
  if (getSecret(KEY_SECRET)) throw new Error('This machine already has a sync key')
  const key = vault.formatKey(vault.generateKey())
  setSecret(KEY_SECRET, key)
  return key
}

/** Takes a key typed in from another machine. */
export function importKey(text: string): void {
  const key = vault.parseKey(text)
  if (!key) throw new Error('That is not a Deep Pink sync key — check it was copied whole')
  setSecret(KEY_SECRET, vault.formatKey(key))
}

/** The key itself, for showing once so it can be written down. */
export function revealKey(): string | null {
  return getSecret(KEY_SECRET)
}

export function setS3Secret(secret: string): void {
  setSecret(S3_SECRET, secret.trim() || null)
}

function s3Config(config: StoredSync): S3Config | null {
  const secret = getSecret(S3_SECRET)
  if (!config.bucket || !config.accessKeyId || !secret) return null
  return {
    endpoint: config.endpoint.trim(),
    region: config.region.trim() || 'auto',
    bucket: config.bucket.trim(),
    accessKeyId: config.accessKeyId.trim(),
    secretAccessKey: secret,
    prefix: config.prefix.trim()
  }
}

/* ------------------------------------------------------------------ *
 * What the settings panel shows
 * ------------------------------------------------------------------ */

let running = false

export function state(): SyncState {
  const config = stored()
  const key = encryptionKey()

  return {
    config: {
      enabled: config.enabled,
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      prefix: config.prefix,
      accessKeyId: config.accessKeyId,
      scopes: config.scopes,
      deviceName: config.deviceName
    },
    hasKey: Boolean(key),
    // Shown so two machines can be checked against each other at a glance
    // without either of them putting the key on screen.
    keyFingerprint: key ? vault.keyFingerprint(key) : null,
    hasSecret: Boolean(getSecret(S3_SECRET)),
    ready: Boolean(key && s3Config(config)),
    running,
    lastSyncedAt: config.lastSyncedAt,
    lastError: config.lastError,
    lastResult: config.lastResult
  }
}

export function saveConfig(patch: Partial<SyncConfig>): SyncState {
  store({ ...patch, scopes: { ...stored().scopes, ...patch.scopes } })
  return state()
}

/** Forgets everything about syncing on this machine. The bucket is untouched. */
export function disconnect(): SyncState {
  const device = stored().deviceId
  setSecret(KEY_SECRET, null)
  setSecret(S3_SECRET, null)
  setSetting(SETTING, { ...defaults(), deviceId: device })
  setSetting(MANIFEST_SETTING, null)
  return state()
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

const MANIFEST_SETTING = 'sync.manifest'

function localManifest(device: string, name: string): DeviceManifest {
  const saved = getSetting<DeviceManifest | null>(MANIFEST_SETTING, null)
  if (saved && saved.device === device) return { ...saved, name }
  return { version: MANIFEST_VERSION, device, name, at: 0, entries: {} }
}

/**
 * The order things have to arrive in.
 *
 * Rows reference each other, and SQLite is told to enforce it: a message
 * belongs to a thread and a thread may be filed in a folder. Applying them in
 * this order means a pull never has to come back for a second pass.
 */
const ARRIVAL_ORDER: records.RecordKind[] = [
  'folder',
  'thread',
  'message',
  'attachment',
  'setting',
  'mcp'
]

function kindOf(logical: string): records.RecordKind {
  return logical.slice(0, logical.indexOf(':')) as records.RecordKind
}

function recordObject(key: Buffer, logical: string, rev: number): string {
  return `${RECORD_DIR}${vault.objectName(key, `record:${logical}:${rev}`)}`
}

export interface SyncOptions {
  /** Injected by the tests, which have a bucket in memory rather than a network. */
  fetcher?: Fetcher
  /** Called as work is done, for the progress line in Settings. */
  onProgress?: (done: number, total: number) => void
}

/**
 * One full sync: read everything, take what is newer, offer what is newer.
 *
 * Never throws for anything the user can fix — a wrong bucket name, a laptop
 * with no network — because the caller is often a timer, and an unhandled
 * rejection every five minutes is not a way to report that the Wi-Fi is off.
 */
export async function run(options: SyncOptions = {}): Promise<SyncResult> {
  const at = Date.now()
  const empty: SyncResult = {
    at,
    pushed: 0,
    pulled: 0,
    deleted: 0,
    devices: 0,
    bytesUp: 0,
    bytesDown: 0,
    error: null
  }

  if (running) return { ...empty, error: 'A sync is already running' }

  const config = stored()
  const key = encryptionKey()
  const credentials = s3Config(config)

  if (!config.enabled) return { ...empty, error: 'Sync is switched off' }
  if (!key) return { ...empty, error: 'No sync key on this machine yet' }
  if (!credentials) return { ...empty, error: 'The bucket is not fully configured' }

  const kinds = records.kindsFor(config.scopes)
  if (!kinds.length) return { ...empty, error: 'Nothing is selected to sync' }

  running = true
  const client = new S3Client(credentials, options.fetcher)
  const result: SyncResult = { ...empty }

  try {
    /* ---- everyone's manifests, including the copy of ours out there ---- */

    const mine = localManifest(config.deviceId, config.deviceName)
    const myName = `${MANIFEST_DIR}${vault.objectName(key, `manifest:${config.deviceId}`)}`

    const listed = await client.list(MANIFEST_DIR)
    const theirs: DeviceManifest[] = []

    for (const object of listed) {
      const name = object.key.slice(object.key.lastIndexOf('/') + 1)
      const path = `${MANIFEST_DIR}${name}`
      if (path === myName) continue

      const sealed = await client.get(path)
      if (!sealed) continue
      result.bytesDown += sealed.length

      // A manifest that will not open belongs to a different key. Someone
      // else's bucket, or an old key: not an error, just not ours.
      const manifest = vault.openJson<DeviceManifest>(key, path, sealed)
      if (manifest?.entries) theirs.push(manifest)
    }
    result.devices = theirs.length + 1

    /* ---- what is here ---- */

    const local = records.localRevisions(kinds)
    const wanted = new Set<string>(kinds)

    /* ---- what is out there, best copy per record ---- */

    interface Winner extends ManifestEntry {
      device: string
    }
    const best = new Map<string, Winner>()

    for (const manifest of theirs) {
      for (const [logical, entry] of Object.entries(manifest.entries)) {
        if (!wanted.has(logical.slice(0, logical.indexOf(':')))) continue
        const held = best.get(logical)
        // Later revision wins; at the same revision a deletion does, because a
        // record that has been deleted somewhere is not one to hand back.
        const better =
          !held ||
          entry.rev > held.rev ||
          (entry.rev === held.rev && Boolean(entry.deleted) && !held.deleted)
        if (better) best.set(logical, { ...entry, device: manifest.device })
      }
    }

    /* ---- pull ---- */

    const db = getDb()
    let done = 0
    const total = best.size

    // In dependency order. A thread whose folder has not arrived yet cannot be
    // filed in it, and a message whose thread is missing cannot be written at
    // all — so the things that are pointed at go first.
    const arriving = [...best.entries()].sort(
      ([a], [b]) => ARRIVAL_ORDER.indexOf(kindOf(a)) - ARRIVAL_ORDER.indexOf(kindOf(b))
    )

    for (const [logical, entry] of arriving) {
      options.onProgress?.(done++, total)

      const kind = kindOf(logical)
      const id = logical.slice(logical.indexOf(':') + 1)

      const here = local.records.get(logical)
      const removedHere = local.deletions.get(logical) ?? 0

      // Deleted here later than it was written there: our deletion is the
      // newer fact, and pulling would undo it.
      if (removedHere >= entry.rev) continue

      if (entry.deleted) {
        if (here === undefined) continue
        db.transaction(() => records.applyDeletion(kind, id))()
        result.deleted++
        continue
      }

      if (here !== undefined && here >= entry.rev) continue

      const path = recordObject(key, logical, entry.rev)
      const sealed = await client.get(path)
      // Missing means whoever wrote the manifest has not finished pushing, or
      // pruned it. Either way it will come round again next time.
      if (!sealed) continue
      result.bytesDown += sealed.length

      const record = vault.openJson<records.SyncRecord>(key, path, sealed)
      if (!record || record.kind !== kind || record.id !== id) continue

      db.transaction(() => records.applyRecord({ ...record, rev: entry.rev }))()
      result.pulled++
    }

    /* ---- push ---- */

    // What other machines already hold, so nothing is uploaded twice and an
    // object still referenced by somebody is never collected.
    const elsewhere = new Set<string>()
    for (const manifest of theirs) {
      for (const [logical, entry] of Object.entries(manifest.entries)) {
        if (!entry.deleted) elsewhere.add(`${logical}@${entry.rev}`)
      }
    }

    const entries: Record<string, ManifestEntry> = { ...mine.entries }
    const superseded: string[] = []
    // An idle machine should cost one listing and nothing else; re-uploading an
    // unchanged manifest every five minutes is a write per machine per run,
    // forever, for no information.
    let changed = mine.at === 0

    for (const [logical, rev] of local.records) {
      const known = entries[logical]
      if (known && !known.deleted && known.rev >= rev) continue

      const separator = logical.indexOf(':')
      const kind = logical.slice(0, separator) as records.RecordKind
      const record = records.readRecord(kind, logical.slice(separator + 1))
      if (!record) continue

      const path = recordObject(key, logical, record.rev)
      if (!elsewhere.has(`${logical}@${record.rev}`)) {
        const sealed = vault.sealJson(key, path, record)
        await client.put(path, sealed)
        result.bytesUp += sealed.length
      }

      if (known && !known.deleted && known.rev < record.rev) {
        superseded.push(recordObject(key, logical, known.rev))
      }
      entries[logical] = { rev: record.rev }
      changed = true
      result.pushed++
    }

    for (const [logical, deletedAt] of local.deletions) {
      const known = entries[logical]
      if (known?.deleted) continue
      if (known && !known.deleted) superseded.push(recordObject(key, logical, known.rev))
      entries[logical] = { rev: deletedAt, deleted: true }
      changed = true
      result.pushed++
    }

    /* ---- our manifest, last: it is the index of what is already there ---- */

    if (changed || mine.name !== config.deviceName) {
      const manifest: DeviceManifest = {
        version: MANIFEST_VERSION,
        device: config.deviceId,
        name: config.deviceName,
        at: Date.now(),
        entries
      }
      const sealedManifest = vault.sealJson(key, myName, manifest)
      await client.put(myName, sealedManifest)
      result.bytesUp += sealedManifest.length
      setSetting(MANIFEST_SETTING, manifest)
    }

    /* ---- collect what nothing points at any more ---- */

    for (const path of superseded) {
      try {
        await client.remove(path)
      } catch {
        // Garbage that outlives a run is only wasted bytes; failing the sync
        // over it would be worse than leaving it.
      }
    }

    records.pruneDeletions(TOMBSTONE_LIFETIME_MS)
    store({ lastSyncedAt: result.at, lastError: null, lastResult: result })
    options.onProgress?.(total, total)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    store({ lastError: message })
    return { ...result, error: message }
  } finally {
    running = false
  }
}

/** Writes and reads back a probe object, so a wrong setting says so at once. */
export async function testConnection(fetcher?: Fetcher): Promise<void> {
  const config = stored()
  const credentials = s3Config(config)
  if (!credentials) throw new Error('The bucket is not fully configured')

  const key = encryptionKey()
  if (!key) throw new Error('No sync key on this machine yet')

  // Named and sealed like everything else, so even the probe leaves nothing
  // in the bucket that says what wrote it.
  const name = `${RECORD_DIR}${vault.objectName(key, 'connection-probe')}`
  await new S3Client(credentials, fetcher).check(name, vault.seal(key, name, Buffer.from('ok')))
}
