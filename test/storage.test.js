const { suite } = require('./support/harness')

suite('storage — threads, messages, search, stats', async ({ check, section, subject }) => {
  const { getDb, repo } = subject
  getDb()

  section('threads and messages')
  const thread = repo.createThread('Rust ownership')
  check('thread is created', Boolean(thread.id) && thread.title === 'Rust ownership')

  const question = repo.insertMessage({
    threadId: thread.id,
    role: 'user',
    content: 'Explain the borrow checker'
  })
  const answer = repo.insertMessage({
    threadId: thread.id,
    role: 'assistant',
    content: 'The borrow checker enforces <script>alert(1)</script> aliasing rules.',
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'anthropic'
  })
  repo.recordUsage(thread.id, answer.id, 'anthropic/claude-sonnet-4.5', 'anthropic', {
    promptTokens: 120,
    completionTokens: 340,
    reasoningTokens: 0,
    cachedTokens: 20,
    totalTokens: 460,
    costUsd: 0.00234,
    latencyMs: 2100,
    timeToFirstTokenMs: 380,
    tokensPerSecond: 42.5,
    generationId: 'gen-1'
  })

  const stored = repo.getMessages(thread.id)
  check('both messages are stored in order', stored.length === 2 && stored[0].id === question.id)
  check('usage is attached to its message', stored[1].usage?.costUsd === 0.00234)

  section('search')
  const bodyHits = repo.search('borrow')
  const bodyHit = bodyHits.find((hit) => hit.messageId)
  check('a message body match is found', Boolean(bodyHit))
  check('the snippet highlights the match', bodyHit.snippet.includes('<mark>'), bodyHit.snippet)

  // Only the assistant message contains markup, so search for a word unique to it.
  const markupHit = repo.search('aliasing').find((hit) => hit.messageId)
  check(
    'the snippet escapes HTML that came from the message',
    !markupHit.snippet.includes('<script>') && markupHit.snippet.includes('&lt;script&gt;'),
    markupHit.snippet
  )
  check(
    'escaping does not break highlighting',
    markupHit.snippet.includes('<mark>aliasing</mark>'),
    markupHit.snippet
  )
  check('a thread title match is found', repo.search('Rust').some((hit) => hit.messageId === null))
  check('a prefix matches', repo.search('borro').length > 0)
  check('a blank query returns nothing', repo.search('   ').length === 0)
  check('query punctuation does not throw', Array.isArray(repo.search('"quoted" AND (x)')))

  section('compaction ordering')
  const long = repo.createThread('Long thread')
  const ids = []
  for (let i = 0; i < 6; i++) {
    ids.push(
      repo.insertMessage({
        threadId: long.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`
      }).id
    )
  }

  const summary = repo.insertMessageBefore(repo.seqOf(ids[4]), {
    threadId: long.id,
    role: 'system',
    content: 'SUMMARY',
    isCompactionSummary: true
  })
  repo.markCompacted(ids.slice(0, 4), summary.id)

  const visible = repo.getMessages(long.id)
  check('compacted messages are hidden', visible.length === 3, visible.map((m) => m.content))
  check(
    'the summary takes the place of what it replaced',
    visible[0].content === 'SUMMARY',
    visible.map((m) => m.content)
  )
  check(
    'the kept messages still follow in order',
    visible[1].content === 'message 4' && visible[2].content === 'message 5',
    visible.map((m) => m.content)
  )
  check('the originals remain on disk', repo.getMessages(long.id, true).length === 7)

  section('statistics')
  const threadStats = repo.getThreadStats(thread.id, 200_000)
  check('thread cost is totalled', threadStats.costUsd === 0.00234, threadStats.costUsd)
  check('thread tokens are totalled', threadStats.totalTokens === 460, threadStats.totalTokens)
  check(
    'context size comes from the most recent request',
    threadStats.contextTokens === 460,
    threadStats.contextTokens
  )
  check(
    'usage rolls up by model',
    threadStats.byModel.length === 1 && threadStats.byModel[0].requests === 1
  )

  const global = repo.getGlobalStats()
  check('threads are counted globally', global.threadCount === 2, global.threadCount)
  check('cost is summed globally', Math.abs(global.costUsd - 0.00234) < 1e-9, global.costUsd)
  check('usage rolls up by provider', global.byProvider.length === 1, global.byProvider)
  check('usage rolls up by day', global.byDay.length === 1, global.byDay)

  section('title-cost markers')
  const marker = repo.insertMessage({
    threadId: thread.id,
    role: 'system',
    content: '',
    model: 'google/gemini-2.5-flash-lite',
    compactedInto: 'title'
  })
  repo.recordUsage(thread.id, marker.id, 'google/gemini-2.5-flash-lite', 'google', {
    promptTokens: 40,
    completionTokens: 6,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 46,
    costUsd: 0.000004,
    latencyMs: 300,
    timeToFirstTokenMs: 120,
    tokensPerSecond: 20,
    generationId: 'gen-title'
  })
  check('the marker stays out of the transcript', repo.getMessages(thread.id).length === 2)
  check(
    'the marker is not counted as a message',
    repo.getThreadStats(thread.id, null).messageCount === 2,
    repo.getThreadStats(thread.id, null).messageCount
  )
  check(
    'but its cost is still counted',
    repo.getThreadStats(thread.id, null).costUsd > 0.00234,
    repo.getThreadStats(thread.id, null).costUsd
  )

  section('what tools cost')
  const toolThread = repo.createThread('Used tools')
  const toolMsg = repo.insertMessage({ threadId: toolThread.id, role: 'assistant', content: 'ok' })
  repo.recordToolInvocation({ threadId: toolThread.id, messageId: toolMsg.id, source: 'repo',
    serverId: null, toolName: 'repo_read', isError: false, durationMs: 12, resultChars: 4000 })
  repo.recordToolInvocation({ threadId: toolThread.id, messageId: toolMsg.id, source: 'repo',
    serverId: null, toolName: 'repo_search', isError: false, durationMs: 30, resultChars: 2000 })
  repo.recordToolInvocation({ threadId: toolThread.id, messageId: toolMsg.id, source: 'web',
    serverId: null, toolName: 'web_fetch', isError: false, durationMs: 900, resultChars: 8000 })

  const usage = repo.getThreadStats(toolThread.id, null).toolUsage
  check('usage is grouped by source', usage.length === 2, usage.map((u) => u.source))
  const repoRow = usage.find((u) => u.source === 'repo')
  check('repository calls are counted', repoRow.calls === 2, repoRow)
  check('and their characters summed', repoRow.chars === 6000, repoRow)
  check('with a token estimate', repoRow.estimatedTokens === 1500, repoRow)
  check('and their time summed', repoRow.totalMs === 42, repoRow)
  check(
    'the biggest source comes first',
    usage[0].source === 'web' && usage[0].chars === 8000,
    usage
  )
  check('it rolls up globally too', repo.getGlobalStats().toolUsage.length === 2)

  section('tags')
  const tagged = repo.createThread('Tag fixture')
  repo.insertMessage({
    threadId: tagged.id,
    role: 'user',
    content: 'lifetimes and ownership, explained slowly'
  })

  const firstTag = repo.addThreadTag(tagged.id, '  #Rust Lang  ')
  check('a tag is cleaned up on the way in', firstTag === 'rust lang', firstTag)
  repo.addThreadTag(tagged.id, 'RUST LANG')
  check(
    'the same tag in another case is the same tag',
    repo.getThreadTags(tagged.id).length === 1,
    repo.getThreadTags(tagged.id)
  )
  check('a tag with nothing in it is refused', repo.addThreadTag(tagged.id, '  ##  ') === null)

  repo.addThreadTag(tagged.id, 'borrow checker', 'model')
  check(
    'the thread carries what was put on it',
    repo.getThread(tagged.id).tags.join(',') === 'borrow checker,rust lang',
    repo.getThread(tagged.id).tags
  )
  check(
    'where each tag came from is remembered',
    repo.getThreadTagSources(tagged.id)['borrow checker'] === 'model' &&
      repo.getThreadTagSources(tagged.id)['rust lang'] === 'user',
    repo.getThreadTagSources(tagged.id)
  )
  repo.addThreadTag(tagged.id, 'borrow checker', 'user')
  check(
    'adopting a model tag by hand makes it the user’s',
    repo.getThreadTagSources(tagged.id)['borrow checker'] === 'user'
  )
  check(
    'the library counts the threads using each tag',
    repo.listTags().find((t) => t.name === 'rust lang').threads === 1,
    repo.listTags()
  )

  section('tags are searchable')
  const byTag = repo.search('rust lang')
  check('a tag match is found', byTag.some((hit) => hit.kind === 'tag'), byTag)
  check(
    'the match is highlighted',
    byTag.find((hit) => hit.kind === 'tag').snippet.includes('<mark>'),
    byTag.find((hit) => hit.kind === 'tag')
  )
  check(
    'every hit carries its thread’s tags',
    byTag.every((hit) => Array.isArray(hit.tags)) &&
      byTag.find((hit) => hit.threadId === tagged.id).tags.includes('rust lang'),
    byTag
  )

  const filtered = repo.search('tag:rust')
  check('a tag: term matches on a prefix', filtered.length === 1, filtered)
  check('and returns the whole thread', filtered[0].threadId === tagged.id, filtered[0])
  check('a hash means the same thing', repo.search('#rust').length === 1)

  const scoped = repo.search('tag:rust lifetimes')
  check(
    'free text inside a tag filter searches only that thread',
    scoped.length === 1 && scoped[0].messageId !== null && scoped[0].threadId === tagged.id,
    scoped
  )
  check(
    'text that matches elsewhere is excluded by the filter',
    repo.search('tag:rust borrow').every((hit) => hit.threadId === tagged.id),
    repo.search('tag:rust borrow')
  )
  check('an unused tag filter matches nothing', repo.search('tag:absent').length === 0)

  section('the tag library')
  const other = repo.createThread('Second Rust thread')
  repo.addThreadTag(other.id, 'rustlang')
  check(
    'renaming merges onto a tag that already exists',
    repo.renameTag('rustlang', 'rust lang') === 'rust lang' &&
      repo.getThreadTags(other.id).join(',') === 'rust lang' &&
      repo.listTags().filter((t) => t.name === 'rustlang').length === 0,
    repo.listTags()
  )
  check('and both threads now wear it', repo.search('tag:rust').length === 2)

  const branchOfTagged = repo.branchThread(tagged.id, repo.getMessages(tagged.id)[0].id)
  check(
    'a branch inherits the tags of what it came from',
    branchOfTagged.tags.join(',') === 'borrow checker,rust lang',
    branchOfTagged.tags
  )

  const capped = repo.createThread('Too many tags')
  for (const name of ['one', 'two', 'three']) repo.addThreadTag(capped.id, name, 'model')
  repo.addThreadTag(capped.id, 'mine', 'user')
  repo.enforceTagLimit(capped.id, 2)
  const remaining = repo.getThreadTags(capped.id)
  check('the limit is enforced', remaining.length === 2, remaining)
  check('and the user’s own tag survives it', remaining.includes('mine'), remaining)

  repo.deleteTag('rust lang')
  check(
    'deleting a tag takes it off every thread',
    repo.getThreadTags(tagged.id).join(',') === 'borrow checker' &&
      repo.getThreadTags(other.id).length === 0,
    repo.getThreadTags(tagged.id)
  )

  section('tags the model may not touch')
  const curated = repo.createThread('Curated')
  repo.addThreadTag(curated.id, 'reviewed')
  repo.setTagFlags('reviewed', { manualOnly: true })

  const reviewed = repo.listTags().find((t) => t.name === 'reviewed')
  check('a tag can be marked manual-only', reviewed.manualOnly === true, reviewed)
  check('and is not pinned by that', reviewed.pinned === false, reviewed)

  repo.setTagFlags('reviewed', { pinned: true })
  check(
    'pinning a tag is a separate flag',
    repo.listTags().find((t) => t.name === 'reviewed').pinned === true &&
      repo.listTags().find((t) => t.name === 'reviewed').manualOnly === true
  )
  check(
    'pinning a folder leaves thread pinning alone',
    repo.getThread(curated.id).pinned === false
  )

  repo.setTagFlags('reviewed', { manualOnly: false })
  check(
    'and it can be handed back to the model',
    repo.listTags().find((t) => t.name === 'reviewed').manualOnly === false
  )
  repo.deleteThread(curated.id)

  section('finding what still needs tagging')
  const untidy = repo.createThread('Never tagged')
  repo.insertMessage({ threadId: untidy.id, role: 'user', content: 'x'.repeat(2000) })
  repo.insertMessage({ threadId: untidy.id, role: 'assistant', content: 'short answer' })
  const emptyThread = repo.createThread('Nothing said here')

  const untaggedIds = repo.listUntaggedThreadIds()
  check('a thread with no tags is listed', untaggedIds.includes(untidy.id), untaggedIds.length)
  check('a thread with tags is not', !untaggedIds.includes(tagged.id))
  check('an empty thread has nothing to tag', !untaggedIds.includes(emptyThread.id))

  const sizes = repo.untaggedThreadSizes(10, 900)
  const untidySize = sizes.find((row) => row.id === untidy.id)
  check('its transcript is measured', Boolean(untidySize), sizes)
  check(
    'a long message is measured as the request would truncate it',
    untidySize.chars < 1100,
    untidySize
  )
  check(
    'and the short one is measured in full',
    untidySize.chars > 900 + 'short answer'.length,
    untidySize
  )
  check(
    'the empty thread is left out of the measurement',
    !sizes.some((row) => row.id === emptyThread.id),
    sizes.map((r) => r.title)
  )

  repo.deleteThread(untidy.id)
  repo.deleteThread(emptyThread.id)

  repo.deleteThread(tagged.id)
  check(
    'deleting a thread lets go of its tags',
    repo.listTags().find((t) => t.name === 'borrow checker').threads === 1,
    repo.listTags()
  )

  section('branching and deletion')
  const branch = repo.branchThread(thread.id, question.id)
  check('a branch is created as a new thread', Boolean(branch) && branch.id !== thread.id)
  check('the branch stops at the chosen message', repo.getMessages(branch.id).length === 1)

  repo.deleteThread(long.id)
  check('deleting a thread removes its messages', repo.getMessages(long.id, true).length === 0)

  section('image attachments')
  const { attachments } = subject
  // A 1x1 red PNG.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

  const imgThread = repo.createThread('With pictures')
  const withImage = repo.insertMessage({ threadId: imgThread.id, role: 'user', content: 'look' })
  const storedImage = attachments.store(imgThread.id, withImage.id, {
    mime: 'image/png', filename: 'shot.png', data: PNG, width: 1, height: 1
  })

  check('the image is stored and given an id', Boolean(storedImage.id), storedImage.id)
  check('it is addressed by the custom protocol', storedImage.url === `dpimg://attachment/${storedImage.id}`, storedImage.url)
  check('its byte count is recorded', storedImage.bytes > 0 && storedImage.bytes < 200, storedImage.bytes)
  check('the file exists on disk', attachments.filePath(storedImage.id) !== null)
  check(
    'it comes back attached to its message',
    repo.getMessages(imgThread.id)[0].attachments.length === 1,
    repo.getMessages(imgThread.id)[0].attachments
  )
  check(
    'it converts to a data URL for the provider',
    attachments.toDataUrl(storedImage).startsWith('data:image/png;base64,iVBOR'),
    attachments.toDataUrl(storedImage).slice(0, 40)
  )

  const refuse = (input) => {
    try { attachments.store(imgThread.id, withImage.id, input); return false } catch { return true }
  }
  check('a non-image type is refused', refuse({ mime: 'application/pdf', filename: 'a.pdf', data: PNG, width: null, height: null }))
  check('an executable disguised by mime is refused', refuse({ mime: 'application/x-mach-binary', filename: 'x', data: PNG, width: null, height: null }))
  check('an empty payload is refused', refuse({ mime: 'image/png', filename: 'e.png', data: '', width: null, height: null }))
  check('an oversized image is refused', refuse({
    mime: 'image/png', filename: 'big.png',
    data: 'A'.repeat(Math.ceil((attachments.MAX_ATTACHMENT_BYTES + 4) / 3) * 4),
    width: null, height: null
  }))

  section('long text as an attachment')
  const textThread = repo.createThread('With code')
  const codeMsg = repo.insertMessage({ threadId: textThread.id, role: 'user', content: 'review this' })
  const CODE = 'int main(void) {\n  return 0;\n}\n'
  const storedText = attachments.store(textThread.id, codeMsg.id, {
    mime: 'text/plain', filename: 'main.c',
    data: Buffer.from(CODE, 'utf8').toString('base64'),
    width: null, height: null
  })

  check('text is stored as a text attachment', storedText.kind === 'text', storedText.kind)
  check('a preview is captured for the chip', (storedText.preview || '').startsWith('int main'), storedText.preview)
  check('the full body reads back intact', attachments.readText(storedText.id) === CODE)
  check('images are still classified as images', attachments.kindOf('image/png') === 'image')

  const refuseText = (input) => {
    try { attachments.store(textThread.id, codeMsg.id, input); return false } catch { return true }
  }
  check(
    'binary masquerading as text is refused',
    refuseText({ mime: 'text/plain', filename: 'a.bin',
      data: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]).toString('base64'),
      width: null, height: null })
  )

  section('a text attachment reaches the model as inlined text')
  const { toChatParams } = subject
  const params = toChatParams(repo.getMessages(textThread.id))
  const sent = params.find((p) => p.role === 'user')
  check('it is sent as a plain string, not an image part', typeof sent.content === 'string', typeof sent.content)
  check('the typed message survives', sent.content.includes('review this'), sent.content.slice(0, 60))
  check('the file is labelled by name', sent.content.includes('Attached file: main.c'), sent.content)
  check('the code is fenced with its language', sent.content.includes('```c'), sent.content)
  check('the body is included verbatim', sent.content.includes('int main(void)'), sent.content)

  section('a file containing fences cannot break out of its own block')
  const trickyMsg = repo.insertMessage({ threadId: textThread.id, role: 'user', content: '' })
  attachments.store(textThread.id, trickyMsg.id, {
    mime: 'text/plain', filename: 'readme.md',
    data: Buffer.from('```\nnot escaping\n```', 'utf8').toString('base64'),
    width: null, height: null
  })
  const tricky = toChatParams(repo.getMessages(textThread.id)).filter((p) => p.role === 'user').pop()
  check('the wrapper fence is longer than any inside', tricky.content.includes('````'), tricky.content)

  section('attachments follow their message')
  repo.deleteThread(imgThread.id)
  check('rows go when the thread goes', attachments.forMessage(withImage.id).length === 0)
  check('and the orphaned file is swept up', attachments.collectOrphans() >= 1)
  check('sweeping twice finds nothing more', attachments.collectOrphans() === 0)

  section('settings round trip')
  repo.setSetting('probe', { nested: { value: 7 } })
  check('settings survive a round trip', repo.getSetting('probe', null).nested.value === 7)
  check('missing settings fall back', repo.getSetting('absent', 'fallback') === 'fallback')
})
