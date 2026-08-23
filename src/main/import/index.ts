import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { unzipSync } from 'fflate'
import { getDb } from '../db/index'
import * as repo from '../db/repo'
import * as attachments from '../attachments'
import type { ImportPreview, ImportResult } from '@shared/types'
import { looksLikeArchive, parseArchive, type ArchiveReport } from '../export/archive'
import { importArchive, previewArchive } from './archive'
import { assetIdFrom, parseExport, type ParsedConversation, type ParseReport } from './chatgpt'

/**
 * The front door for anything read off disk: a ChatGPT export, or a thread this
 * app wrote itself. Which one it is is decided by looking inside rather than by
 * asking the user, because a file knows what it is and they should not have to.
 */

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

interface LoadedExport {
  report: ParseReport
  /** Asset id (`file-ABC123`) → bytes, for images bundled in the archive. */
  assets: Map<string, { name: string; bytes: Uint8Array }>
  filename: string
}

/**
 * Accepts either the whole ChatGPT export archive or a bare
 * `conversations.json`. People unpack the zip about as often as they don't.
 */
export function loadExport(path: string): LoadedExport {
  const filename = basename(path)
  const raw = readFileSync(path)
  const assets = new Map<string, { name: string; bytes: Uint8Array }>()

  if (extname(path).toLowerCase() === '.zip') {
    const entries = unzipSync(new Uint8Array(raw))

    const conversationsKey = Object.keys(entries).find((name) =>
      name.replace(/\\/g, '/').endsWith('conversations.json')
    )
    if (!conversationsKey) {
      throw new Error('That archive has no conversations.json — is it a ChatGPT export?')
    }

    for (const [name, bytes] of Object.entries(entries)) {
      const ext = extname(name).toLowerCase()
      if (!MIME_BY_EXT[ext]) continue
      const id = assetIdFrom(basename(name))
      if (id) assets.set(id, { name: basename(name), bytes })
    }

    const json = JSON.parse(Buffer.from(entries[conversationsKey]).toString('utf8')) as unknown
    return { report: parseExport(json), assets, filename }
  }

  return { report: parseExport(readJson(raw) as unknown), assets, filename }
}

function readJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('That file is not readable JSON — choose a ChatGPT export or a Deep Pink thread.')
  }
}

/**
 * What a chosen file turned out to be, read once so a preview and the import
 * that follows it cannot disagree about what they are looking at.
 */
type Chosen =
  | { kind: 'chatgpt'; filename: string; loaded: LoadedExport }
  | { kind: 'deep-pink'; filename: string; report: ArchiveReport }

function load(path: string): Chosen {
  const filename = basename(path)

  // Only ChatGPT ships a zip; anything else is JSON, and JSON is where the two
  // formats have to be told apart. Parsed once here rather than sniffed and
  // then read again — a year of ChatGPT is a large file to read twice.
  if (extname(path).toLowerCase() !== '.zip') {
    const json = readJson(readFileSync(path))
    return looksLikeArchive(json)
      ? { kind: 'deep-pink', filename, report: parseArchive(json) }
      : { kind: 'chatgpt', filename, loaded: { report: parseExport(json), assets: new Map(), filename } }
  }

  return { kind: 'chatgpt', filename, loaded: loadExport(path) }
}

function alreadyImportedIds(sourceIds: string[]): Set<string> {
  if (!sourceIds.length) return new Set()
  const db = getDb()
  const found = new Set<string>()
  const stmt = db.prepare("SELECT source_id FROM threads WHERE source = 'chatgpt' AND source_id = ?")
  for (const id of sourceIds) {
    if (stmt.get(id)) found.add(id)
  }
  return found
}

function summarise(loaded: LoadedExport): ImportPreview {
  const { conversations, skipped } = loaded.report
  const existing = alreadyImportedIds(conversations.map((c) => c.sourceId))

  const times = conversations.map((c) => c.createdAt).filter((t) => t > 0)
  return {
    kind: 'chatgpt',
    filename: loaded.filename,
    conversations: conversations.length,
    messages: conversations.reduce((n, c) => n + c.messages.length, 0),
    alreadyImported: existing.size,
    oldest: times.length ? Math.min(...times) : null,
    newest: times.length ? Math.max(...times) : null,
    skipped,
    imagesFound: loaded.assets.size,
    // ChatGPT names models this app cannot route to anyway, and an imported
    // thread is left on your default rather than pointed at one of them, so
    // there is nothing here to warn about.
    unavailableModels: []
  }
}

/**
 * Reads the file and reports what would happen, without writing anything.
 *
 * `knownModels` is the OpenRouter catalogue as this account sees it, passed in
 * rather than fetched so that reading a file never depends on the network.
 * Null means it could not be checked.
 */
export function preview(path: string, knownModels: Set<string> | null = null): ImportPreview {
  const chosen = load(path)
  return chosen.kind === 'deep-pink'
    ? previewArchive(chosen.report, chosen.filename, knownModels)
    : summarise(chosen.loaded)
}

export function importFile(path: string, knownModels: Set<string> | null = null): ImportResult {
  const chosen = load(path)
  if (chosen.kind === 'deep-pink') {
    return importArchive(chosen.report, chosen.filename, knownModels)
  }

  const loaded = chosen.loaded
  const base = summarise(loaded)
  const existing = alreadyImportedIds(loaded.report.conversations.map((c) => c.sourceId))

  let threadsCreated = 0
  let messagesCreated = 0
  let imagesAttached = 0
  let imagesMissing = 0

  const db = getDb()

  const insertOne = (conversation: ParsedConversation): void => {
    const thread = repo.createThread(conversation.title)
    db.prepare("UPDATE threads SET source = 'chatgpt', source_id = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run(conversation.sourceId, conversation.createdAt, conversation.updatedAt, thread.id)
    threadsCreated++

    for (const message of conversation.messages) {
      // No usage row is written on purpose: these turns were paid for
      // elsewhere, and inventing costs would corrupt the statistics.
      const stored = repo.insertMessage({
        threadId: thread.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        model: message.model
      })
      messagesCreated++

      for (const assetId of message.assets) {
        const asset = loaded.assets.get(assetId)
        if (!asset) {
          imagesMissing++
          continue
        }
        try {
          attachments.store(thread.id, stored.id, {
            mime: MIME_BY_EXT[extname(asset.name).toLowerCase()] ?? 'image/png',
            filename: asset.name,
            data: Buffer.from(asset.bytes).toString('base64'),
            width: null,
            height: null
          })
          imagesAttached++
        } catch {
          imagesMissing++
        }
      }
    }
  }

  // One transaction: a half-finished import is worse than none.
  db.transaction(() => {
    for (const conversation of loaded.report.conversations) {
      if (existing.has(conversation.sourceId)) continue
      insertOne(conversation)
    }
  })()

  return { ...base, threadsCreated, messagesCreated, imagesAttached, imagesMissing, modelsCleared: 0 }
}
