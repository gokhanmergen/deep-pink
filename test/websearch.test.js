const { suite } = require('./support/harness')
const { createServer } = require('node:http')
const { session } = require('electron')

suite('Private metasearch', async ({ check, section, subject }) => {
  const { SearchService, rankResults, searchProviders, fetchSearchPage, runWebSearch, DEFAULT_SETTINGS } = subject
  const { parseSearchHtml, resultUrl, builtInProviders, searxngProvider } = searchProviders
  const hit = (name, url = `https://${name}.example/article`, snippet = 'A useful snippet.') =>
    ({ title: name, url, snippet })
  const options = { hedgeMs: 5, mergeMs: 5, providerTimeoutMs: 40, deadlineMs: 100,
    freshMs: 100, staleMs: 1000, cooldownMs: 100 }
  const makeProvider = (id, search) => ({ id, name: id, search })
  const request = (providers, extra = {}) => ({ query: 'electron documentation', limit: 2,
    providers, blockedDomains: [], ...extra })
  const rejects = async (work) => {
    try { await work(); return false } catch (err) { return err }
  }

  section('upgrade and explicit backend choices')
  const storedSettings = subject.repo.getSetting('settings', {})
  try {
    check('new installations default to free local search', DEFAULT_SETTINGS.web.engine === 'local')
    subject.repo.setSetting('settings', { web: { engine: 'duckduckgo', enabled: true, maxResults: 7 } })
    const upgraded = subject.loadSettings()
    check('legacy DuckDuckGo upgrades without losing preferences', upgraded.web.engine === 'local' &&
      upgraded.web.enabled && upgraded.web.maxResults === 7)
    check('older callers also receive the migrated engine', subject.saveSettings({ web: { engine: 'duckduckgo' } }).web.engine === 'local')
    for (const engine of ['searxng', 'openrouter']) {
      subject.saveSettings({ web: { engine, searxngUrl: 'http://localhost:9999' } })
      const saved = subject.loadSettings().web
      check(`${engine} remains an explicit choice`, saved.engine === engine && saved.searxngUrl === 'http://localhost:9999')
    }
  } finally { subject.repo.setSetting('settings', storedSettings) }

  section('engine markup and direct source URLs')
  const brave = parseSearchHtml('brave', `
    <div data-type='web' class='snippet'><a href='https://electronjs.org/docs?utm_source=brave'>
      <div class='search-snippet-title title'>Electron <b>documentation</b> &amp; API</div></a>
      <div class='generic-snippet'><div class='content'>Read <strong>official</strong> guides.</div></div></div>
    <div class='snippet' data-type='ad'><a href='https://ad.example'>Advertisement</a></div>`)
  check('Brave extracts organic title, URL and snippet', brave.length === 1 &&
    brave[0].title === 'Electron documentation & API' && brave[0].url === 'https://electronjs.org/docs' &&
    brave[0].snippet === 'Read official guides.', brave)

  const ddg = parseSearchHtml('duckduckgo', `
    <div class='result'><a href='//duckduckgo.com/l/?uddg=https%3A%2F%2Felectronjs.org%2Fdocs&amp;rut=123'
      class='other result__a'>Electron</a><div class='result__snippet'>First snippet.</div></div>
    <div class='result'><a href='https://github.com/electron/electron' class='result__a'>GitHub</a>
      <a class='result__snippet'>Second snippet.</a></div>
    <div class='result result--ad'><a class='result__a' href='https://ad.example'>Ad</a></div>
    <div class='result'><a class='result__a' href='/l/?uddg=%zz'>Broken redirect</a></div>`)
  check('DDG accepts reordered attributes and single quotes', ddg.length === 2, ddg)
  check('snippets remain paired with their own results', ddg[0].snippet === 'First snippet.' &&
    ddg[1].snippet === 'Second snippet.')
  check('DDG unwraps its redirect', ddg[0].url === 'https://electronjs.org/docs')

  const encoded = Buffer.from('https://electronjs.org/docs?utm_source=bing').toString('base64url')
  const bing = parseSearchHtml('bing', `<ol id='b_results'><li class='b_algo'>
    <h2><a href='https://www.bing.com/ck/a?u=a1${encoded}&amp;ntb=1'>Electron &amp; guides</a></h2>
    <div class='b_caption'><p>Official <b>reference</b>.</p></div></li></ol>`)
  check('Bing decodes base64 redirects and organic snippets', bing.length === 1 &&
    bing[0].url === 'https://electronjs.org/docs' && bing[0].snippet === 'Official reference.', bing)
  check('CAPTCHAs produce no fabricated hits',
    ['brave', 'bing', 'duckduckgo'].every((p) => parseSearchHtml(p, '<form>Verify you are human</form>').length === 0))
  check('invalid, credentialed and script URLs are discarded',
    ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com', ''].every((raw) =>
      resultUrl(raw, 'https://duckduckgo.com') === null))
  check('an unrelated uddg parameter is not followed',
    resultUrl('https://example.com/page?uddg=https%3A%2F%2Fevil.example', 'https://duckduckgo.com') ===
      'https://example.com/page?uddg=https%3A%2F%2Fevil.example')

  section('ranking, deduplication and domain policy')
  const ranked = rankResults([
    { name: 'Brave', results: [hit('a'), hit('common', 'http://www.common.example/doc#first'),
      hit('common', 'https://common.example/doc')] },
    { name: 'DDG', results: [hit('b'), hit('common', 'https://common.example/doc', 'A longer useful snippet.')] }
  ], [], 10)
  check('engine agreement promotes a shared result', ranked[0].title === 'common', ranked)
  check('duplicates within one engine cannot inflate a ranking', ranked.length === 3 &&
    ranked[0].sources.length === 2)
  check('shared URLs prefer https and preserve the richer snippet', ranked[0].url === 'https://common.example/doc' &&
    ranked[0].snippet === 'A longer useful snippet.')
  const safe = rankResults([{ name: 'test', results: [
    hit('blocked', 'https://sub.blocked.example/a'), hit('local', 'http://localhost/'),
    hit('private', 'http://192.168.0.1/'), hit('ipv6', 'http://[::1]/'),
    hit('mapped', 'http://[::ffff:127.0.0.1]/'), hit('bad', 'nonsense'), hit('safe')
  ] }], [' BLOCKED.EXAMPLE '], 10)
  check('blocked subdomains and local sources are excluded', safe.length === 1 && safe[0].title === 'safe', safe)

  section('free adapters and SearXNG')
  const called = []
  const free = builtInProviders(async (url, signal) => {
    called.push({ url, signal })
    return '<html></html>'
  })
  await Promise.all(free.map((p) => p.search('a & b + c', new AbortController().signal)))
  check('all free adapters encode the exact query', called.length === 3 &&
    called.every(({ url }) => url.searchParams.get('q') === 'a & b + c'))
  check('no paid or public proxy endpoint is used', called.every(({ url }) =>
    ['search.brave.com', 'www.bing.com', 'html.duckduckgo.com'].includes(url.hostname)))
  let searxUrl
  const searx = searxngProvider('http://localhost:8888/private/', async (url) => {
    searxUrl = url
    return JSON.stringify({ results: [{ title: '<b>Official</b>', url: 'https://example.org', content: 'A &amp; B' },
      null, { title: 'Malformed' }] })
  })
  const fromSearx = await searx.search('a & b', new AbortController().signal)
  check('SearXNG preserves proxy subpaths and requests JSON general search',
    searxUrl.pathname === '/private/search' && searxUrl.searchParams.get('format') === 'json' &&
    searxUrl.searchParams.get('categories') === 'general')
  check('SearXNG validates rows and decodes markup', fromSearx.length === 1 &&
    fromSearx[0].title === 'Official' && fromSearx[0].snippet === 'A & B', fromSearx)
  check('bad SearXNG responses are failures, not false empty results', Boolean(await rejects(() =>
    searxngProvider('http://localhost:8888', async () => '{}').search('test', new AbortController().signal))))

  section('fallback, partial results and hard deadlines')
  const failed = makeProvider('failed', async () => { throw new Error('HTTP 429') })
  const empty = makeProvider('challenge', async () => [])
  const good = makeProvider('good', async () => [hit('one'), hit('two')])
  const fallback = await new SearchService(options).search(request([failed, empty, good]))
  check('two failed sources fall through to a third', fallback.results.length === 2 &&
    fallback.results[0].sources.includes('good') && fallback.unavailable.includes('failed') &&
    fallback.unavailable.includes('challenge'), fallback)
  let directCalls = 0
  const direct = makeProvider('direct', async () => { directCalls++; return [hit('direct')] })
  await new SearchService(options).search(request([good, direct], { preferFirst: true }))
  check('a healthy preferred instance avoids direct engine queries', directCalls === 0)
  await new SearchService(options).search(request([failed, direct], { preferFirst: true, limit: 1 }))
  check('a failed preferred instance still falls back', directCalls === 1)

  let slowSignal
  const hung = makeProvider('hung', (_q, signal) => {
    slowSignal = signal
    return new Promise(() => {})
  })
  const hedged = await new SearchService(options).search(request([hung, hung, good]))
  check('slow primaries trigger the reserve without waiting for their timeout', hedged.results.length === 2)
  check('unused requests are aborted after results arrive', slowSignal.aborted)
  const partial = await new SearchService(options).search(request([hung,
    makeProvider('partial', async () => [hit('one')])], { limit: 5 }))
  check('partial results survive another provider timing out', partial.results.length === 1)
  const unavailable = await rejects(() => new SearchService({ ...options, deadlineMs: 10,
    providerTimeoutMs: 1000 }).search(request([hung])))
  check('the overall deadline ends even an uncooperative transport', unavailable instanceof Error &&
    unavailable.message.includes('temporarily unavailable'))
  const allDown = await rejects(() => new SearchService(options).search(request([failed, empty])))
  check('total outage explains failure without claiming no matching pages exist', allDown.message.includes('does not establish'))

  section('cooldowns and recovery')
  let clock = 10_000
  let failing = true
  let calls = 0
  const recovering = makeProvider('recovering', async () => {
    calls++
    if (failing) throw new Error('offline')
    return [hit('recovered')]
  })
  const health = new SearchService({ ...options, now: () => clock })
  await health.search(request([recovering, good], { query: 'first' }))
  await health.search(request([recovering, good], { query: 'second' }))
  check('failed sources are skipped during cooldown', calls === 1)
  clock += 101
  failing = false
  const recovered = await health.search(request([recovering, good], { query: 'third' }))
  check('sources are retried and recover after cooldown', calls === 2 &&
    recovered.results.some((r) => r.title === 'recovered'))
  await health.search(request([recovering, good], { query: 'fourth' }))
  check('successful recovery clears the circuit', calls === 3)
  let probes = 0
  const down = makeProvider('down', async () => { probes++; throw new Error('offline') })
  const open = new SearchService({ ...options, now: () => clock })
  await rejects(() => open.search(request([down], { query: 'one' })))
  await rejects(() => open.search(request([down], { query: 'two' })))
  check('an all-open circuit still probes a source', probes === 2)
  let backupOnline = false
  const backup = makeProvider('backup', async () => {
    if (!backupOnline) throw new Error('offline')
    return [hit('one'), hit('two')]
  })
  const bothOpen = new SearchService({ ...options, now: () => clock })
  await rejects(() => bothOpen.search(request([down, backup], { query: 'both down' })))
  backupOnline = true
  check('all-open recovery can use a recovered backup immediately',
    (await bothOpen.search(request([down, backup], { query: 'backup recovered' }))).results.length === 2)

  section('fresh and stale cache boundaries')
  let cacheCalls = 0
  let online = true
  const cachedProvider = makeProvider('cached', async () => {
    cacheCalls++
    if (!online) throw new Error('offline')
    return [hit('one'), hit('two')]
  })
  const cachedService = new SearchService({ ...options, now: () => clock })
  const cacheRequest = request([cachedProvider])
  const live = await cachedService.search(cacheRequest)
  const fresh = await cachedService.search(cacheRequest)
  check('a repeated request uses a fresh memory entry', cacheCalls === 1 && fresh.cached && !fresh.stale)
  await cachedService.search({ ...cacheRequest, limit: 1 })
  check('a changed result count gets its own cache entry', cacheCalls === 2)
  clock += 101
  online = false
  const stale = await cachedService.search(cacheRequest)
  check('outages return explicitly stale matching results', stale.cached && stale.stale && stale.results.length === 2)
  check('reading stale results preserves the original retrieval time', stale.searchedAt === live.searchedAt)
  const filtered = await rejects(() => cachedService.search({ ...cacheRequest, blockedDomains: ['one.example', 'two.example'] }))
  check('a changed domain policy cannot reuse an old cache entry', filtered instanceof Error)
  clock += 1001
  check('expired cache cannot disguise a continuing outage', Boolean(await rejects(() => cachedService.search(cacheRequest))))
  let boundedCalls = 0
  const boundedProvider = makeProvider('bounded', async () => { boundedCalls++; return [hit('one')] })
  const bounded = new SearchService({ ...options, now: () => clock })
  for (let i = 0; i < 101; i++) await bounded.search(request([boundedProvider], { query: `query ${i}`, limit: 1 }))
  await bounded.search(request([boundedProvider], { query: 'query 0', limit: 1 }))
  check('the memory cache evicts old entries at its bound', boundedCalls === 102)

  section('shared requests and cancellation')
  let sharedCalls = 0
  let finishShared
  let sharedSignal
  const shared = makeProvider('shared', (_q, signal) => {
    sharedCalls++
    sharedSignal = signal
    return new Promise((resolve) => { finishShared = resolve })
  })
  const sharedService = new SearchService(options)
  const stop = new AbortController()
  const left = sharedService.search(request([shared], { signal: stop.signal }))
  const right = sharedService.search(request([shared]))
  const leftRejected = rejects(() => left)
  await Promise.resolve()
  stop.abort()
  check('stopping one subscriber cancels only its wait', Boolean(await leftRejected) && !sharedSignal.aborted)
  finishShared([hit('one'), hit('two')])
  check('another subscriber keeps the shared search', (await right).results.length === 2 && sharedCalls === 1)
  const lastStop = new AbortController()
  const last = sharedService.search(request([shared], { query: 'last', signal: lastStop.signal }))
  const lastRejected = rejects(() => last)
  await Promise.resolve()
  lastStop.abort()
  await lastRejected
  check('stopping the final subscriber aborts its upstream work', sharedSignal.aborted)
  const alreadyStopped = new AbortController()
  alreadyStopped.abort()
  const before = sharedCalls
  await rejects(() => sharedService.search(request([shared], { signal: alreadyStopped.signal })))
  check('an already cancelled query never starts network work', sharedCalls === before)

  section('tool input validation')
  check('non-string queries fail clearly', Boolean(await rejects(() => runWebSearch({ query: 7 }, DEFAULT_SETTINGS.web))))
  check('oversized queries are rejected before network access', Boolean(await rejects(() =>
    runWebSearch({ query: 'x'.repeat(2001) }, DEFAULT_SETTINGS.web))))
  check('bad numeric HTML entities do not crash page extraction',
    subject.htmlToText('<p>&#999999999; &#xFFFFFFF;</p>').includes('999999999'))

  section('isolated network transport')
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.headers)
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/page' }); res.end(); return }
    if (req.url === '/large') { res.end('x'.repeat(2_000_001)); return }
    if (req.url === '/slow') { res.writeHead(200); res.write('partial'); return }
    res.setHeader('Set-Cookie', 'search_tracking=1; Path=/')
    res.end('<html><script>throw new Error("must not execute")</script><p>Search page</p></html>')
  })
  const sockets = new Set()
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    await session.defaultSession.cookies.set({ url: origin, name: 'app_secret', value: 'private' })
    const isolated = session.fromPartition('deep-pink-private-search', { cache: false })
    await isolated.cookies.set({ url: origin, name: 'old_cookie', value: 'must-not-send' })
    const page = await fetchSearchPage(new URL(`${origin}/page`), AbortSignal.timeout(1000))
    await fetchSearchPage(new URL(`${origin}/page`), AbortSignal.timeout(1000))
    check('session is nonpersistent', !isolated.isPersistent())
    check('search neither sends cookies nor a referrer', requests.slice(0, 2).every((r) => !r.cookie && !r.referer))
    check('returned cookies are not saved', !(await isolated.cookies.get({ url: origin })).some((c) => c.name === 'search_tracking'))
    check('HTML is returned without executing scripts', page.includes('must not execute'))
    check('redirects are refused', Boolean(await rejects(() => fetchSearchPage(new URL(`${origin}/redirect`), AbortSignal.timeout(1000)))))
    check('oversized responses are refused', Boolean(await rejects(() => fetchSearchPage(new URL(`${origin}/large`), AbortSignal.timeout(1000)))))
    check('a stalled response body respects cancellation', Boolean(await rejects(() =>
      fetchSearchPage(new URL(`${origin}/slow`), AbortSignal.timeout(20)))))
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})
