const { suite, settle } = require('./support/harness')

/**
 * The image viewer, in the window that runs it.
 *
 * Clicking a picture used to leave the app; this proves it no longer does, that
 * what opens is the picture that was clicked, that it zooms and steps through
 * the conversation, and that every way out of it works — because a viewer you
 * cannot dismiss is worse than no viewer.
 *
 * Deliberately makes no assertion that depends on the image having decoded:
 * a headless machine may never paint it, and the controls have to work anyway.
 */

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

suite(
  'image viewer — looking at a picture without leaving',
  async ({ check, section, subject, getWindow }) => {
    const { getDb, repo, attachments } = subject
    getDb()

    const thread = repo.createThread('Viewer fixture')
    const first = repo.insertMessage({ threadId: thread.id, role: 'user', content: 'two pictures' })
    const one = attachments.store(thread.id, first.id, {
      mime: 'image/png',
      filename: 'first.png',
      data: PNG,
      width: 1,
      height: 1
    })
    repo.insertMessage({ threadId: thread.id, role: 'assistant', content: 'Noted.', model: 'test/model' })
    const second = repo.insertMessage({ threadId: thread.id, role: 'user', content: 'and another' })
    const two = attachments.store(thread.id, second.id, {
      mime: 'image/png',
      filename: 'second.png',
      data: PNG,
      width: 1,
      height: 1
    })

    const win = getWindow()
    check('the window exists', Boolean(win))
    if (!win) return

    await settle(6000)
    const run = (js) => win.webContents.executeJavaScript(js)

    const state = () => run(`(() => {
      const viewer = document.querySelector('.viewer')
      if (!viewer) return { open: false }
      const image = viewer.querySelector('.viewer__image')
      const box = viewer.getBoundingClientRect()
      return {
        open: true,
        src: image.getAttribute('src'),
        transform: image.style.transform,
        percent: viewer.querySelector('.viewer__percent').textContent.trim(),
        name: viewer.querySelector('.viewer__name').textContent.trim(),
        meta: viewer.querySelector('.viewer__meta').textContent.trim(),
        steps: viewer.querySelectorAll('.viewer__step').length,
        coversTheWindow:
          Math.round(box.width) === window.innerWidth && Math.round(box.height) === window.innerHeight,
        role: viewer.getAttribute('role'),
        modal: viewer.getAttribute('aria-modal')
      }
    })()`)

    const clickThumb = (index) =>
      run(`document.querySelectorAll('.attachment')[${index}].click()`)

    const press = (key) =>
      run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`)

    section('clicking a picture opens it here rather than elsewhere')
    const thumbs = await run(`document.querySelectorAll('.attachment').length`)
    check('both pictures are in the transcript', thumbs === 2, thumbs)
    check('and nothing is open yet', (await state()).open === false)

    await clickThumb(0)
    await settle(300)
    const opened = await state()

    check('the viewer opens', opened.open === true, opened)
    check('on the picture that was clicked', opened.src === `dpimg://attachment/${one.id}`, opened.src)
    check('named', opened.name === 'first.png', opened.name)
    check('and it covers the window', opened.coversTheWindow === true, opened)
    check('it announces itself as a dialog', opened.role === 'dialog' && opened.modal === 'true', opened)
    check('it says where it is in the conversation', /1 of 2/.test(opened.meta), opened.meta)
    check('it starts fitted', opened.transform.includes('scale(1)'), opened.transform)

    section('zooming')
    const zoomOutAtFit = await run(
      `document.querySelectorAll('.viewer__btn')[0].disabled`
    )
    check('zooming out is refused when the whole picture is already shown', zoomOutAtFit === true)

    await run(`[...document.querySelectorAll('.viewer__btn')].find((b) => b.title.startsWith('Zoom in')).click()`)
    await settle(200)
    const zoomed = await state()
    const scaleOf = (transform) => Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? 0)

    check('the button zooms in', scaleOf(zoomed.transform) > 1, zoomed.transform)
    check('and the readout follows it', zoomed.percent !== opened.percent, zoomed.percent)

    await press('-')
    await settle(200)
    check('the keyboard zooms back out', scaleOf((await state()).transform) === 1)

    await press('+')
    await press('+')
    await settle(200)
    const twice = scaleOf((await state()).transform)
    check('and in, more than once', twice > 1.9, twice)

    await press('0')
    await settle(200)
    check('zero fits it to the window again', scaleOf((await state()).transform) === 1)

    // The wheel is how anyone actually zooms an image, and it must not scroll
    // the transcript underneath instead.
    await run(`(() => {
      const viewer = document.querySelector('.viewer')
      const box = viewer.getBoundingClientRect()
      viewer.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -240, bubbles: true, cancelable: true,
        clientX: box.width / 2, clientY: box.height / 2
      }))
    })()`)
    await settle(200)
    check('the wheel zooms', scaleOf((await state()).transform) > 1)

    section('stepping through the conversation')
    check('there are arrows, because there is more than one', (await state()).steps === 2)

    await press('ArrowRight')
    await settle(300)
    const next = await state()
    check('the next picture is shown', next.src === `dpimg://attachment/${two.id}`, next.src)
    check('named', next.name === 'second.png', next.name)
    check('and it says so', /2 of 2/.test(next.meta), next.meta)
    check('a new picture starts fitted rather than at the last one’s zoom',
      scaleOf(next.transform) === 1, next.transform)

    await press('ArrowLeft')
    await settle(300)
    check('and back', (await state()).src === `dpimg://attachment/${one.id}`)

    await run(`document.querySelector('.viewer__step--next').click()`)
    await settle(300)
    check('the arrow button steps too', (await state()).src === `dpimg://attachment/${two.id}`)

    await run(`document.querySelector('.viewer__step--next').click()`)
    await settle(300)
    check('and it wraps rather than stopping', (await state()).src === `dpimg://attachment/${one.id}`)

    section('every way out')
    await run(`document.querySelector('.viewer__image').click()`)
    await settle(200)
    check('clicking the picture itself does not close it', (await state()).open === true)

    await run(`document.querySelector('.viewer__stage').click()`)
    await settle(300)
    check('clicking beside it does', (await state()).open === false)

    await clickThumb(1)
    await settle(300)
    check('it opens on whichever was clicked', (await state()).src === `dpimg://attachment/${two.id}`)

    await press('Escape')
    await settle(300)
    check('escape closes it', (await state()).open === false)

    await clickThumb(0)
    await settle(300)
    await run(`[...document.querySelectorAll('.viewer__btn')].find((b) => b.title.startsWith('Close')).click()`)
    await settle(300)
    check('and so does the close button', (await state()).open === false)

    section('the transcript is still where it was')
    const after = await run(`({
      messages: document.querySelectorAll('.message').length,
      thumbs: document.querySelectorAll('.attachment').length
    })`)
    check('the conversation was never navigated away from', after.thumbs === 2, after)
  },
  { bootApp: true }
)
