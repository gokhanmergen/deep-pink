const { suite, settle } = require('./support/harness')

/**
 * A thread waiting for a name, and the moment it stops waiting.
 *
 * An untitled thread that has been spoken in shows a shimmer where its name
 * will go. Naming can fail — no key, a model that is gone, a request that timed
 * out — so the promise expires: after a couple of minutes the row settles and
 * says it has no name, because a shimmer that never resolves is a worse lie
 * than the words it replaced.
 *
 * That expiry is a comparison against the clock, made while the list is being
 * drawn, and for a long time nothing told the list when the answer would
 * change. So the row went on shimmering after its window closed, until
 * something unrelated happened to re-render the sidebar — measured at forty
 * seconds past, on an app doing nothing else, and on a quiet one it could be
 * much longer. A promise that expires has to have something waiting for it to
 * expire.
 *
 * Seeded almost expired rather than waited out in real time: what is being
 * tested is that the deadline is noticed at all, and two minutes of test is
 * two minutes nobody will run.
 */
suite(
  'naming — a shimmer that has to stop',
  async ({ check, section, subject, getWindow }) => {
    const { getDb, repo } = subject
    const db = getDb()

    const waiting = repo.createThread('')
    repo.insertMessage({ threadId: waiting.id, role: 'user', content: 'a question' })
    repo.insertMessage({
      threadId: waiting.id,
      role: 'assistant',
      content: 'an answer',
      model: 'test/model'
    })
    /*
     * Ten seconds of the naming window left, counted from here.
     *
     * The app takes several of them to boot, so the first look below lands
     * while the window is still open and the second lands after it has closed.
     * Two minutes of real waiting is two minutes nobody will run.
     */
    db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(
      Date.now() - (2 * 60 * 1000 - 10_000),
      waiting.id
    )

    const win = getWindow()
    check('the window exists', Boolean(win))
    if (!win) return

    await settle(6000)
    const run = (js) => win.webContents.executeJavaScript(js)

    const shimmering = () =>
      run(`document.querySelectorAll('.thread-item__pending').length`)
    const rowText = () =>
      run(`[...document.querySelectorAll('.thread-item__title')].map((e) => e.textContent.trim())`)

    section('while the name could still arrive')
    check('the row shimmers rather than naming itself', (await shimmering()) === 1)

    section('once the window has closed')
    // Nothing is clicked, scrolled or typed in here on purpose: the bug was
    // that only an unrelated re-render ever ended the shimmer, so anything
    // that causes one would hide it.
    await settle(9000)
    check('the shimmer stops on its own', (await shimmering()) === 0, await shimmering())
    check(
      'and the row says it has no name',
      (await rowText()).some((t) => /untitled/i.test(t)),
      await rowText()
    )
  },
  { bootApp: true }
)
