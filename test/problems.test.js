const { suite, settle } = require('./support/harness')

/**
 * Everything that fails says so in the window.
 *
 * The app was good at reporting the failures somebody was waiting on, because
 * each of those had a `catch` beside the button that caused it. Everything
 * else went to the console — a background sweep that threw, a picture that
 * could not be stored, a promise nobody awaited, a render that crashed — and
 * nobody running the built app has a console open. From the window's point of
 * view those failures had not happened: the thing you asked for quietly did
 * not occur and nothing said so.
 *
 * Three sources now reach the same toaster, and this measures all three
 * through the real store and the real component rather than by calling the
 * helper directly: the DOM is the claim.
 */
suite(
  'problems — failures reach the window, not just the log',
  async ({ check, section, getWindow }) => {
    const win = getWindow()
    check('the app opened a window', Boolean(win))
    if (!win) return
    const run = (js) => win.webContents.executeJavaScript(js)
    await settle(6000)

    /** What the stack is saying, newest last. */
    const TOASTS = `[...document.querySelectorAll('.toaster .toast')].map((t) => ({
      tone: t.getAttribute('data-tone'),
      text: t.querySelector('.toast__message')?.textContent ?? '',
      count: t.querySelector('.toast__count')?.textContent ?? null
    }))`
    const says = async (text) =>
      (await run(`(${TOASTS}).some((t) => t.text === ${JSON.stringify(text)} && t.tone === 'error')`)) === true

    /*
     * The one that matters most, because it is how the renderer asks for
     * nearly everything: `void api.x()`, fired and not awaited. A rejection
     * from one of those had nowhere to go.
     */
    section('a promise nobody awaited')
    await run(`Promise.reject(new Error('a rejection nobody awaited')), true`)
    await settle(600)
    check('is said out loud', await says('a rejection nobody awaited'), await run(TOASTS))

    section('a throw that escaped its handler')
    await run(`setTimeout(() => { throw new Error('a throw nobody caught') }, 0), true`)
    await settle(700)
    check('is said too', await says('a throw nobody caught'), await run(TOASTS))

    /*
     * What the main process puts on the wire when something fails out of
     * reach of the window — an image that would not store, a naming sweep
     * that threw. See `reportProblem`.
     */
    section('and a failure in the main process')
    win.webContents.send('app:problem', 'Could not keep a generated image: unsupported format')
    await settle(600)
    check(
      'arrives in the same place',
      await says('Could not keep a generated image: unsupported format'),
      await run(TOASTS)
    )

    /*
     * Electron wraps a rejected `ipcMain.handle` as `Error invoking remote
     * method 'import:run': Error: <the real thing>` — the first half names an
     * internal channel and the second says "Error" twice. What is true and
     * worth reading is the end of it.
     */
    section('an invoke that rejects, unwrapped')
    await run(`void window.deepPink.import.run('/nowhere/at/all.json'), true`)
    await settle(1500)
    const wrapped = await run(TOASTS)
    check(
      'says what went wrong',
      wrapped.some((t) => t.text.includes('no such file or directory')),
      wrapped
    )
    check(
      'and not which channel it happened on',
      wrapped.every((t) => !t.text.includes('invoking remote method')),
      wrapped
    )

    section('the same failure repeating')
    await run(`Promise.reject(new Error('said twice')), true`)
    await settle(400)
    await run(`Promise.reject(new Error('said twice')), true`)
    await settle(700)
    const repeated = await run(TOASTS)
    check(
      'is one line with a count, not two lines',
      repeated.filter((t) => t.text === 'said twice').length === 1 &&
        repeated.find((t) => t.text === 'said twice')?.count === '2',
      repeated
    )

    /*
     * Chromium saying a layout pass ran twice, which happens in any app that
     * resizes something in response to a resize — here, the composer growing
     * with what is typed into it. Nothing is broken and nobody can act on it.
     */
    section('and noise that is not a failure')
    const before = await run(`(${TOASTS}).length`)
    await run(
      `window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' })), true`
    )
    await settle(600)
    check('is not said at all', (await run(`(${TOASTS}).length`)) === before, {
      before,
      after: await run(`(${TOASTS}).length`)
    })
  },
  { bootApp: true }
)
