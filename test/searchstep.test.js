const { suite, settle, openThread } = require('./support/harness')

/**
 * Where a search OpenRouter ran is drawn, and when it turns up.
 *
 * The `:online` plugin searches server-side and says what it read while the
 * reply is already streaming, so the row recording it is written after the
 * reply it informed. Two things went wrong with that, and this suite covers
 * both:
 *
 *  - It was drawn last, so the transcript read answer-then-sources. Moving
 *    the whole message to the front of the turn fixed that and broke
 *    something else: the thinking lives *inside* the assistant message, so
 *    anything hoisted ahead of that message lands above the reasoning too.
 *    It now goes inside the turn it belongs to, after the thinking and before
 *    the reply, which is where a real tool round would have been.
 *
 *  - It did not appear at all until the thread was closed and opened again.
 *    The `tool-result` event named a message the renderer had by definition
 *    never seen — the row had just been written — so the relevance check that
 *    decides whether an event is about the conversation on screen said no,
 *    every time. It names its thread now.
 *
 * The app is booted and the DOM measured, because both of these are about
 * what ends up on screen and neither is visible from the data.
 */
suite(
  'search step — where the :online search is drawn, and when',
  async ({ check, section, subject, getWindow }) => {
    const { getDb, repo } = subject
    getDb()

    const thread = repo.createThread('Search ordering')
    repo.insertMessage({ threadId: thread.id, role: 'user', content: 'what happened today' })
    const assistant = repo.insertMessage({
      threadId: thread.id,
      role: 'assistant',
      model: 'test/model:online',
      reasoning: 'Let me work out what to look up first.',
      content: 'Here is the answer, drawn from the pages below.'
    })

    const win = getWindow()
    check('the app opened a window', Boolean(win))
    if (!win) return
    const run = (js) => win.webContents.executeJavaScript(js)
    await settle(6000)

    check('the fixture thread is on screen', await openThread(getWindow(), 'Search ordering'))

    /** What the assistant turn is made of, in the order it is made of it. */
    const SHAPE = `(() => {
      const turn = document.querySelector('.message[data-role=assistant]')
      if (!turn) return null
      const part = turn.querySelector('.turn-part')
      if (!part) return null
      return [...part.children].map((el) => {
        const cls = String(el.getAttribute('class') || '')
        if (el.tagName === 'DETAILS') return /tool-step/.test(cls) ? 'search' : 'reasoning'
        if (el.tagName === 'HR') return 'rule'
        return /message__body/.test(cls) ? 'reply' : el.tagName.toLowerCase()
      })
    })()`

    section('before the plugin says what it read')
    const before = await run(SHAPE)
    check('the turn is the thinking, a rule, and the reply', JSON.stringify(before) === '["reasoning","rule","reply"]', before)

    /*
     * The citations land, exactly as `keepCitations` writes them: a `tool`
     * message whose call id names the assistant message it belongs to, and
     * which no model could have produced.
     */
    section('and then they land, mid-conversation')
    const result = {
      toolCallId: `openrouter-search-${assistant.id}`,
      name: 'web_search',
      content: '1. A page\n   https://a.example/',
      isError: false,
      durationMs: 0
    }
    repo.insertMessage({
      threadId: thread.id,
      role: 'tool',
      content: result.content,
      toolResult: result,
      status: 'complete'
    })
    win.webContents.send('chat:event', {
      type: 'tool-result',
      threadId: thread.id,
      messageId: 'whatever-row-was-just-written',
      result
    })
    await settle(1200)

    const after = await run(SHAPE)
    check(
      'the search appears without the thread being reopened',
      Array.isArray(after) && after.includes('search'),
      after
    )
    check(
      'below the thinking and above the reply',
      JSON.stringify(after) === '["reasoning","search","rule","reply"]',
      after
    )
    check(
      'and it is drawn inside the turn, not before it',
      (await run(`(() => {
        const turn = document.querySelector('.message[data-role=assistant]')
        const step = turn?.querySelector('details.tool-step')
        return Boolean(step && step.closest('.turn-part'))
      })()`)) === true
    )
    check(
      'saying what it was',
      (await run(
        `document.querySelector('details.tool-step summary')?.textContent?.includes('Ran web_search') ?? false`
      )) === true
    )

    /*
     * Zero is "not timed", not "instant". The search happened inside a turn
     * that was already being timed and has no duration of its own to report.
     */
    check(
      'and claiming no duration of its own',
      (await run(
        `document.querySelector('details.tool-step .aside__note') === null`
      )) === true
    )

    section('an event for another thread is still ignored')
    const other = repo.createThread('Somewhere else')
    win.webContents.send('chat:event', {
      type: 'tool-result',
      threadId: other.id,
      messageId: 'x',
      result: { ...result, toolCallId: 'openrouter-search-nobody' }
    })
    await settle(900)
    check(
      'the open conversation is unchanged',
      JSON.stringify(await run(SHAPE)) === '["reasoning","search","rule","reply"]',
      await run(SHAPE)
    )
  },
  { bootApp: true }
)
