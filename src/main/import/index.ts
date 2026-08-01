import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { unzipSync } from 'fflate'
import { getDb } from '../db/index'
import * as repo from '../db/repo'
import * as attachments from '../attachments'
import type { ImportPreview, ImportResult } from '@shared/types'
import { assetIdFrom, parseExport, type ParsedConversation, type ParseReport } from './chatgpt'

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
 * Accepts either the whole export archive or a bare `conversations.json`.
 * People unpack the zip about as often as they don't.
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

  return { report: parseExport(JSON.parse(raw.toString('utf8')) as unknown), assets, filename }
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
    filename: loaded.filename,
    conversations: conversations.length,
    messages: conversations.reduce((n, c) => n + c.messages.length, 0),
    alreadyImported: existing.size,
    oldest: times.length ? Math.min(...times) : null,
    newest: times.length ? Math.max(...times) : null,
    skipped,
    imagesFound: loaded.assets.size
  }
}

/** Reads the file and reports what would happen, without writing anything. */
export function preview(path: string): ImportPreview {
  return summarise(loadExport(path))
}

export function importFile(path: string): ImportResult {
  const loaded = loadExport(path)
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

  return { ...base, threadsCreated, messagesCreated, imagesAttached, imagesMissing }
}
