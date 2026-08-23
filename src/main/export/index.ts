import { writeFileSync } from 'node:fs'
import type { ExportFormat } from '@shared/types'
import * as attachments from '../attachments'
import * as repo from '../db/repo'
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  type ArchivedMessage,
  type ArchivedThread,
  type ThreadArchive
} from './archive'
import { toMarkdown } from './markdown'

/**
 * Turning a thread in the database into a file.
 *
 * Two formats, and the difference is the point: Markdown is for reading and
 * for handing to somebody else, and the archive is what this app can read
 * back. Both are written here so the two can never disagree about which thread
 * they were given.
 */

export interface ExportedFile {
  /** What to call it, before the user is asked where to put it. */
  filename: string
  contents: string
}

/**
 * A title as a filename.
 *
 * Only what a filesystem objects to is removed. An earlier version stripped
 * everything outside `[\w -]`, which quietly emptied the name of any thread not
 * written in English.
 */
export function toFilename(title: string, extension: string): string {
  const base = title
    // Control characters first, then what a filesystem reserves. A leading
    // dot would hide the file; a trailing one is refused on Windows.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim()

  return `${base || 'thread'}.${extension}`
}

/** The visible transcript, as Markdown. */
export function markdownFor(threadId: string, appVersion: string): ExportedFile | null {
  const thread = repo.getThread(threadId)
  if (!thread) return null

  const folder = thread.folderId ? repo.getFolder(thread.folderId) : null

  return {
    filename: toFilename(thread.title, 'md'),
    contents: toMarkdown(thread, repo.getMessages(threadId), {
      appVersion,
      exportedAt: Date.now(),
      folder: folder?.name ?? null
    })
  }
}

function archiveThread(threadId: string): ArchivedThread | null {
  const thread = repo.getThread(threadId)
  if (!thread) return null

  const folder = thread.folderId ? repo.getFolder(thread.folderId) : null

  // Everything, including what compaction replaced: an archive that quietly
  // dropped the original context would not be the conversation any more.
  const messages = repo.getMessages(threadId, true)

  const invocations = repo.listToolInvocations(threadId)
  const byMessage = new Map<string, typeof invocations>()
  for (const invocation of invocations) {
    const list = byMessage.get(invocation.messageId) ?? []
    list.push(invocation)
    byMessage.set(invocation.messageId, list)
  }

  const archived: ArchivedMessage[] = messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    reasoning: message.reasoning,
    createdAt: message.createdAt,
    model: message.model,
    provider: message.provider,
    status: message.status,
    error: message.error,
    toolCalls: message.toolCalls,
    toolResult: message.toolResult,
    systemPromptSnapshot: message.systemPromptSnapshot,
    isCompactionSummary: message.isCompactionSummary,
    compactedInto: message.compactedInto,
    usage: message.usage,
    toolInvocations: (byMessage.get(message.id) ?? []).map(
      ({ messageId: _messageId, ...invocation }) => invocation
    ),
    attachments: message.attachments.flatMap((attachment) => {
      const data = attachments.readBase64(attachment.id)
      // A missing file means the bytes were lost, not that the export failed;
      // the message it belonged to still goes.
      if (!data) return []
      return [
        {
          filename: attachment.filename,
          mime: attachment.mime,
          width: attachment.width,
          height: attachment.height,
          data
        }
      ]
    })
  }))

  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    pinned: thread.pinned,
    folder: folder?.name ?? null,
    config: thread.config,
    messages: archived
  }
}

/** One or more threads in the format this app can read back. */
export function buildArchive(threadIds: string[], appVersion: string): ThreadArchive {
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: Date.now(),
    app: { name: 'Deep Pink', version: appVersion },
    threads: threadIds
      .map(archiveThread)
      .filter((thread): thread is ArchivedThread => thread !== null)
  }
}

export function archiveFor(threadId: string, appVersion: string): ExportedFile | null {
  const archive = buildArchive([threadId], appVersion)
  if (!archive.threads.length) return null

  return {
    filename: toFilename(archive.threads[0].title, 'dpthread.json'),
    contents: `${JSON.stringify(archive, null, 2)}\n`
  }
}

export function fileFor(
  threadId: string,
  format: ExportFormat,
  appVersion: string
): ExportedFile | null {
  return format === 'markdown' ? markdownFor(threadId, appVersion) : archiveFor(threadId, appVersion)
}

export function write(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8')
}
