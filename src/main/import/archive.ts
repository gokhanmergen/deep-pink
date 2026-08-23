import { existsSync } from 'node:fs'
import type { ImportPreview, ImportResult, ThreadConfig } from '@shared/types'
import * as attachments from '../attachments'
import { getDb } from '../db/index'
import * as repo from '../db/repo'
import type { ArchivedThread, ArchiveReport } from '../export/archive'

/**
 * Reading a Deep Pink thread export back into the library.
 *
 * The point of the format is that nothing is lost, so this restores what an
 * ordinary chat does not carry: the thread's settings, what each turn cost, the
 * tool calls behind it, and the folder it was filed in. Everything is written
 * under a fresh id — a copy of a conversation is a new conversation — and the
 * id it had where it came from is kept only so importing the same file twice
 * does nothing the second time.
 */

/** Marks a thread as having come from an export of this app. */
const SOURCE = 'deep-pink'

function alreadyImported(threads: ArchivedThread[]): Set<string> {
  const db = getDb()
  const stmt = db.prepare('SELECT source_id FROM threads WHERE source = ? AND source_id = ?')
  const found = new Set<string>()
  for (const thread of threads) {
    if (stmt.get(SOURCE, thread.id)) found.add(thread.id)
  }
  return found
}

/**
 * Every model the file names, thread settings and answered turns alike.
 *
 * `known` is null when the catalogue could not be fetched — offline, or without
 * a key. Nothing is reported as unavailable in that case, because "we could not
 * check" and "you do not have it" are different answers.
 */
function unavailableModels(threads: ArchivedThread[], known: Set<string> | null): string[] {
  if (!known) return []

  const referenced = new Set<string>()
  for (const thread of threads) {
    if (thread.config.model) referenced.add(thread.config.model)
    for (const message of thread.messages) {
      if (message.model) referenced.add(message.model)
    }
  }

  return [...referenced].filter((model) => !known.has(model)).sort()
}

function summarise(report: ArchiveReport, filename: string, known: Set<string> | null): ImportPreview {
  const times = report.threads.map((t) => t.createdAt).filter((t) => t > 0)

  return {
    kind: 'deep-pink',
    filename,
    conversations: report.threads.length,
    messages: report.threads.reduce((n, t) => n + t.messages.length, 0),
    alreadyImported: alreadyImported(report.threads).size,
    oldest: times.length ? Math.min(...times) : null,
    newest: times.length ? Math.max(...times) : null,
    skipped: report.skipped,
    imagesFound: report.threads.reduce(
      (n, t) => n + t.messages.reduce((m, msg) => m + msg.attachments.length, 0),
      0
    ),
    unavailableModels: unavailableModels(report.threads, known)
  }
}

export function previewArchive(
  report: ArchiveReport,
  filename: string,
  known: Set<string> | null
): ImportPreview {
  return summarise(report, filename, known)
}

/**
 * Settings as they can apply here.
 *
 * A thread carries the machine it was written on with it: directories that
 * exist there, MCP servers configured there, a model that account could reach.
 * Each is kept only if it still means something, and dropped quietly if not —
 * an import that failed because a folder had been moved would be no use to
 * anyone. The model is the exception: it is reported, because which model a
 * thread talks to is the user's decision and they should know it changed.
 */
function usableConfig(
  config: ThreadConfig,
  known: Set<string> | null
): { config: ThreadConfig; modelCleared: boolean } {
  const localServers = new Set(repo.listMcpServers().map((server) => server.id))
  const modelCleared = Boolean(config.model && known && !known.has(config.model))

  return {
    modelCleared,
    config: {
      ...config,
      model: modelCleared ? null : config.model,
      enabledMcpServers: config.enabledMcpServers
        ? config.enabledMcpServers.filter((id) => localServers.has(id))
        : null,
      repoPaths: config.repoPaths.filter((path) => existsSync(path))
    }
  }
}

export function importArchive(
  report: ArchiveReport,
  filename: string,
  known: Set<string> | null
): ImportResult {
  const base = summarise(report, filename, known)
  const existing = alreadyImported(report.threads)
  const db = getDb()

  let threadsCreated = 0
  let messagesCreated = 0
  let imagesAttached = 0
  let imagesMissing = 0
  let modelsCleared = 0

  /** A folder of that name, or a new one. Names are what an export carries. */
  const folderIdFor = (name: string): string | null => {
    const wanted = repo.normalizeFolderName(name)
    if (!wanted) return null
    const match = repo
      .listFolders()
      .find((folder) => folder.name.toLowerCase() === wanted.toLowerCase())
    return match ? match.id : (repo.createFolder(wanted)?.id ?? null)
  }

  const insertOne = (archived: ArchivedThread): void => {
    const { config, modelCleared } = usableConfig(archived.config, known)
    if (modelCleared) modelsCleared++

    const thread = repo.createThread(archived.title, config)
    threadsCreated++

    /** Old id → new id, so compaction links can be re-pointed afterwards. */
    const idMap = new Map<string, string>()

    for (const message of archived.messages) {
      const stored = repo.insertMessage({
        threadId: thread.id,
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
        isCompactionSummary: message.isCompactionSummary
      })
      idMap.set(message.id, stored.id)
      messagesCreated++

      if (message.usage) {
        // Restored rather than recalculated: this is money that was spent, and
        // the statistics on the machine it came from should match here.
        repo.recordUsage(
          thread.id,
          stored.id,
          message.model,
          message.provider,
          message.usage,
          message.createdAt
        )
      }

      for (const invocation of message.toolInvocations) {
        repo.recordToolInvocation({
          threadId: thread.id,
          messageId: stored.id,
          source: invocation.source as 'mcp' | 'web' | 'repo',
          serverId: invocation.serverId,
          toolName: invocation.toolName,
          isError: invocation.isError,
          durationMs: invocation.durationMs,
          resultChars: invocation.resultChars,
          createdAt: invocation.createdAt
        })
      }

      for (const attachment of message.attachments) {
        try {
          attachments.store(thread.id, stored.id, {
            mime: attachment.mime,
            filename: attachment.filename,
            data: attachment.data,
            width: attachment.width,
            height: attachment.height
          })
          imagesAttached++
        } catch {
          // Refused by the same rules the composer applies — too large, or not
          // a format any provider takes. The message keeps its text.
          imagesMissing++
        }
      }
    }

    // Compaction links point at message ids, which have all just changed. A
    // link to something outside this thread is dropped rather than guessed at,
    // which un-hides the message instead of hiding it behind nothing.
    const relink = db.prepare('UPDATE messages SET compacted_into = ? WHERE id = ?')
    for (const message of archived.messages) {
      if (!message.compactedInto) continue
      const from = idMap.get(message.id)
      const into = idMap.get(message.compactedInto)
      if (from && into) relink.run(into, from)
    }

    // Last, because inserting a message stamps its thread as edited. Doing this
    // first would leave every imported thread looking like it was touched now.
    db.prepare(
      `UPDATE threads
          SET source = ?, source_id = ?, created_at = ?, updated_at = ?, pinned = ?, folder_id = ?
        WHERE id = ?`
    ).run(
      SOURCE,
      archived.id,
      archived.createdAt,
      archived.updatedAt,
      archived.pinned ? 1 : 0,
      archived.folder ? folderIdFor(archived.folder) : null,
      thread.id
    )
  }

  // One transaction: a half-restored conversation is worse than none.
  db.transaction(() => {
    for (const archived of report.threads) {
      if (existing.has(archived.id)) continue
      insertOne(archived)
    }
  })()

  return { ...base, threadsCreated, messagesCreated, imagesAttached, imagesMissing, modelsCleared }
}
