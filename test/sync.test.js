const { suite } = require('./support/harness')

/**
 * Sync: the key, the signing, and the trip through a bucket.
 *
 * The claim this feature makes is that a machine can hand its conversations to
 * a server it does not trust, so the tests are about exactly that: that what
 * lands in the bucket is unreadable and unrecognisable, that only the key opens
 * it, and that what comes back out the other side is what went in — including
 * the deletions, which are the part every naive sync gets wrong.
 *
 * The bucket here is a Map. Nothing talks to a network.
 */

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

/**
 * An S3-shaped thing that keeps objects in memory.
 *
 * Speaks only what the client actually uses: GET, PUT, DELETE, and a list
 * response in the XML shape the client reads.
 */
function bucket(name = 'deep-pink-test') {
  const objects = new Map()
  const calls = []

  // Path-style requests carry the bucket in the URL; the object key is what
  // follows it, which is what a real S3 lists and what the client asks for.
  const keyOf = (pathname) => pathname.replace(`/${name}`, '')

  const fetcher = async (url, init) => {
    const parsed = new URL(url)
    const method = init.method
    calls.push(`${method} ${keyOf(parsed.pathname)}`)

    // A real bucket answers 403 when the signature does not cover the request
    // it arrived on, and 404 when the address is not one of its own. Both are
    // checked here because neither used to be, and both were wrong.
    if (!parsed.pathname.startsWith(`/${name}/`) && parsed.pathname !== `/${name}/`) {
      return new Response('<Error><Message>no such bucket</Message></Error>', { status: 404 })
    }
    const auth = init.headers.Authorization ?? ''
    const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? ''
    if (!auth.startsWith('AWS4-HMAC-SHA256 ') || !signed.includes('x-amz-content-sha256')) {
      return new Response('<Error><Message>bad signature</Message></Error>', { status: 403 })
    }

    if (method === 'GET' && parsed.searchParams.get('list-type') === '2') {
      // ListObjectsV2 is a question about the bucket; asking it of a key is
      // asking the wrong URL, and a real S3 would answer something else.
      if (parsed.pathname !== `/${name}/` && parsed.pathname !== `/${name}`) {
        return new Response('<Error><Message>listing must address the bucket</Message></Error>', {
          status: 400
        })
      }
      const prefix = parsed.searchParams.get('prefix') ?? ''
      const contents = [...objects.entries()]
        .filter(([key]) => key.startsWith(`/${prefix}`))
        .map(
          ([key, body]) =>
            `<Contents><Key>${key.slice(1)}</Key><Size>${body.length}</Size>` +
            `<LastModified>2026-08-24T00:00:00.000Z</LastModified></Contents>`
        )
        .join('')
      return new Response(
        `<?xml version="1.0"?><ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        { status: 200 }
      )
    }

    if (method === 'GET') {
      const body = objects.get(keyOf(parsed.pathname))
      return body ? new Response(body, { status: 200 }) : new Response('', { status: 404 })
    }

    if (method === 'PUT') {
      objects.set(keyOf(parsed.pathname), Buffer.from(init.body))
      return new Response('', { status: 200 })
    }

    if (method === 'DELETE') {
      objects.delete(keyOf(parsed.pathname))
      // 204 carries no body, and constructing one that does throws.
      return new Response(null, { status: 204 })
    }

    return new Response('', { status: 405 })
  }

  return { objects, calls, fetcher }
}

/** True if any object's name or body contains this text. */
function leaks(store, text) {
  const needle = Buffer.from(text, 'utf8')
  for (const [key, body] of store.objects) {
    if (key.includes(text)) return `name ${key}`
    if (body.includes(needle)) return `body of ${key}`
    // Base64 is the other shape a secret could travel in.
    if (body.includes(Buffer.from(needle.toString('base64'), 'utf8'))) return `base64 in ${key}`
  }
  return null
}

suite('sync — a bucket that is told nothing', async ({ check, section, subject }) => {
  const { getDb, repo, attachments, syncCrypto, s3, syncEngine, syncRecords, secrets } = subject
  getDb()

  /* ---------------------------------------------------------------- */
  section('the key a person carries between machines')

  const key = syncCrypto.generateKey()
  check('it is 256 bits', key.length === 32 && syncCrypto.KEY_BYTES === 32)

  const written = syncCrypto.formatKey(key)
  check('it writes down as something typeable', /^DPSK1(-[0-9A-HJKMNP-TV-Z]{1,5})+$/.test(written), written)
  check('and reads back exactly', syncCrypto.parseKey(written).equals(key))
  check('grouping and case are forgiven', syncCrypto.parseKey(written.toLowerCase().replace(/-/g, ' ')).equals(key))

  const typo = written.slice(0, -1) + (written.endsWith('A') ? 'B' : 'A')
  check('a mistyped key is refused rather than tried', syncCrypto.parseKey(typo) === null, typo)
  check('so is something that is not a key at all', syncCrypto.parseKey('hello') === null)
  check(
    'two keys are different',
    !syncCrypto.generateKey().equals(syncCrypto.generateKey())
  )

  const print = syncCrypto.keyFingerprint(key)
  check('a fingerprint is short and stable', print.length === 9 && print === syncCrypto.keyFingerprint(key))
  check('and gives nothing away', !written.includes(print.replace('-', '')))
  check(
    'a different key prints differently',
    syncCrypto.keyFingerprint(syncCrypto.generateKey()) !== print
  )

  /* ---------------------------------------------------------------- */
  section('sealing')

  const secretText = 'the borrow checker is a monad, discuss'
  const sealed = syncCrypto.seal(key, 'r/abc', Buffer.from(secretText, 'utf8'))

  check('it opens with the key it was sealed with',
    syncCrypto.open(key, 'r/abc', sealed).toString('utf8') === secretText)
  check('the plaintext is not in the ciphertext', !sealed.includes(Buffer.from('borrow', 'utf8')))
  check('another key opens nothing', syncCrypto.open(syncCrypto.generateKey(), 'r/abc', sealed) === null)
  check('under another name it opens nothing either', syncCrypto.open(key, 'r/xyz', sealed) === null)

  const tampered = Buffer.from(sealed)
  tampered[tampered.length - 1] ^= 1
  check('one flipped bit is refused', syncCrypto.open(key, 'r/abc', tampered) === null)
  check('so is a truncated object', syncCrypto.open(key, 'r/abc', sealed.subarray(0, 20)) === null)
  check('so is something that was never sealed', syncCrypto.open(key, 'r/abc', Buffer.from('hello')) === null)

  const again = syncCrypto.seal(key, 'r/abc', Buffer.from(secretText, 'utf8'))
  check('the same text seals differently each time', !again.equals(sealed))
  check('and both still open', syncCrypto.open(key, 'r/abc', again).toString('utf8') === secretText)

  const round = syncCrypto.openJson(key, 'r/j', syncCrypto.sealJson(key, 'r/j', { a: [1, 2, 3] }))
  check('JSON survives the round trip', JSON.stringify(round) === '{"a":[1,2,3]}')

  /* ---------------------------------------------------------------- */
  section('names say nothing')

  const name = syncCrypto.objectName(key, 'record:thread:1234')
  check('a name is a hash', /^[0-9a-f]{64}$/.test(name), name)
  check('the same thing lands in the same place', syncCrypto.objectName(key, 'record:thread:1234') === name)
  check('a different thing does not', syncCrypto.objectName(key, 'record:thread:1235') !== name)
  check(
    'and another key names it something else entirely',
    syncCrypto.objectName(syncCrypto.generateKey(), 'record:thread:1234') !== name
  )
  check('the id is not recoverable from the name', !name.includes('1234'))

  /* ---------------------------------------------------------------- */
  section('signing, against Amazon’s published example')

  // From "Examples: Signature Calculations" in the S3 API reference — GET
  // an object with a Range header. If this drifts, every request is rejected.
  const vector = s3.sign(
    {
      endpoint: '',
      region: 'us-east-1',
      bucket: 'examplebucket',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      prefix: ''
    },
    'GET',
    'https://examplebucket.s3.amazonaws.com',
    '/test.txt',
    {},
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    new Date('2013-05-24T00:00:00Z'),
    { range: 'bytes=0-9' }
  )

  check(
    'the signature matches the vector',
    vector.headers.Authorization.includes(
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    ),
    vector.headers.Authorization
  )
  check(
    'with the credential scope it documents',
    vector.headers.Authorization.includes(
      'Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request'
    ),
    vector.headers.Authorization
  )
  check(
    'and the signed headers in order',
    vector.headers.Authorization.includes('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date'),
    vector.headers.Authorization
  )

  // The second published example: a PUT, so the body is part of what is signed.
  const putVector = s3.sign(
    {
      endpoint: '',
      region: 'us-east-1',
      bucket: 'examplebucket',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      prefix: ''
    },
    'PUT',
    'https://examplebucket.s3.amazonaws.com',
    '/test$file.text',
    {},
    '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    new Date('2013-05-24T00:00:00Z'),
    { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }
  )
  check(
    'a signed body matches its vector too',
    putVector.headers.Authorization.includes(
      'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'
    ),
    putVector.canonical
  )

  // The bug that made every request to R2 and MinIO come back 403: with the
  // bucket in the path rather than the host, it has to be in the signature.
  const pathStyle = s3.sign(
    {
      endpoint: 'https://s3.example.com',
      region: 'auto',
      bucket: 'mybucket',
      accessKeyId: 'K',
      secretAccessKey: 'S',
      prefix: 'dp'
    },
    'PUT',
    'https://s3.example.com/mybucket',
    '/dp/r/abc',
    {},
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    new Date('2026-08-24T00:00:00Z')
  )
  check(
    'a path-style request signs the bucket segment',
    pathStyle.canonical.split('\n')[1] === '/mybucket/dp/r/abc',
    pathStyle.canonical.split('\n')[1]
  )
  check(
    'and asks for the same path it signed',
    new URL(pathStyle.url).pathname === pathStyle.canonical.split('\n')[1],
    pathStyle.url
  )

  check(
    'AWS puts the bucket in the host',
    s3.origin({ endpoint: '', region: 'eu-west-2', bucket: 'b', accessKeyId: '', secretAccessKey: '', prefix: '' }) ===
      'https://b.s3.eu-west-2.amazonaws.com'
  )
  // What Cloudflare shows as a bucket's "S3 API" URL already has the bucket on
  // the end of it. Pasting that addressed /bucket/bucket, and every request
  // came back "the specified key does not exist".
  check(
    'an endpoint that already names the bucket is not doubled',
    s3.origin({
      endpoint: 'https://acct.r2.cloudflarestorage.com/mybucket',
      region: 'auto',
      bucket: 'mybucket',
      accessKeyId: '',
      secretAccessKey: '',
      prefix: ''
    }) === 'https://acct.r2.cloudflarestorage.com/mybucket'
  )
  check(
    'however it was capitalised or punctuated',
    s3.origin({
      endpoint: 'https://acct.r2.cloudflarestorage.com/MyBucket/ ',
      region: 'auto',
      bucket: 'MyBucket',
      accessKeyId: '',
      secretAccessKey: '',
      prefix: ''
    }) === 'https://acct.r2.cloudflarestorage.com/MyBucket'
  )
  check(
    'but a path that is not the bucket is left alone',
    s3.origin({
      endpoint: 'https://host/s3',
      region: 'auto',
      bucket: 'b',
      accessKeyId: '',
      secretAccessKey: '',
      prefix: ''
    }) === 'https://host/s3/b'
  )

  check(
    'and anything else puts it in the path',
    s3.origin({
      endpoint: 'https://x.r2.cloudflarestorage.com/',
      region: 'auto',
      bucket: 'b',
      accessKeyId: '',
      secretAccessKey: '',
      prefix: ''
    }) === 'https://x.r2.cloudflarestorage.com/b'
  )

  /* ---------------------------------------------------------------- */
  section('a library to carry')

  const folder = repo.createFolder('Systems')
  const thread = repo.createThread('Rust ownership', { model: 'anthropic/claude-sonnet-4.5' })
  repo.setThreadFolder(thread.id, folder.id)
  const question = repo.insertMessage({
    threadId: thread.id,
    role: 'user',
    content: 'Explain the borrow checker'
  })
  const answer = repo.insertMessage({
    threadId: thread.id,
    role: 'assistant',
    content: 'Ownership means one owner at a time.',
    model: 'anthropic/claude-sonnet-4.5',
    provider: 'anthropic'
  })
  repo.recordUsage(thread.id, answer.id, 'anthropic/claude-sonnet-4.5', 'anthropic', {
    promptTokens: 120, completionTokens: 340, reasoningTokens: 0, cachedTokens: 0,
    totalTokens: 460, costUsd: 0.00234, latencyMs: 2100, timeToFirstTokenMs: 380,
    tokensPerSecond: 42.5, generationId: 'gen-1'
  })
  const picture = attachments.store(thread.id, question.id, {
    mime: 'image/png', filename: 'diagram.png', data: PNG, width: 1, height: 1
  })
  repo.setSetting('settings', { defaultModel: 'anthropic/claude-opus-4', temperature: 0.4 })

  // The one thing that must never travel.
  secrets.setApiKey('sk-or-must-never-leave-this-machine')

  /* ---------------------------------------------------------------- */
  section('pushing')

  const store = bucket()
  syncEngine.importKey(written)
  syncEngine.setS3Secret('test-secret')
  syncEngine.saveConfig({
    enabled: true,
    endpoint: 'https://s3.example.com',
    region: 'auto',
    bucket: 'deep-pink-test',
    prefix: 'dp',
    accessKeyId: 'AKIATEST',
    deviceName: 'Device A',
    scopes: { conversations: true, settings: true }
  })

  // Used by the progress checks below, which need something to send again.
  const becomeFirstMachineAgain = () => {
    getDb().exec("DELETE FROM settings WHERE key = 'sync.manifest'")
  }

  const first = await syncEngine.run({ fetcher: store.fetcher })
  check('it ran without error', first.error === null, first.error)
  check('and sent something', first.pushed > 0, first)
  check('objects are in the bucket', store.objects.size > 0, store.objects.size)

  section('it says where it has got to')
  // A first sync of a long library is thousands of objects; a bar that only
  // appears at the end is a spinner with extra steps.
  const seenPhases = []
  becomeFirstMachineAgain()
  await syncEngine.run({
    fetcher: store.fetcher,
    onProgress: (progress) => seenPhases.push(progress)
  })

  check('it reports as it goes', seenPhases.length > 3, seenPhases.length)
  check(
    'starting by finding the other machines',
    seenPhases[0].phase === 'listing',
    seenPhases[0]
  )
  check(
    'and ending when it is done',
    seenPhases[seenPhases.length - 1].phase === 'done',
    seenPhases[seenPhases.length - 1]
  )
  check(
    'every step says what it is doing',
    seenPhases.every((p) => typeof p.detail === 'string' && p.detail.length > 0)
  )
  check(
    'a sending step has something to count against',
    seenPhases.some((p) => p.phase === 'sending' && p.total > 0),
    seenPhases.filter((p) => p.phase === 'sending').slice(0, 3)
  )
  check(
    'and never counts past its own total',
    seenPhases.every((p) => p.done <= p.total || p.total === 0),
    seenPhases.filter((p) => p.done > p.total && p.total > 0)
  )
  check(
    'the running totals only ever grow',
    seenPhases.every((p, i) => i === 0 || p.pushed >= seenPhases[i - 1].pushed)
  )

  const failedProgress = []
  await syncEngine.run({
    fetcher: async () => new Response('', { status: 500 }),
    onProgress: (progress) => failedProgress.push(progress)
  })
  check(
    'a run that fails says so through the same channel',
    failedProgress[failedProgress.length - 1]?.phase === 'error',
    failedProgress[failedProgress.length - 1]
  )

  section('and the bucket knows nothing about any of it')
  check('not the thread title', leaks(store, 'Rust ownership') === null, leaks(store, 'Rust ownership'))
  check('not what was said', leaks(store, 'borrow checker') === null, leaks(store, 'borrow checker'))
  check('not the model', leaks(store, 'claude-sonnet') === null, leaks(store, 'claude-sonnet'))
  check('not the folder', leaks(store, 'Systems') === null, leaks(store, 'Systems'))
  check('not a file name', leaks(store, 'diagram.png') === null, leaks(store, 'diagram.png'))
  check('not the thread id', leaks(store, thread.id) === null, leaks(store, thread.id))
  check('not the device name', leaks(store, 'Device A') === null, leaks(store, 'Device A'))
  check(
    'and above all not the OpenRouter key',
    leaks(store, 'sk-or-must-never-leave-this-machine') === null
  )
  check(
    'every object name is an opaque hash under the prefix',
    [...store.objects.keys()].every((path) => /^\/dp\/[mr]\/[0-9a-f]{64}$/.test(path)),
    [...store.objects.keys()].slice(0, 3)
  )

  section('even the connection check gives nothing away')
  const probe = bucket()
  await syncEngine.testConnection(probe.fetcher)
  check('it wrote, read and cleaned up after itself', probe.objects.size === 0, [...probe.objects.keys()])
  check(
    'and while it existed it was named like everything else',
    probe.calls.every((call) => /^(PUT|GET|DELETE) \/dp\/r\/[0-9a-f]{64}$/.test(call)),
    probe.calls
  )

  section('nothing is sent twice')
  const idle = await syncEngine.run({ fetcher: store.fetcher })
  check('a second run has nothing to push', idle.pushed === 0, idle)
  check('and nothing to pull', idle.pulled === 0, idle)
  check('and uploads nothing at all, not even a manifest', idle.bytesUp === 0, idle)

  /* ---------------------------------------------------------------- */
  section('a second machine, starting from nothing')

  const db = getDb()
  const becomeFreshMachine = (device) => {
    repo.wipeAllData()
    db.exec('DELETE FROM attachments')
    db.exec("DELETE FROM settings WHERE key = 'settings'")
    db.exec('DELETE FROM mcp_servers')
    // A machine that has never seen this library has no memory of deletions
    // either — the wipe above is local surgery, not a decision to sync.
    db.exec('DELETE FROM sync_deletions')
    repo.setSetting('sync.manifest', null)
    const config = repo.getSetting('sync', {})
    repo.setSetting('sync', { ...config, deviceId: device, deviceName: device })
  }

  becomeFreshMachine('device-B')
  check('it starts empty', repo.listThreads().length === 0)

  const second = await syncEngine.run({ fetcher: store.fetcher })
  check('it ran', second.error === null, second.error)
  check('it saw the other machine', second.devices === 2, second.devices)
  check('and took the library', second.pulled > 0, second)

  const restored = repo.listThreads()
  check('the thread is here', restored.length === 1 && restored[0].title === 'Rust ownership', restored)
  check('with its settings', restored[0].config.model === 'anthropic/claude-sonnet-4.5')
  check('in its folder', repo.getFolder(restored[0].folderId)?.name === 'Systems')

  const messages = repo.getMessages(restored[0].id)
  check('both messages came', messages.length === 2, messages.length)
  check('in order', messages[0].content === 'Explain the borrow checker')
  check('with what the reply cost', messages[1].usage?.costUsd === 0.00234, messages[1].usage)
  check('and its model', messages[1].model === 'anthropic/claude-sonnet-4.5')

  check('the attachment came with it', messages[0].attachments.length === 1, messages[0].attachments)
  check(
    'and so did the picture itself',
    attachments.readBase64(messages[0].attachments[0].id) === PNG
  )
  check('the app settings came too', repo.getSetting('settings', {}).temperature === 0.4)
  check(
    'the OpenRouter key did not, because it was never in the database',
    secrets.getApiKey() === 'sk-or-must-never-leave-this-machine'
  )

  /* ---------------------------------------------------------------- */
  section('a deletion travels')

  repo.deleteThread(restored[0].id)
  check('it is gone here', repo.listThreads().length === 0)

  const third = await syncEngine.run({ fetcher: store.fetcher })
  check('the deletion is pushed', third.pushed > 0, third)

  becomeFreshMachine('device-C')
  const fourth = await syncEngine.run({ fetcher: store.fetcher })
  check('a third machine syncs', fourth.error === null, fourth.error)
  check('and does not resurrect the deleted thread', repo.listThreads().length === 0, repo.listThreads())
  check('nor its messages', db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 0)

  /* ---------------------------------------------------------------- */
  section('an edit made elsewhere wins over an older copy')

  // Device C writes something of its own, pushes it, and device D picks it up.
  const local = repo.createThread('Written on C')
  repo.insertMessage({ threadId: local.id, role: 'user', content: 'first' })
  await syncEngine.run({ fetcher: store.fetcher })

  becomeFreshMachine('device-D')
  await syncEngine.run({ fetcher: store.fetcher })
  const onD = repo.listThreads()
  check('D has the thread C wrote', onD.length === 1 && onD[0].title === 'Written on C', onD)

  repo.updateThread(onD[0].id, { title: 'Renamed on D' })
  await syncEngine.run({ fetcher: store.fetcher })

  becomeFreshMachine('device-E')
  await syncEngine.run({ fetcher: store.fetcher })
  const onE = repo.listThreads()
  check('a later edit is the one that survives', onE[0]?.title === 'Renamed on D', onE)

  /* ---------------------------------------------------------------- */
  section('which way each half travels')

  // Two-way is the default and is what everything above exercises. These are
  // the other two: a machine that decides, and a machine that follows.
  const twoWay = { conversations: true, settings: true, conversationsDirection: 'two-way', settingsDirection: 'two-way' }

  becomeFreshMachine('device-F')
  syncEngine.saveConfig({ scopes: { ...twoWay, conversationsDirection: 'push', settingsDirection: 'push' } })
  repo.createThread('Written on F')

  const sender = await syncEngine.run({ fetcher: store.fetcher })
  check('a send-only machine runs', sender.error === null, sender.error)
  check('and hands over what it wrote', sender.pushed > 0, sender)
  check('but takes nothing down', sender.pulled === 0, sender)
  check(
    'so the library it never asked for is not here',
    repo.listThreads().length === 1,
    repo.listThreads()
  )

  becomeFreshMachine('device-G')
  syncEngine.saveConfig({ scopes: { ...twoWay, conversationsDirection: 'pull', settingsDirection: 'pull' } })
  repo.createThread('Kept on G')

  const receiver = await syncEngine.run({ fetcher: store.fetcher })
  check('a receive-only machine takes the library', receiver.pulled > 0, receiver)
  check('and offers nothing of its own', receiver.pushed === 0, receiver)
  check(
    'what it wrote is still here, it simply did not travel',
    repo.listThreads().some((t) => t.title === 'Kept on G'),
    repo.listThreads()
  )

  becomeFreshMachine('device-H')
  syncEngine.saveConfig({ scopes: { ...twoWay } })
  await syncEngine.run({ fetcher: store.fetcher })
  const seenByH = repo.listThreads().map((t) => t.title)
  check('nothing a receive-only machine wrote reached the bucket', !seenByH.includes('Kept on G'), seenByH)
  check('while what a send-only machine wrote did', seenByH.includes('Written on F'), seenByH)

  /* ---------------------------------------------------------------- */
  section('filing a thread travels, even though filing is not editing')

  const shelf = repo.createFolder('Shelf')
  const toFile = repo.listThreads().find((t) => t.title === 'Written on F')
  const editedAt = toFile.updatedAt
  repo.setThreadFolder(toFile.id, shelf.id)
  check(
    'filing does not stamp the thread as edited',
    repo.getThread(toFile.id).updatedAt === editedAt,
    { editedAt, now: repo.getThread(toFile.id).updatedAt }
  )

  const filedRun = await syncEngine.run({ fetcher: store.fetcher })
  check('the move is something to send all the same', filedRun.pushed > 0, filedRun)

  becomeFreshMachine('device-K')
  syncEngine.saveConfig({ scopes: { ...twoWay } })
  await syncEngine.run({ fetcher: store.fetcher })
  const arrived = repo.listThreads().find((t) => t.title === 'Written on F')
  check(
    'and the other machine learns where it was put',
    repo.getFolder(arrived.folderId)?.name === 'Shelf',
    arrived
  )
  check(
    'without the move reading as an edit there either',
    repo.getThread(arrived.id).updatedAt === editedAt,
    repo.getThread(arrived.id).updatedAt
  )

  // Nothing after this section is about directions.
  syncEngine.saveConfig({ scopes: { ...twoWay } })

  /* ---------------------------------------------------------------- */
  section('what the screen in front of you decides stays here')

  // Settings travel as one row, which is what makes last-write-wins honest for
  // them — but the window's zoom is a fact about a monitor, not a preference,
  // and a desktop must not be able to shrink a laptop by having been used more
  // recently.
  repo.setSetting('settings', { temperature: 0.9, ui: { zoomLevel: 2, fontSize: 14 } })
  syncRecords.applyRecord({
    kind: 'setting',
    id: 'settings',
    rev: Date.now() + 60_000,
    data: {
      key: 'settings',
      value: JSON.stringify({ temperature: 0.2, ui: { zoomLevel: -1, fontSize: 18 } })
    }
  })

  const merged = repo.getSetting('settings', {})
  check('the settings that arrived are taken', merged.temperature === 0.2, merged)
  check('all of them, not only the ones already here', merged.ui.fontSize === 18, merged.ui)
  check('but this window keeps its own zoom', merged.ui.zoomLevel === 2, merged.ui)

  /* ---------------------------------------------------------------- */
  section('pausing')
  syncEngine.saveConfig({ enabled: true })
  syncEngine.resume()
  check('it starts unpaused', syncEngine.state().paused === false)

  syncEngine.pause(null)
  check('pausing says so', syncEngine.state().paused === true)
  check('and remembers there is no end to it', syncEngine.state().config.pause?.until === null)

  const held = await syncEngine.run({ fetcher: store.fetcher, automatic: true })
  check('the timer is held back', held.error === 'Syncing is paused' && held.pushed === 0, held)

  // A pause stops the schedule, not the person: "Sync now" still means now.
  repo.createThread('Written while paused')
  const byHand = await syncEngine.run({ fetcher: store.fetcher })
  check('but syncing by hand still works', byHand.error === null, byHand.error)

  syncEngine.resume()
  check('resuming clears it', syncEngine.state().paused === false)
  const afterResume = await syncEngine.run({ fetcher: store.fetcher, automatic: true })
  check('and the timer runs again', afterResume.error === null, afterResume.error)

  syncEngine.pause(Date.now() - 1000)
  check(
    'a pause whose time has passed is over, without anything having to notice',
    syncEngine.state().paused === false
  )
  check('and it is forgotten rather than left lying around', syncEngine.state().config.pause === null)

  syncEngine.pause(Date.now() + 60_000)
  check('a pause with a future time holds', syncEngine.state().paused === true)
  check('and says when it lifts', typeof syncEngine.state().config.pause?.until === 'number')
  syncEngine.resume()

  section('a pause during a run stops it where it is')
  // Enough to push that the pause lands mid-flight, and a bucket slow enough
  // for that to be true.
  becomeFreshMachine('device-P')
  for (let i = 0; i < 25; i++) {
    const thread = repo.createThread(`Thread ${i}`)
    repo.insertMessage({ threadId: thread.id, role: 'user', content: `message ${i}` })
  }

  const slow = bucket()
  const slowFetcher = async (url, init) => {
    await new Promise((resolve) => setTimeout(resolve, 2))
    return slow.fetcher(url, init)
  }

  const inFlight = syncEngine.run({ fetcher: slowFetcher })
  await new Promise((resolve) => setTimeout(resolve, 40))
  syncEngine.pause(null)
  const cut = await inFlight

  check('the run comes back rather than hanging', cut.error === null, cut.error)
  check('it says it was cut short', cut.stopped === true, cut)
  check('having done some of the work', cut.pushed > 0, cut.pushed)
  check('but not all of it', cut.pushed < 50, cut.pushed)

  // The half that went is recorded, so resuming carries on rather than
  // starting over.
  syncEngine.resume()
  const rest = await syncEngine.run({ fetcher: slowFetcher })
  check('the rest goes on the next run', rest.pushed > 0 && rest.error === null, rest)
  check('and then there is nothing left', (await syncEngine.run({ fetcher: slowFetcher })).pushed === 0)

  section('when it cannot work, it says so rather than throwing')

  const broken = await syncEngine.run({
    fetcher: async () =>
      new Response('<Error><Message>The specified key does not exist.</Message></Error>', {
        status: 404
      })
  })
  check(
    'a listing that 404s is explained as an address, not a missing file',
    /No bucket at/.test(broken.error ?? '') && !/key does not exist/.test(broken.error ?? ''),
    broken.error
  )

  syncEngine.saveConfig({ enabled: false })
  const off = await syncEngine.run({ fetcher: store.fetcher })
  check('switched off, it does nothing', off.error === 'Sync is switched off' && off.pushed === 0)

  section('disconnecting forgets the key')
  syncEngine.disconnect()
  const after = syncEngine.state()
  check('the key is gone', after.hasKey === false && after.keyFingerprint === null)
  check('so are the credentials', after.hasSecret === false)
  check('and it is no longer ready', after.ready === false)
  check('but the bucket still has its objects', store.objects.size > 0)
})
