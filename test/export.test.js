const fs = require('node:fs')
const path = require('node:path')
const { suite } = require('./support/harness')

/**
 * Exporting a thread, and reading one back.
 *
 * The round trip runs against a real database: a thread is built, exported,
 * everything is wiped, and the file is imported into the empty library. What
 * comes back out has to be what went in — that is the whole promise of the
 * format, and the only way to check it is to make the library forget.
 */

/** A 1×1 PNG, the smallest thing the attachment store will accept. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const MODEL = 'anthropic/claude-sonnet-4.5'
const t = (n) => 1_700_000_000_000 + n * 1000

suite('export — Markdown, archives and the trip back', async ({ check, section, subject, tmpDir }) => {
  const { getDb, repo, exporter, archive, toMarkdown, importer } = subject
  getDb()

  section('filenames')
  check('a plain title becomes a filename', exporter.toFilename('Rust ownership', 'md') === 'Rust ownership.md')
  check(
    'path separators and reserved characters go',
    exporter.toFilename('a/b:c*d?"e<f>g|h', 'md') === 'a b c d e f g h.md'
  )
  check('non-English titles survive', exporter.toFilename('Türkçe başlık', 'md') === 'Türkçe başlık.md')
  check('a title of nothing usable falls back', exporter.toFilename('///', 'md') === 'thread.md')
  check('a leading dot does not make it hidden', !exporter.toFilename('.hidden', 'md').startsWith('.'))

  section('a thread to export')
  const folder = repo.createFolder('Systems')
  const thread = repo.createThread('Rust ownership', {
    model: MODEL,
    temperature: 0.4,
    systemPrompt: 'Be terse.',
    repoPaths: ['/definitely/not/here'],
    enabledMcpServers: ['a-server-that-is-not-installed']
  })
  repo.setThreadFolder(thread.id, folder.id)
  repo.updateThread(thread.id, { pinned: true })

  const question = repo.insertMessage({
    threadId: thread.id,
    role: 'user',
    content: 'Explain the borrow checker',
    createdAt: t(0)
  })
  subject.attachments.store(thread.id, question.id, {
    mime: 'image/png',
    filename: 'diagram.png',
    data: PNG,
    width: 1,
    height: 1
  })

  const answer = repo.insertMessage({
    threadId: thread.id,
    role: 'assistant',
    content: 'Ownership means one owner at a time.\n\n```rust\nlet a = b;\n```',
    reasoning: 'Start from moves, then borrows.',
    model: MODEL,
    provider: 'anthropic',
    createdAt: t(30),
    toolCalls: [{ id: 'call-1', name: 'web_search', arguments: '{"query":"borrow checker"}' }]
  })
  repo.recordUsage(thread.id, answer.id, MODEL, 'anthropic', {
    promptTokens: 120,
    completionTokens: 340,
    reasoningTokens: 12,
    cachedTokens: 20,
    totalTokens: 460,
    costUsd: 0.00234,
    latencyMs: 2100,
    timeToFirstTokenMs: 380,
    tokensPerSecond: 42.5,
    generationId: 'gen-1'
  })
  repo.recordToolInvocation({
    threadId: thread.id,
    messageId: answer.id,
    source: 'web',
    serverId: null,
    toolName: 'web_search',
    isError: false,
    durationMs: 900,
    resultChars: 1200,
    createdAt: t(31)
  })

  const toolReply = repo.insertMessage({
    threadId: thread.id,
    role: 'tool',
    content: 'three results',
    createdAt: t(32),
    toolResult: {
      toolCallId: 'call-1',
      name: 'web_search',
      content: 'A result mentioning ``` a fence',
      isError: false,
      durationMs: 900
    }
  })

  // An older exchange that compaction replaced, and the summary that stands in
  // for it. Both have to come back, still pointing at each other.
  const replaced = repo.insertMessage({
    threadId: thread.id,
    role: 'user',
    content: 'An older question, since summarised',
    createdAt: t(40)
  })
  const summary = repo.insertMessage({
    threadId: thread.id,
    role: 'assistant',
    content: 'Earlier: the user asked about moves.',
    createdAt: t(41),
    isCompactionSummary: true
  })
  repo.markCompacted([replaced.id], summary.id)

  section('markdown')
  const markdown = toMarkdown(repo.getThread(thread.id), repo.getMessages(thread.id), {
    appVersion: '1.2.3',
    exportedAt: t(100),
    folder: 'Systems'
  })
  check('it opens with the thread name', markdown.startsWith('# Rust ownership\n'))
  check('it names the thread model', markdown.includes(`**Thread model** \`${MODEL}\``), markdown.slice(0, 400))
  check('it names the folder', markdown.includes('**Folder** Systems'))
  check('it says what wrote it', markdown.includes('Exported from Deep Pink 1.2.3'))
  check('the user turn is headed', markdown.includes('## You'))
  check('the assistant turn names its model', markdown.includes(`## Assistant — \`${MODEL}\` · anthropic`))
  check('reasoning is collapsed rather than dropped', markdown.includes('<summary>Reasoning</summary>'))
  check('the cost of the turn is there', markdown.includes('$0.00234'), markdown)
  check('the attachment is noted', markdown.includes('**Attached** `diagram.png`'))
  check('the tool call is shown', markdown.includes('**Tool call** `web_search`'))
  check(
    'a fence inside a tool result does not break out of its block',
    markdown.includes('````\nA result mentioning ``` a fence\n````'),
    markdown.slice(markdown.indexOf('## Tool result'))
  )
  check('the compaction summary is labelled', markdown.includes('## Context summary'))
  check(
    'what compaction replaced is not in the transcript',
    !markdown.includes('An older question, since summarised')
  )

  section('the archive')
  const file = exporter.archiveFor(thread.id, '1.2.3')
  check('it is named after the thread', file.filename === 'Rust ownership.dpthread.json', file.filename)

  const parsed = JSON.parse(file.contents)
  check('it declares its format', parsed.format === 'deep-pink-thread' && parsed.version === 1)
  check('it carries the thread name and model', parsed.threads[0].title === 'Rust ownership' &&
    parsed.threads[0].config.model === MODEL)
  check('it carries the folder by name', parsed.threads[0].folder === 'Systems')
  check(
    'it carries every message, compacted ones included',
    parsed.threads[0].messages.length === 5,
    parsed.threads[0].messages.length
  )
  check('it carries the image bytes', parsed.threads[0].messages[0].attachments[0].data === PNG)
  check('it carries what the turn cost', parsed.threads[0].messages[1].usage.costUsd === 0.00234)
  check('it carries the tool call', parsed.threads[0].messages[1].toolInvocations[0].toolName === 'web_search')

  const archivePath = path.join(tmpDir, file.filename)
  fs.writeFileSync(archivePath, file.contents)

  section('reading it into an empty library')
  const before = repo.getGlobalStats()
  repo.wipeAllData()
  check('the library is empty', repo.listThreads().length === 0 && repo.listFolders().length === 0)

  const known = new Set([MODEL])
  const preview = importer.preview(archivePath, known)
  check('the file is recognised as ours', preview.kind === 'deep-pink', preview.kind)
  check('the preview counts the thread', preview.conversations === 1 && preview.messages === 5, preview)
  check('nothing is unavailable when the model is known', preview.unavailableModels.length === 0)
  check('previewing writes nothing', repo.listThreads().length === 0)

  const result = importer.importFile(archivePath, known)
  check('the thread is restored', result.threadsCreated === 1 && result.messagesCreated === 5, result)
  check('the image comes with it', result.imagesAttached === 1, result)

  const restored = repo.listThreads()[0]
  check('its name is back', restored.title === 'Rust ownership')
  check('its model is back', restored.config.model === MODEL)
  check('its own settings are back', restored.config.temperature === 0.4 &&
    restored.config.systemPrompt === 'Be terse.')
  check('a directory that is not on this machine is dropped', restored.config.repoPaths.length === 0)
  check('an MCP server that is not installed is dropped', restored.config.enabledMcpServers.length === 0)
  check('it is still pinned', restored.pinned === true)
  // Against the file, not the thread object captured earlier: inserting a
  // message stamps its thread as edited, so that snapshot is already stale.
  check(
    'its dates are the ones the file recorded',
    restored.createdAt === parsed.threads[0].createdAt &&
      restored.updatedAt === parsed.threads[0].updatedAt,
    { restored: [restored.createdAt, restored.updatedAt], file: [parsed.threads[0].createdAt, parsed.threads[0].updatedAt] }
  )
  check('its folder is recreated by name', repo.getFolder(restored.folderId)?.name === 'Systems')

  const messages = repo.getMessages(restored.id)
  check('the transcript reads the same', messages.map((m) => m.role).join(',') === 'user,assistant,tool,assistant',
    messages.map((m) => m.role))
  check('the reply keeps its model and provider', messages[1].model === MODEL && messages[1].provider === 'anthropic')
  check('the reasoning came with it', messages[1].reasoning === 'Start from moves, then borrows.')
  check('the tool call came with it', messages[1].toolCalls[0].name === 'web_search')
  check('the tool result came with it', messages[2].toolResult.content.includes('a fence'))
  check('the attachment is readable again', messages[0].attachments.length === 1 &&
    subject.attachments.readBase64(messages[0].attachments[0].id) === PNG)
  check(
    'compaction still hides what it replaced, and links to the summary',
    repo.getMessages(restored.id, true).length === 5 &&
      repo.getMessages(restored.id, true).find((m) => m.content.startsWith('An older question'))
        .compactedInto === messages[3].id
  )

  const after = repo.getGlobalStats()
  check('what it cost is restored, not invented', after.costUsd === before.costUsd, {
    before: before.costUsd,
    after: after.costUsd
  })
  check('the tool call is counted again', after.toolCallCount === 1, after.toolCallCount)

  section('importing it a second time')
  const again = importer.importFile(archivePath, known)
  check('nothing is duplicated', again.threadsCreated === 0 && repo.listThreads().length === 1, again)
  check('it says the thread was already here', again.alreadyImported === 1)

  section('a model this account does not have')
  repo.wipeAllData()
  const withoutModel = importer.preview(archivePath, new Set(['openai/gpt-5']))
  check('the preview names it', withoutModel.unavailableModels.join() === MODEL, withoutModel.unavailableModels)

  const cleared = importer.importFile(archivePath, new Set(['openai/gpt-5']))
  check('the thread is imported anyway', cleared.threadsCreated === 1, cleared)
  check('it says the model was cleared', cleared.modelsCleared === 1, cleared)

  const fallback = repo.listThreads()[0]
  check('the thread now follows the default model', fallback.config.model === null)
  check(
    'what answered each turn is left alone, because it is a record',
    repo.getMessages(fallback.id)[1].model === MODEL
  )

  section('when the catalogue could not be checked')
  repo.wipeAllData()
  const unchecked = importer.importFile(archivePath, null)
  check('nothing is cleared on a guess', unchecked.modelsCleared === 0 &&
    repo.listThreads()[0].config.model === MODEL)
  check('and nothing is reported as unavailable', unchecked.unavailableModels.length === 0)

  section('files that are not ours')
  check('a ChatGPT export is not mistaken for one', archive.looksLikeArchive([{ id: 'conv' }]) === false)
  check('one of ours is recognised', archive.looksLikeArchive(parsed) === true)

  let refused = null
  try {
    archive.parseArchive({ ...parsed, version: 99 })
  } catch (err) {
    refused = err.message
  }
  check('a newer format is refused rather than half-read', /newer version/.test(refused ?? ''), refused)

  const damaged = archive.parseArchive({
    ...parsed,
    threads: [{ id: 'x', title: 'Partly readable', createdAt: 1, messages: [
      { role: 'user', content: 'kept' },
      { role: 'nonsense', content: 'dropped' },
      { role: 'assistant', content: '   ' }
    ] }, 'not a thread']
  })
  check('a damaged message is skipped, not fatal', damaged.threads[0].messages.length === 1, damaged.threads[0].messages)
  check('and it is counted', damaged.skipped.unreadableConversations === 2 && damaged.skipped.empty === 1,
    damaged.skipped)
  check('a message with no date takes the thread’s', damaged.threads[0].messages[0].createdAt === 1)
})
