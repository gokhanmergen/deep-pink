const { suite } = require('./support/harness')

suite('global statistics — calendar ranges scope every rollup', async ({ check, subject }) => {
  const { repo, getDb } = subject
  const db = getDb()
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const daysAgo = (days) => {
    const date = new Date(midnight)
    date.setDate(date.getDate() - days)
    return date.getTime()
  }
  const fixtures = [
    [daysAgo(0) + 1, 1],
    [daysAgo(6), 2],
    [daysAgo(6) - 1, 4],
    [daysAgo(29), 8],
    [daysAgo(29) - 1, 16],
    [daysAgo(89), 32],
    [daysAgo(89) - 1, 64],
    [daysAgo(-1), 128]
  ]
  for (const [at, weight] of fixtures) {
    const thread = repo.createThread(`Stats fixture ${weight}`)
    const message = repo.insertMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'Recorded reply'
    })
    db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(at, message.id)
    repo.recordUsage(
      thread.id,
      message.id,
      `fixture/model-${weight}`,
      weight === 1 ? null : 'provider',
      {
        promptTokens: weight * 1000,
        completionTokens: weight * 100,
        totalTokens: weight * 1100,
        cachedTokens: weight * 10,
        reasoningTokens: weight * 5,
        costUsd: weight / 100,
        latencyMs: 100,
        timeToFirstTokenMs: 10,
        tokensPerSecond: 10,
        generationId: null
      },
      at
    )
    repo.recordToolInvocation({
      threadId: thread.id,
      messageId: message.id,
      source: 'web',
      serverId: null,
      toolName: 'web_search',
      isError: false,
      durationMs: weight,
      resultChars: weight * 4,
      createdAt: at
    })
  }
  // Accounting markers must never inflate the count of visible messages.
  const markerThread = repo.createThread('A cost marker')
  repo.insertMessage({
    threadId: markerThread.id,
    role: 'system',
    content: '',
    compactedInto: 'title'
  })

  for (const range of [7, 30, 90]) {
    const cutoff = daysAgo(range - 1)
    const within = fixtures.filter(([at]) => at >= cutoff && at < daysAgo(-1))
    const weight = within.reduce((sum, [, value]) => sum + value, 0)
    const stats = repo.getGlobalStats(range)
    check(
      `${range} days: cost, cache, output and reasoning use the same dates`,
      Math.abs(stats.costUsd - weight / 100) < 1e-9 &&
        stats.cachedTokens === weight * 10 &&
        stats.completionTokens === weight * 100 &&
        stats.reasoningTokens === weight * 5,
      stats
    )
    check(
      `${range} days: messages and active threads exclude older and future records`,
      stats.messageCount === within.length && stats.threadCount === within.length,
      stats
    )
    for (const name of ['byModel', 'byProvider', 'byDay', 'byDayModel']) {
      const rows = stats[name]
      check(
        `${range} days: ${name} reconciles with the selected totals`,
        Math.abs(rows.reduce((sum, row) => sum + row.costUsd, 0) - stats.costUsd) < 1e-9 &&
          rows.reduce((sum, row) => sum + row.totalTokens, 0) === stats.totalTokens &&
          rows.reduce((sum, row) => sum + row.requests, 0) === within.length,
        rows
      )
    }
    check(
      `${range} days: tool counts and result sizes are scoped too`,
      stats.toolCallCount === within.length &&
        stats.toolUsage[0].calls === within.length &&
        stats.toolUsage[0].chars === weight * 4 &&
        stats.toolUsage[0].totalMs === weight,
      stats.toolUsage
    )
  }
  check(
    'an unknown provider remains in the totals',
    repo.getGlobalStats(7).byProvider.some((row) => row.model === 'unknown' && row.requests === 1)
  )
  check(
    'the unfiltered API still returns lifetime accounting',
    Math.abs(repo.getGlobalStats().costUsd - 2.55) < 1e-9
  )
  let rejected = false
  try {
    repo.getGlobalStats(8)
  } catch {
    rejected = true
  }
  check('unsupported ranges are rejected', rejected)
})
