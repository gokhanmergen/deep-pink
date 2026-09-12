const { suite, settle } = require('./support/harness')

/**
 * A long conversation, read the way a reader reads one.
 *
 * The claim being tested is not "paging works" — the storage suite covers what
 * comes back from the database. It is that the seam does not show: that a
 * thread of hundreds of messages opens without all of them being rendered,
 * that scrolling back brings the rest without the page moving under the
 * pointer, and that the figures which used to be summed from what was on
 * screen still describe the whole thread.
 */
suite(
  'transcript — read in pages, and none of the joins visible',
  async ({ check, section, subject, getWindow }) => {
    const { getDb, repo } = subject
    getDb()

    const TURNS = 120
    const thread = repo.createThread('A long conversation')
    for (let i = 0; i < TURNS; i++) {
      repo.insertMessage({
        threadId: thread.id,
        role: 'user',
        // One word that occurs exactly once, near the start: something a
        // search can find that the transcript will not have read in.
        content:
          `Question ${i}. A line of prose, so the turn has real height.` +
          (i === 3 ? ' Pomegranate.' : '')
      })
      const reply = repo.insertMessage({
        threadId: thread.id,
        role: 'assistant',
        model: 'test/model',
        content:
          `Answer ${i}.\n\nA paragraph long enough to take up vertical space in ` +
          'the transcript, so that scrolling has somewhere to go.\n\n' +
          '```ts\nconst answer = ' + i + '\n```\n'
      })
      repo.recordUsage(thread.id, reply.id, 'test/model', 'test', {
        promptTokens: 100,
        completionTokens: 100,
        reasoningTokens: 0,
        cachedTokens: 0,
        totalTokens: 200,
        costUsd: 0.001,
        latencyMs: 10,
        timeToFirstTokenMs: 1,
        tokensPerSecond: 1,
        generationId: `gen-${i}`
      })
    }
    const total = repo.getMessages(thread.id).length

    const win = getWindow()
    check('the window exists', Boolean(win))
    if (!win) return

    await settle(7000)
    const run = (js) => win.webContents.executeJavaScript(js)

    /**
     * Scrolls, and says so.
     *
     * A window that is not being composited — this one, and any CI machine
     * without a real display — does not run the step of the event loop that
     * dispatches scroll events, so setting `scrollTop` here moves the view and
     * tells nobody. Dispatching it by hand exercises every part of this that
     * belongs to the app: the guard, the anchor, the request, the prepend and
     * the restore. The part it stands in for is the browser's own, which is
     * not what these tests are for.
     */
    const scrollTo = (top) =>
      run(`(() => {
        const el = document.querySelector('.transcript')
        el.scrollTop = ${top}
        el.dispatchEvent(new Event('scroll'))
        return Math.round(el.scrollTop)
      })()`)

    const view = () =>
      run(`(() => {
        const el = document.querySelector('.transcript')
        return {
          rendered: document.querySelectorAll('.transcript .message').length,
          earlier: Boolean(document.querySelector('.transcript__earlier')),
          scrollTop: el ? Math.round(el.scrollTop) : -1,
          scrollHeight: el ? Math.round(el.scrollHeight) : -1,
          clientHeight: el ? Math.round(el.clientHeight) : -1,
          lastText: [...document.querySelectorAll('.transcript .message')].pop()?.textContent ?? '',
          highlighter: document.documentElement.dataset.highlighter ?? null,
          highlighted: document.querySelectorAll('.codeblock .shiki').length
        }
      })()`)

    section('opening a long thread')
    const opened = await view()
    check('every message exists in the database', total === TURNS * 2, total)
    check(
      'but only part of the conversation is rendered',
      opened.rendered > 0 && opened.rendered < total,
      { rendered: opened.rendered, total }
    )
    check('it opens at the end, where the conversation is', opened.lastText.includes('Answer 119'),
      opened.lastText.slice(0, 60))
    check('and says there is more above', opened.earlier === true, opened)
    check('with room to scroll into', opened.scrollHeight > opened.clientHeight, opened)

    section('the figures are the thread’s, not the screen’s')
    // Every one of the 120 turns cost a tenth of a cent and 200 tokens. A
    // header that summed what was loaded would show a fraction of this, and
    // would count upwards as the reader scrolled back.
    const header = await run(`(() => {
      const btn = [...document.querySelectorAll('.topbar .btn')]
        .find((b) => /tok|\\$/.test(b.textContent))
      return btn?.textContent ?? null
    })()`)
    check('the header reports the whole thread’s tokens', (header ?? '').includes('24k'), header)
    check('and the whole thread’s cost', (header ?? '').includes('$0.12'), header)

    section('scrolling back brings the rest, without moving the page')
    // Somewhere well up the transcript, but not so far that the prefetch has
    // already fired: this is the gesture the anchoring exists for.
    // Measured and then asked for, in that order and in one evaluation: a
    // round trip between the two is long enough for the page to have landed,
    // and "before" would already be "after".
    const before = await run(`(() => {
      const el = document.querySelector('.transcript')
      el.scrollTop = 0
      const mark = document.querySelector('.transcript .message')
      const snapshot = {
        rendered: document.querySelectorAll('.transcript .message').length,
        markText: mark.textContent.slice(0, 40),
        markTop: Math.round(mark.getBoundingClientRect().top),
        scrollHeight: Math.round(el.scrollHeight)
      }
      el.dispatchEvent(new Event('scroll'))
      return snapshot
    })()`)

    await settle(1200)

    const after = await run(`(() => {
      const el = document.querySelector('.transcript')
      return {
        rendered: document.querySelectorAll('.transcript .message').length,
        scrollHeight: Math.round(el.scrollHeight),
        scrollTop: Math.round(el.scrollTop)
      }
    })()`)

    check('more of the conversation has been read in', after.rendered > before.rendered, {
      before: before.rendered,
      after: after.rendered
    })
    check('the transcript got taller, as it must have', after.scrollHeight > before.scrollHeight, {
      before: before.scrollHeight,
      after: after.scrollHeight
    })

    // The measurement that matters: the message the reader was looking at is
    // still where it was on screen, even though thousands of pixels were
    // inserted above it.
    const moved = await run(`(() => {
      const mark = [...document.querySelectorAll('.transcript .message')]
        .find((m) => m.textContent.slice(0, 40) === ${JSON.stringify(before.markText)})
      if (!mark) return null
      return Math.round(mark.getBoundingClientRect().top)
    })()`)
    check('the message that was at the top is still there', moved !== null, before.markText)
    check(
      'and has not moved on screen, though a page was inserted above it',
      moved !== null && Math.abs(moved - before.markTop) <= 2,
      { was: before.markTop, now: moved }
    )

    section('and it keeps going, all the way up')
    // A page is sixteen messages and the thread is 240, so fifteen goes would
    // just reach the beginning; this allows well over that, because the point
    // is whether it gets stuck rather than how few passes it takes.
    for (let i = 0; i < 24; i++) {
      await scrollTo(0)
      await settle(700)
    }
    const top = await view()
    check('the whole conversation is now in the transcript', top.rendered === total, {
      rendered: top.rendered,
      total
    })
    check('and there is nothing left above it', top.earlier === false, top)
    check(
      'the first thing said is the first thing in it',
      await run(
        `document.querySelector('.transcript .message').textContent.includes('Question 0')`
      )
    )

    section('a search result reaches a message the transcript has not read in')
    // Everything is loaded by now, and the reader is at the top of it. Back to
    // the end first — a thread reopens where it was left, and left at the end
    // means the end, which is where somebody arriving from a search starts.
    await run(`(() => {
      const el = document.querySelector('.transcript')
      el.scrollTop = el.scrollHeight
      el.dispatchEvent(new Event('scroll'))
      return true
    })()`)
    await settle(400)
    await run(`document.querySelector('.sidebar .thread-item').click()`)
    await settle(900)
    check(
      'reopening reads in the end of the conversation only',
      (await run(`document.querySelectorAll('.transcript .message').length`)) < total
    )
    check(
      'so the message being searched for is nowhere on screen',
      (await run(`!document.body.textContent.includes('Pomegranate.')`)) === true
    )

    // Typed into the sidebar's search the way a person would. React owns the
    // input's value, so the native setter is used and an input event is sent —
    // assigning `.value` alone changes what is on screen and tells React
    // nothing.
    await run(`(() => {
      const input = document.querySelector('.sidebar__search input')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(input, 'Pomegranate')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await settle(900)

    const clicked = await run(`(() => {
      const hit = document.querySelector('.sidebar__list .cmditem')
      if (!hit) return false
      hit.click()
      return true
    })()`)
    check('the search finds it', clicked === true)
    await settle(1200)

    const reached = await run(`(() => {
      const found = [...document.querySelectorAll('.transcript .message')]
        .find((m) => m.textContent.includes('Pomegranate.'))
      return {
        onScreen: Boolean(found),
        highlighted: Boolean(found && found.style.outline),
        rendered: document.querySelectorAll('.transcript .message').length
      }
    })()`)
    check('and opening it reads in as much of the thread as that takes',
      reached.onScreen === true, reached)
    check('the message is picked out, not merely present', reached.highlighted === true, reached)

    section('highlighting, and where it happens')
    check('code blocks are highlighted', top.highlighted > 0, top.highlighted)
    check(
      'and the highlighting runs off the main thread',
      top.highlighter === 'worker',
      top.highlighter
    )
  },
  { bootApp: true }
)
