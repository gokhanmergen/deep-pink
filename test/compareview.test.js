const { suite, settle, openThread } = require('./support/harness')

/**
 * Side by side, as drawn.
 *
 * `compare.test.js` proves every event lands on the side it belongs to; it
 * cannot say whether there are two columns on screen, whether each has the
 * right conversation in it, or whether there is a way in that anybody would
 * find. So this boots the app, and looks.
 */
suite(
  'side by side — two columns, found from where you already are',
  async ({ check, section, subject, getWindow }) => {
    const { getDb, repo } = subject
    getDb()

    // A pair that has already been had, so reopening it has something to show.
    const [left, right] = repo.createComparePair('anthropic/claude-one', 'openai/gpt-two')
    repo.updateThread(left.id, { title: 'Compared, left side' })
    repo.updateThread(right.id, { title: 'Compared, right side' })
    for (const [thread, answer] of [
      [left, 'The left answer.'],
      [right, 'The right answer.']
    ]) {
      repo.insertMessage({ threadId: thread.id, role: 'user', content: 'The shared question.' })
      repo.insertMessage({
        threadId: thread.id,
        role: 'assistant',
        model: thread.config.model,
        content: answer
      })
    }

    const win = getWindow()
    check('the window exists', Boolean(win))
    if (!win) return
    await settle(6000)
    const run = (js) => win.webContents.executeJavaScript(js)
    /*
     * The key `mod` means where this is running: Cmd on macOS, Ctrl elsewhere.
     * Always sending Ctrl passed on the Linux machine CI runs on and pressed
     * nothing at all on a Mac, which read as the shortcut being broken.
     */
    const modKey = process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'

    const view = () =>
      run(`(() => {
        const panes = [...document.querySelectorAll('.compare__pane')]
        return {
          comparing: Boolean(document.querySelector('.compare')),
          panes: panes.map((pane) => ({
            // The label alone: the mark beside it may be a letter until the
            // icon arrives, and that letter is text too.
            model: pane.querySelector('.compare__head .btn .btn__label')?.textContent?.trim() ?? null,
            unset: pane.querySelector('.compare__head .btn')?.dataset.unset ?? null,
            text: pane.querySelector('.transcript')?.textContent ?? '',
            composers: pane.querySelectorAll('.composer').length,
            width: Math.round(pane.getBoundingClientRect().width)
          })),
          composers: document.querySelectorAll('.composer').length,
          // The id the shortcuts use to find "the" composer. Side by side
          // there is not one, and a stray id would send keys somewhere.
          mainComposer: Boolean(document.getElementById('composer-input')),
          title: document.querySelector('.topbar__title')?.textContent?.trim() ?? null,
          pairRows: document.querySelectorAll('.thread-item[data-active="true"]').length
        }
      })()`)

    const clickByText = (selector, text) =>
      run(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((e) => e.textContent.includes(${JSON.stringify(text)}))
        if (!el) return false
        el.click()
        return true
      })()`)

    section('reopening a pair from one of its sides')
    check('the left side opens', await openThread(win, 'Compared, left side'))
    check(
      'its top bar offers the pair back',
      await run(`(() => {
        const button = document.querySelector('.topbar .btn[aria-label="Side by side"]')
        if (!button) return false
        button.click()
        return true
      })()`),
      'no "Side by side" button in the top bar'
    )
    await settle(800)

    const reopened = await view()
    check('the view is side by side', reopened.comparing, reopened)
    check('with two columns', reopened.panes.length === 2, reopened.panes.length)
    check('the one you were in on the left', reopened.panes[0]?.text.includes('The left answer.'), reopened.panes[0])
    check('its pair on the right', reopened.panes[1]?.text.includes('The right answer.'), reopened.panes[1])
    check(
      'each column only its own',
      !reopened.panes[0]?.text.includes('The right answer.') &&
        !reopened.panes[1]?.text.includes('The left answer.'),
      reopened.panes.map((p) => p.text)
    )
    check(
      'both show the question they share',
      reopened.panes.every((p) => p.text.includes('The shared question.')),
      reopened.panes.map((p) => p.text)
    )
    check(
      'each headed by its model',
      reopened.panes[0]?.model === 'claude-one' && reopened.panes[1]?.model === 'gpt-two',
      reopened.panes.map((p) => p.model)
    )
    check(
      'each with a composer of its own, since they carry on separately',
      reopened.panes.every((p) => p.composers === 1) && reopened.composers === 2,
      reopened
    )
    check('and none of them is "the" composer', !reopened.mainComposer)
    check(
      'the columns share the width evenly',
      Math.abs((reopened.panes[0]?.width ?? 0) - (reopened.panes[1]?.width ?? 0)) <= 2,
      reopened.panes.map((p) => p.width)
    )
    check('both sides are lit in the list', reopened.pairRows === 2, reopened.pairRows)

    section('carrying on with one side')
    check(
      'the right side can be taken on alone',
      await run(`(() => {
        const button = document.querySelectorAll('.compare__pane')[1]
          ?.querySelector('[aria-label="Carry on with just this side"]')
        if (!button) return false
        button.click()
        return true
      })()`)
    )
    await settle(800)
    const alone = await view()
    check('it is one conversation again', !alone.comparing, alone)
    check('the one kept', alone.title === 'Compared, right side', alone.title)
    check('with the ordinary composer back', alone.mainComposer)

    const labels = await run(
      `[...document.querySelectorAll('.topbar .btn')].map((b) => b.getAttribute('aria-label') ?? '')`
    )
    check(
      'its top bar offers it by the one name it has everywhere',
      labels.includes('Side by side') && !labels.some((l) => /compare/i.test(l)),
      labels
    )

    section('a new thread, once side by side has been used')
    check('a new thread can be started', await clickByText('.sidebar__actions .btn', 'New thread'))
    await settle(700)

    const fresh = await view()
    check('it opens side by side, because that is the mode now', fresh.comparing, fresh)
    check('two empty columns', fresh.panes.length === 2 && fresh.panes.every((p) => p.composers === 0), fresh.panes)
    check('and one composer under both, for the question they share', fresh.composers === 1, fresh.composers)
    check('the left already has a model', fresh.panes[0]?.unset === null, fresh.panes[0])
    check('the right asks for one', fresh.panes[1]?.unset === 'true', fresh.panes[1])

    // Neither thread exists yet, and these used to wait for one.
    const shared = await run(`(() => {
      const bar = document.querySelector('.compare > .composer .composer__bar')
      const button = (text) =>
        [...(bar?.querySelectorAll('.btn') ?? [])].find((b) => b.textContent.includes(text))
      return {
        attach: button('Attach') ? !button('Attach').disabled : null,
        // The thinking button is labelled by its level; it is the one with a
        // brain in it, found by what it is for.
        thinking: [...(bar?.querySelectorAll('.btn') ?? [])]
          .filter((b) => b.title === 'How hard to think, for this conversation')
          .map((b) => !b.disabled)[0] ?? null
      }
    })()`)
    check('Attach works before the first message', shared.attach === true, shared)
    check('so does choosing how hard to think', shared.thinking === true, shared)

    check(
      'sending before both are chosen is refused, and says why',
      await run(`(async () => {
        const box = document.querySelector('.compare > .composer textarea')
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(box, 'Which is larger?')
        box.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 100))
        document.querySelector('.compare > .composer .btn--primary').click()
        await new Promise((r) => setTimeout(r, 300))
        return [...document.querySelectorAll('.toaster .toast__message')]
          .some((t) => t.textContent.includes('each side'))
      })()`)
    )
    check(
      'and what was typed is still there to send once they are',
      await run(`document.querySelector('.compare > .composer textarea')?.value === 'Which is larger?'`)
    )
    check(
      'and nothing was made',
      repo.listThreads().filter((t) => t.config.compareWith).length === 2,
      repo.listThreads().map((t) => [t.title, t.config.compareWith])
    )

    section('closing it')
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '\\\\', ${modKey}: true, bubbles: true
    }))`)
    await settle(700)
    const closed = await view()
    check('the shortcut closes it', !closed.comparing, closed)
    check('back to one conversation', closed.mainComposer, closed)

    check('a new thread can be started', await clickByText('.sidebar__actions .btn', 'New thread'))
    await settle(700)
    const single = await view()
    check('and it is a single chat again, since side by side was closed', !single.comparing, single)
  },
  { bootApp: true }
)
