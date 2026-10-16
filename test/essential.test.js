const { suite } = require('./support/harness')
const { createServer } = require('node:http')
const { session } = require('electron')

suite('essential safety and persistence', async ({ check, subject }) => {
  const { closeDb, getDb, repo, runWebFetch, resultUrl, rankResults, fetchSearchPage } = subject

  getDb()

  const webSettings = { fetchCharLimit: 1000, blockedDomains: ['evil.test'] }
  const refused = async (url) => {
    try {
      await runWebFetch({ url }, webSettings)
      return false
    } catch {
      return true
    }
  }
  const unsafeUrls = [
    'file:///etc/passwd',
    'http://localhost:8080/',
    'http://127.0.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://printer.local/',
    'https://evil.test/page',
    'not a url'
  ]
  check(
    'web fetch refuses local, private, blocked and malformed destinations',
    (await Promise.all(unsafeUrls.map(refused))).every(Boolean)
  )

  check(
    'search links reject non-web and credentialed URLs',
    ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.org', ''].every(
      (url) => resultUrl(url, 'https://search.example') === null
    )
  )

  const ranked = rankResults(
    [
      {
        name: 'search',
        results: [
          { title: 'Public', url: 'https://example.org/article', snippet: 'usable' },
          { title: 'Localhost', url: 'http://localhost/article', snippet: 'private' },
          { title: 'Private IP', url: 'http://192.168.1.5/article', snippet: 'private' },
          { title: 'Mapped IP', url: 'http://[::ffff:127.0.0.1]/article', snippet: 'private' },
          { title: 'Blocked', url: 'https://sub.evil.test/article', snippet: 'blocked' }
        ]
      }
    ],
    ['evil.test'],
    10
  )
  check(
    'search results exclude private and blocked destinations',
    ranked.length === 1 && ranked[0].url === 'https://example.org/article',
    ranked
  )

  const thread = repo.createThread('Persistence check')
  const question = repo.insertMessage({
    threadId: thread.id,
    role: 'user',
    content: 'Keep this question after reopening the database.'
  })
  const answer = repo.insertMessage({
    threadId: thread.id,
    role: 'assistant',
    content: '<script>alert(1)</script> safeproof answer',
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'anthropic'
  })
  repo.recordUsage(thread.id, answer.id, answer.model, answer.provider, {
    promptTokens: 10,
    completionTokens: 20,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 30,
    costUsd: 0.001,
    latencyMs: 100,
    timeToFirstTokenMs: 25,
    tokensPerSecond: 200,
    generationId: 'essential-test'
  })

  closeDb()
  const restored = repo.getMessages(thread.id)
  check(
    'threads and ordered messages survive a database reopen',
    restored.length === 2 &&
      restored[0].id === question.id &&
      restored[0].content === 'Keep this question after reopening the database.' &&
      restored[1].id === answer.id &&
      restored[1].usage?.costUsd === 0.001
  )
  const searchHit = repo.search('safeproof').find((hit) => hit.messageId === answer.id)
  check(
    'search snippets escape HTML from saved model replies',
    Boolean(searchHit) &&
      !searchHit.snippet.includes('<script>') &&
      searchHit.snippet.includes('&lt;script&gt;'),
    searchHit?.snippet
  )

  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.headers)
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/page' })
      res.end()
      return
    }
    if (req.url === '/large') {
      res.end('x'.repeat(2_000_001))
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Set-Cookie': 'search_tracking=1; Path=/'
    })
    res.end('<html><script>must not execute</script><p>Search page</p></html>')
  })
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    await session.defaultSession.cookies.set({ url: origin, name: 'app_secret', value: 'private' })
    const isolated = session.fromPartition('deep-pink-private-search', { cache: false })
    await isolated.cookies.set({ url: origin, name: 'old_cookie', value: 'must-not-send' })
    await fetchSearchPage(new URL(`${origin}/page`), AbortSignal.timeout(5000))

    check(
      'search uses a nonpersistent session without cookies or referrers',
      !isolated.isPersistent() && requests.length === 1 &&
        !requests[0].cookie && !requests[0].referer
    )
    check(
      'cookies returned by a search page are not saved',
      !(await isolated.cookies.get({ url: origin })).some((cookie) => cookie.name === 'search_tracking')
    )

    let redirectRejected = false
    try {
      await fetchSearchPage(new URL(`${origin}/redirect`), AbortSignal.timeout(5000))
    } catch {
      redirectRejected = true
    }
    check('search transport refuses redirects', redirectRejected)

    let largeRejected = false
    try {
      await fetchSearchPage(new URL(`${origin}/large`), AbortSignal.timeout(5000))
    } catch {
      largeRejected = true
    }
    check('search transport refuses oversized responses', largeRejected)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})
