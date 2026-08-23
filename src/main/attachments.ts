import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, protocol } from 'electron'
import type { Attachment, AttachmentKind, PendingAttachment } from '@shared/types'
import { getDb } from './db/index'

/**
 * Image attachments.
 *
 * The bytes are written to files under the user data directory and never travel
 * over IPC after that: the renderer references them by URL and Chromium fetches
 * them through the `dpimg://` protocol below. Keeping them out of the transcript
 * payload is what stops a thread with twenty screenshots from serialising tens
 * of megabytes on every render.
 */

/** Image formats every provider accepts. Anything else is refused, not guessed. */
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** Well beyond any screenshot, and far below what would stall a request. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** Text is inlined into the prompt, so the ceiling is much lower than an image. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 8

/** Text is anything not an image; the composer decides what it will offer. */
export function kindOf(mime: string): AttachmentKind {
  return mime.startsWith('image/') ? 'image' : 'text'
}

const PREVIEW_CHARS = 600

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const SCHEME = 'dpimg'

function dir(): string {
  const path = join(app.getPath('userData'), 'attachments')
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

function fileFor(id: string): string {
  // The id is always one we generated, but this is the only thing standing
  // between a URL path and the filesystem, so verify the shape regardless.
  if (!UUID.test(id)) throw new Error('Not an attachment id')
  return join(dir(), id)
}

interface AttachmentRow {
  id: string
  message_id: string
  thread_id: string
  mime: string
  filename: string
  bytes: number
  width: number | null
  height: number | null
  created_at: number
  preview: string | null
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    messageId: row.message_id,
    mime: row.mime,
    filename: row.filename,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    url: `${SCHEME}://attachment/${row.id}`,
    kind: kindOf(row.mime),
    preview: row.preview ?? null
  }
}

/** Validates and stores one image, returning its metadata. */
export function store(
  threadId: string,
  messageId: string,
  input: PendingAttachment
): Attachment {
  const kind = kindOf(input.mime)
  if (kind === 'image' && !ALLOWED_IMAGE_MIME.has(input.mime)) {
    throw new Error(`${input.mime || 'that file type'} is not a supported image format`)
  }

  const buffer = Buffer.from(input.data, 'base64')
  if (!buffer.length) throw new Error('That attachment was empty')

  const limit = kind === 'image' ? MAX_ATTACHMENT_BYTES : MAX_TEXT_BYTES
  if (buffer.length > limit) {
    throw new Error(
      `That ${kind === 'image' ? 'image' : 'text'} is ${(buffer.length / 1024 / 1024).toFixed(
        1
      )} MB; the limit is ${limit / 1024 / 1024} MB`
    )
  }

  // Reject anything claiming to be text that is actually binary — a NUL byte in
  // the first few KB is the usual giveaway, and inlining binary into a prompt
  // wastes tokens and confuses the model.
  if (kind === 'text' && buffer.subarray(0, 8192).includes(0)) {
    throw new Error(`${input.filename || 'That file'} looks binary, not text`)
  }

  const preview =
    kind === 'text' ? buffer.subarray(0, PREVIEW_CHARS * 4).toString('utf8').slice(0, PREVIEW_CHARS) : null

  const id = randomUUID()
  writeFileSync(fileFor(id), buffer, { mode: 0o600 })

  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO attachments (id, message_id, thread_id, mime, filename, bytes, width, height, created_at, preview)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      messageId,
      threadId,
      input.mime,
      input.filename.slice(0, 200),
      buffer.length,
      input.width,
      input.height,
      now,
      preview
    )

  return toAttachment({
    id,
    message_id: messageId,
    thread_id: threadId,
    mime: input.mime,
    filename: input.filename,
    bytes: buffer.length,
    width: input.width,
    height: input.height,
    created_at: now,
    preview
  })
}

/** Absolute path of a stored image, for opening it in the OS viewer. */
export function filePath(id: string): string | null {
  const row = getDb().prepare('SELECT id FROM attachments WHERE id = ?').get(id) as
    | { id: string }
    | undefined
  if (!row) return null
  const path = fileFor(row.id)
  return existsSync(path) ? path : null
}

export function forMessage(messageId: string): Attachment[] {
  const rows = getDb()
    .prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at')
    .all(messageId) as AttachmentRow[]
  return rows.map(toAttachment)
}

export function forThread(threadId: string): Map<string, Attachment[]> {
  const rows = getDb()
    .prepare('SELECT * FROM attachments WHERE thread_id = ? ORDER BY created_at')
    .all(threadId) as AttachmentRow[]

  const byMessage = new Map<string, Attachment[]>()
  for (const row of rows) {
    const list = byMessage.get(row.message_id) ?? []
    list.push(toAttachment(row))
    byMessage.set(row.message_id, list)
  }
  return byMessage
}

/** Full text of a text attachment. Read on demand, never held in the row. */
export function readText(id: string): string | null {
  const row = getDb().prepare('SELECT id, mime FROM attachments WHERE id = ?').get(id) as
    | { id: string; mime: string }
    | undefined
  if (!row || kindOf(row.mime) === 'image') return null
  try {
    return readFileSync(fileFor(row.id), 'utf8')
  } catch {
    return null
  }
}

/** The bytes as base64, for writing an attachment into an export. */
export function readBase64(id: string): string | null {
  try {
    return readFileSync(fileFor(id)).toString('base64')
  } catch {
    return null
  }
}

/** The data URL a provider expects. Read from disk only when a request needs it. */
export function toDataUrl(attachment: Attachment): string {
  const bytes = readFileSync(fileFor(attachment.id))
  return `data:${attachment.mime};base64,${bytes.toString('base64')}`
}

/**
 * Deletes files whose database row is gone — messages and threads cascade on
 * delete, which leaves the bytes behind. Run at startup rather than tracking
 * every delete path.
 */
export function collectOrphans(): number {
  const path = dir()
  const known = new Set(
    (getDb().prepare('SELECT id FROM attachments').all() as { id: string }[]).map((r) => r.id)
  )

  let removed = 0
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  for (const name of readdirSync(path)) {
    if (known.has(name)) continue
    try {
      rmSync(join(path, name))
      removed++
    } catch {
      /* leave it; it will be tried again next launch */
    }
  }
  return removed
}

/**
 * Must run before the app is ready, so Chromium treats the scheme as a normal
 * secure origin rather than something to block.
 */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/** Serves stored images to the renderer. Reads nothing outside its own folder. */
export function registerProtocolHandler(): void {
  protocol.handle(SCHEME, (request) => {
    let id: string
    let mime: string
    try {
      id = new URL(request.url).pathname.replace(/^\/+/, '')
      const row = getDb().prepare('SELECT mime FROM attachments WHERE id = ?').get(id) as
        | { mime: string }
        | undefined
      if (!row) return new Response('Not found', { status: 404 })
      mime = row.mime
      return new Response(readFileSync(fileFor(id)), {
        status: 200,
        headers: { 'Content-Type': mime, 'Cache-Control': 'private, max-age=31536000' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
