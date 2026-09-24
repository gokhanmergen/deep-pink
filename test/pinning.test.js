const { suite, sseResponse, writeTestApiKey } = require('./support/harness')

/**
 * A conversation keeps the model it was had with.
 *
 * A thread nobody had picked a model for stored nothing, and meant "the
 * default" — the default at whatever moment it was looked at. So changing the
 * default in Settings re-labelled every one of those chats: the sidebar icon,
 * the title bar and the composer all named the new model, and the next
 * message in any of them went to a model that conversation had never spoken
 * to. The replies themselves had recorded the right one; the thread claimed
 * another.
 *
 * Two halves: the engine pins the model the first time a thread is used, and
 * a migration gives every thread that already exists the model its replies
 * actually came from.
 */
suite('pinning — a chat keeps the model it was had with', async ({ check, section, subject }) => {
  const { getDb, repo, sendMessage, MIGRATIONS } = subject
  getDb()
  writeTestApiKey()

  const originalFetch = global.fetch
  const asked = []
  global.fetch = async (url, init) => {
    if (String(url).includes('/chat/completions')) {
      asked.push(JSON.parse(init.body).model)
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        'data: {"choices":[{"finish_reason":"stop","delta":{}}]}',
        'data: [DONE]'
      ])
    }
    // Anything else — the catalogue, naming — is not what this is about.
    return { ok: false, status: 503, headers: new Map(), json: async () => ({}) }
  }

  const settings = (defaultModel) =>
    repo.setSetting('settings', { defaultModel, titleGenerationEnabled: false })
  const modelOf = (id) => repo.getThread(id).config.model
  const say = (threadId, content) => sendMessage({ threadId, content }, () => {})

  section('first use pins it')
  settings('test/first')
  const used = repo.createThread('Used')
  const empty = repo.createThread('Not yet')
  check('a new thread follows the default until it is used', modelOf(used.id) === null)

  await say(used.id, 'hello')
  check('and is pinned to it by being used', modelOf(used.id) === 'test/first', modelOf(used.id))
  check('the request went to that model', asked.at(-1) === 'test/first', asked)
  check('an empty one is left following', modelOf(empty.id) === null, modelOf(empty.id))

  section('then the default changes')
  settings('test/second')
  check('the used thread still says what it was had with', modelOf(used.id) === 'test/first', modelOf(used.id))
  check('the empty one now follows the new default', modelOf(empty.id) === null)

  await say(used.id, 'again')
  check(
    'and the next message in it goes where the conversation was',
    asked.at(-1) === 'test/first',
    asked
  )

  /*
   * An explicit choice is a choice, and the pinning is only for threads that
   * made none: a model picked in the picker is left exactly as it was.
   */
  section('a thread with a model picked')
  const picked = repo.createThread('Picked', { model: 'test/picked' })
  await say(picked.id, 'hi')
  check('keeps it', modelOf(picked.id) === 'test/picked', modelOf(picked.id))
  check('and is asked with it', asked.at(-1) === 'test/picked', asked)

  /* ---------------------------------------------------------------- *
   * The threads that already exist
   * ---------------------------------------------------------------- */

  section('the migration, against chats in the old shape')
  const db = getDb()
  const T0 = 1700000000000
  const thread = (id, config) =>
    db.prepare('INSERT INTO threads (id, title, created_at, updated_at, config) VALUES (?, ?, ?, ?, ?)')
      .run(id, id, T0, T0, config)
  const message = (id, threadId, seq, role, model) =>
    db.prepare(
      'INSERT INTO messages (id, thread_id, seq, role, content, created_at, model, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, threadId, seq, role, `${role} ${seq}`, T0 + seq, model, 'complete')

  thread('legacy-switched', '{}')
  message('ls1', 'legacy-switched', 1, 'user', null)
  message('ls2', 'legacy-switched', 2, 'assistant', 'test/older')
  message('ls3', 'legacy-switched', 3, 'user', null)
  message('ls4', 'legacy-switched', 4, 'assistant', 'test/latest')

  thread('legacy-explicit', '{"model":"test/chosen"}')
  message('le1', 'legacy-explicit', 1, 'user', null)
  message('le2', 'legacy-explicit', 2, 'assistant', 'test/other')

  thread('legacy-unanswered', '{}')
  message('lu1', 'legacy-unanswered', 1, 'user', null)

  thread('legacy-garbled', 'not json at all')
  message('lg1', 'legacy-garbled', 1, 'user', null)
  message('lg2', 'legacy-garbled', 2, 'assistant', 'test/garbled')

  // Run the migration that pins each thread to its latest reply's model.
  const pinningMigration = MIGRATIONS.find((sql) =>
    sql.includes('Every thread that never had a model picked stored none')
  )
  db.exec(pinningMigration)

  const configOf = (id) => {
    try {
      return JSON.parse(db.prepare('SELECT config FROM threads WHERE id = ?').get(id).config)
    } catch {
      return null
    }
  }
  check(
    'a thread gets the model its latest reply came from',
    configOf('legacy-switched')?.model === 'test/latest',
    configOf('legacy-switched')
  )
  check(
    'not the first one, which is not what the conversation was left on',
    configOf('legacy-switched')?.model !== 'test/older'
  )
  check(
    'an explicit choice is left alone',
    configOf('legacy-explicit')?.model === 'test/chosen',
    configOf('legacy-explicit')
  )
  check(
    'a thread with no answer stays unpinned, to be pinned when it is used',
    configOf('legacy-unanswered')?.model == null,
    configOf('legacy-unanswered')
  )
  check(
    'a config that was not JSON is given one rather than skipped',
    configOf('legacy-garbled')?.model === 'test/garbled',
    configOf('legacy-garbled')
  )

  /*
   * Not the conversation having something said in it — and stamping it would
   * send every old chat to the top of Today at once.
   */
  const stamps = db
    .prepare("SELECT updated_at FROM threads WHERE id LIKE 'legacy-%'")
    .all()
    .map((row) => row.updated_at)
  check('and none of them moves in the list', stamps.every((t) => t === T0), stamps)

  // Running it twice is the same as running it once.
  db.exec(pinningMigration)
  check('a second run changes nothing', configOf('legacy-switched')?.model === 'test/latest')

  global.fetch = originalFetch
})
