const { suite, sseResponse, writeTestApiKey, message } = require('./support/harness')

suite('compaction — limits, preserved context, failures and cancellation', async ({ check, section, subject }) => {
  const {
    repo, getDb, loadSettings, saveSettings, DEFAULT_SETTINGS, assembleContext,
    shouldCompact, compactThread, compactionBoundary, sendMessage, abortThread, attachments
  } = subject
  writeTestApiKey()
  const originalFetch = global.fetch
  const model = (id, contextLength) => ({
    id, name: id, description: '', contextLength, pricing: {}, supportedParameters: [],
    inputModalities: ['text'], supportsTools: false, supportsReasoning: false, created: 0
  })
  repo.setCache('models', [model('test/compact', 100000), model('test/small', 1000), model('test/summary-small', 900)])
  repo.setCache('models:gatheredBy', require('../package.json').version)
  saveSettings({
    defaultModel: 'test/compact', baseSystemPrompt: '', includeDateTimeInPrompt: false,
    compaction: { enabled: true, requireConfirmation: true, keepRecentMessages: 2 },
    keyPointEnabled: false
  })
  const usage = {
    promptTokens: 700, completionTokens: 100, reasoningTokens: 0, cachedTokens: 0,
    totalTokens: 800, costUsd: 0.001, latencyMs: 0, timeToFirstTokenMs: null,
    tokensPerSecond: null, generationId: null
  }
  const response = (content, reason = 'stop') => sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }],
      usage: { prompt_tokens: 700, completion_tokens: 50, total_tokens: 750, cost: 0.001 } })}`,
    'data: [DONE]'
  ])
  const fixture = () => {
    const thread = repo.createThread('Compaction fixture', { model: 'test/compact' })
    for (let i = 0; i < 4; i++) {
      repo.insertMessage({ threadId: thread.id, role: 'user', content: `Question ${i}. ` + 'fact '.repeat(100) })
      repo.insertMessage({ threadId: thread.id, role: 'assistant', content: `Answer ${i}. ` + 'detail '.repeat(100) })
    }
    return thread
  }
  const rejected = async (fn) => {
    try { await fn(); return '' } catch (err) { return err.message }
  }
  try {
    section('saved limits and exact threshold')
    saveSettings({ compaction: { triggerRatio: 2, keepRecentMessages: -5 } })
    check('out-of-range settings are clamped on save',
      loadSettings().compaction.triggerRatio === 0.95 && loadSettings().compaction.keepRecentMessages === 2)
    saveSettings({ compaction: { triggerRatio: NaN, keepRecentMessages: 3.9 } })
    check('non-finite triggers recover and the keep count is integral',
      loadSettings().compaction.triggerRatio === DEFAULT_SETTINGS.compaction.triggerRatio &&
      loadSettings().compaction.keepRecentMessages === 3)
    saveSettings({ compaction: { triggerRatio: 0.75, keepRecentMessages: 2 } })

    const ctx = repo.createThread('Limit fixture', { model: 'test/small' })
    repo.insertMessage({ threadId: ctx.id, role: 'user', content: 'Question' })
    const answer = repo.insertMessage({ threadId: ctx.id, role: 'assistant', content: 'Answer',
      model: 'test/small', systemPromptSnapshot: assembleContext(ctx, loadSettings()).segments })
    repo.recordUsage(ctx.id, answer.id, 'test/small', 'test', { ...usage, promptTokens: 650 })
    let status = await shouldCompact(ctx, loadSettings())
    check('the trigger includes the exact boundary', status.used === 750 && status.needed, status)
    repo.recordUsage(ctx.id, answer.id, 'test/small', 'test', { ...usage, promptTokens: 500 })
    status = await shouldCompact(ctx, { ...loadSettings(), maxTokens: 450 })
    check('the answer budget can trigger compaction sooner', status.used === 600 && status.needed, status)
    status = await shouldCompact(ctx, { ...loadSettings(), compaction: { ...loadSettings().compaction, enabled: false } })
    check('disabling automatic compaction still reports usage without requesting it', !status.needed && status.used === 600)
    repo.recordUsage(ctx.id, answer.id, 'test/small', 'test', { ...usage, promptTokens: 650, reasoningTokens: 80 })
    status = await shouldCompact(ctx, loadSettings())
    check('billed reasoning is not counted as history sent again', status.used === 670 && !status.needed, status)
    status = await shouldCompact({ ...ctx, config: { ...ctx.config, model: 'test/compact' } }, loadSettings())
    check('switching models invalidates the old token measurement', status.used < 100, status)
    status = await shouldCompact(ctx, { ...loadSettings(), includeDateTimeInPrompt: true })
    check('enabling date and time invalidates the previous prompt measurement', status.used < 100, status)
    status = await shouldCompact(ctx, { ...loadSettings(), baseSystemPrompt: 'New instructions. '.repeat(200) })
    check('changed instructions use a fresh estimate', status.used > 750 && status.used !== 670, status)

    section('tool results and attachments are counted once')
    const tools = repo.createThread('Tools')
    repo.insertMessage({ threadId: tools.id, role: 'tool', content: 'x'.repeat(400),
      toolResult: { toolCallId: 'call', name: 'lookup', content: 'x'.repeat(400), isError: false, durationMs: 0 } })
    check('a tool result has one copy in the token estimate', repo.contextEstimate(tools.id).fromText === 104)
    const fileQuestion = repo.insertMessage({ threadId: tools.id, role: 'user', content: '' })
    attachments.store(tools.id, fileQuestion.id, { mime: 'text/plain', filename: 'facts.txt',
      data: Buffer.from('private fact '.repeat(100)).toString('base64'), width: null, height: null })
    check('text attachments contribute before the first measured request', repo.contextEstimate(tools.id).fromText > 400)

    section('keep complete turns')
    const turn = [
      message({ role: 'user' }), message({ role: 'assistant' }),
      message({ role: 'user' }), message({ role: 'assistant', toolCalls: [{ id: 'call', name: 'lookup', arguments: '{}' }] }),
      message({ role: 'tool' }), message({ role: 'assistant' })
    ]
    check('a cutoff inside a tool round moves to its user question', compactionBoundary(turn, 2) === 2)
    check('one recent turn is never partially compacted', compactionBoundary(turn.slice(2), 2) === 0)

    section('successful replacement')
    const good = fixture()
    const original = repo.getMessages(good.id)
    attachments.store(good.id, original[0].id, { mime: 'text/plain', filename: 'facts.txt',
      data: Buffer.from('The launch date is Friday.').toString('base64'), width: null, height: null })
    let request
    global.fetch = async (_url, init) => {
      request = JSON.parse(init.body)
      return response('The user needs facts and details. Launch is Friday.')
    }
    const events = []
    const result = await compactThread(good.id, (event) => events.push(event))
    const visible = repo.getMessages(good.id)
    check('the summary is before the protected recent exchange',
      visible.length === 3 && visible[0].isCompactionSummary &&
      visible[1].id === original[6].id && visible[2].id === original[7].id, visible.map((m) => m.id))
    check('the old rows survive on disk', repo.getMessages(good.id, true).length === 9)
    check('attachments reach the summarizer', request.messages[1].content.includes('The launch date is Friday.'))
    check('summary output is capped and the saved result frees space', request.max_tokens <= 2048 && result.freedTokens > 0)
    check('the summary cost is stored but is not a live context measurement',
      repo.getMessage(result.summaryMessageId).usage.costUsd > 0 && repo.contextEstimate(good.id).measured === null)
    check('progress has a terminal event', events.map((e) => e.type).join(',') === 'compaction-start,compaction-done')

    const small = repo.createThread('Small summary window', { model: 'test/summary-small' })
    repo.insertMessage({ threadId: small.id, role: 'user', content: 'fact '.repeat(200) })
    repo.insertMessage({ threadId: small.id, role: 'assistant', content: 'detail '.repeat(150) })
    repo.insertMessage({ threadId: small.id, role: 'user', content: 'Keep this question.' })
    repo.insertMessage({ threadId: small.id, role: 'assistant', content: 'Keep this answer.' })
    await compactThread(small.id, () => {})
    check('summary output is reduced to fit a small model window',
      request.model === 'test/summary-small' && request.max_tokens >= 128 && request.max_tokens < 260)

    section('automatic and manual-only modes')
    let summaries = 0
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.messages[0]?.content.startsWith('You are compacting')) {
        summaries++
        return response('Earlier questions covered facts and details.')
      }
      return response('The next answer.')
    }
    const filled = () => {
      const thread = fixture()
      const last = repo.getMessages(thread.id).at(-1)
      repo.recordUsage(thread.id, last.id, 'test/compact', 'test', { ...usage, promptTokens: 76000 })
      return thread
    }
    const manual = filled()
    await sendMessage({ threadId: manual.id, content: 'Continue.' }, () => {})
    check('manual-only mode never compacts while sending', summaries === 0 &&
      !repo.getMessages(manual.id).some((m) => m.isCompactionSummary))
    saveSettings({ compaction: { requireConfirmation: false } })
    const automatic = filled()
    await sendMessage({ threadId: automatic.id, content: 'Continue.' }, () => {})
    check('automatic mode compacts before the next reply', summaries === 1 &&
      repo.getMessages(automatic.id).some((m) => m.isCompactionSummary))
    await sendMessage({ threadId: automatic.id, content: 'Continue again.' }, () => {})
    check('the fresh measurement prevents repeated compaction after every turn', summaries === 1)
    saveSettings({ compaction: { requireConfirmation: true } })

    section('failures preserve history and settle progress')
    for (const [name, content, reason] of [
      ['empty', ' ', 'stop'], ['truncated', 'Partial summary', 'length'],
      ['unfinished', 'Partial summary', null], ['larger', 'summary '.repeat(2000), 'stop']
    ]) {
      const thread = fixture()
      const before = repo.getMessages(thread.id).map((m) => m.id)
      const events = []
      global.fetch = async () => response(content, reason)
      const error = await rejected(() => compactThread(thread.id, (e) => events.push(e)))
      check(`${name} summaries leave every original visible`, Boolean(error) &&
        JSON.stringify(repo.getMessages(thread.id).map((m) => m.id)) === JSON.stringify(before))
      check(`${name} summaries end progress`, events.at(-1)?.type === 'compaction-error')
    }
    const failed = fixture()
    global.fetch = async () => { throw new Error('offline') }
    check('network failures preserve history',
      (await rejected(() => compactThread(failed.id, () => {}))).includes('offline') && repo.getMessages(failed.id).length === 8)

    section('cancellation, concurrency and edits during a request')
    const busy = fixture()
    let release
    let reached
    const started = new Promise((resolve) => { reached = resolve })
    global.fetch = async (_url, init) => {
      reached()
      return new Promise((resolve, reject) => {
        release = () => resolve(response('A short valid summary.'))
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    }
    const pending = compactThread(busy.id, () => {})
    const cancelled = rejected(() => pending)
    await started
    check('a second summary request is rejected', Boolean(await rejected(() => compactThread(busy.id, () => {}))))
    check('sending cannot change a chat being summarized', Boolean(await rejected(() =>
      sendMessage({ threadId: busy.id, content: 'new' }, () => {}))) && repo.getMessages(busy.id).length === 8)
    abortThread(busy.id)
    check('cancellation leaves history untouched', Boolean(await cancelled) && repo.getMessages(busy.id).length === 8)
    release()
    global.fetch = async () => response('A short valid summary.')
    check('cancellation releases the lock for another attempt', Boolean(await compactThread(busy.id, () => {})))

    const changed = fixture()
    global.fetch = async () => {
      const first = repo.getMessages(changed.id)[0]
      repo.updateMessage(first.id, { content: 'Edited while summarizing.' })
      return response('A short valid summary.')
    }
    check('an edit during compaction rejects the outdated summary',
      (await rejected(() => compactThread(changed.id, () => {}))).includes('changed') && repo.getMessages(changed.id).length === 8)

    section('atomic persistence')
    const atomic = fixture()
    getDb().exec(`CREATE TRIGGER reject_summary_usage BEFORE INSERT ON usage
      WHEN NEW.model = 'test/fail-save' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`)
    const rows = repo.getMessages(atomic.id)
    const error = await rejected(() => repo.saveCompaction(rows.slice(0, 6).map((m) => m.id), rows[6].id,
      { threadId: atomic.id, role: 'system', content: 'Summary', model: 'test/fail-save', isCompactionSummary: true }, usage))
    getDb().exec('DROP TRIGGER reject_summary_usage')
    check('a failed cost write rolls back both insertion and hiding', Boolean(error) &&
      repo.getMessages(atomic.id, true).length === 8 && repo.getMessages(atomic.id).length === 8)
  } finally {
    global.fetch = originalFetch
  }
})
