const { suite, settle } = require('./support/harness')

/**
 * Regression cover for two reported bugs:
 *
 *  - The transcript would not scroll. Flex and grid children default to
 *    `min-height: auto`, so every scroll container grew to fit its content
 *    instead of scrolling inside it.
 *  - Because the layout grew past the viewport and `body` clips its overflow,
 *    the composer was pushed off the bottom of the window and could not be
 *    clicked — which is what "fullscreen breaks the send box" looked like.
 *
 * This suite boots the real built app and measures what it renders.
 */
suite(
  'layout — scrolling and reachable chrome',
  async ({ check, section, subject, getWindow }) => {
    const { getDb, repo } = subject
    getDb()

    // Enough conversation that the transcript must scroll.
    const thread = repo.createThread('Layout fixture')
    for (let i = 0; i < 25; i++) {
      repo.insertMessage({ threadId: thread.id, role: 'user', content: `Question ${i}` })
      repo.insertMessage({
        threadId: thread.id,
        role: 'assistant',
        model: 'test/model',
        content:
          `Answer ${i}.\n\nA paragraph long enough to take real vertical space.\n\n` +
          '```ts\nconst x = 1\n```\n\nInline maths $E = mc^2$.'
      })
    }

    // A user message with an image, so the transcript has one to render.
    const PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
    const withImage = repo.insertMessage({
      threadId: thread.id,
      role: 'user',
      content: 'what is in this image?'
    })
    const storedImage = subject.attachments.store(thread.id, withImage.id, {
      mime: 'image/png',
      filename: 'probe.png',
      data: PNG,
      width: 1,
      height: 1
    })

    const win = getWindow()
    check('the window exists', Boolean(win))
    if (!win) return

    // Give the renderer time to load its thread list and paint the transcript.
    await settle(6000)
    const run = (js) => win.webContents.executeJavaScript(js)

    section('the transcript scrolls')
    const transcript = await run(`(() => {
      const t = document.querySelector('.transcript')
      if (!t) return null
      const wasAt = t.scrollTop
      t.scrollTop = 250
      const moved = t.scrollTop
      t.scrollTop = wasAt
      return {
        clientHeight: t.clientHeight,
        scrollHeight: t.scrollHeight,
        movedTo: moved,
        messages: document.querySelectorAll('.message').length
      }
    })()`)

    check('messages are rendered', transcript && transcript.messages > 10, transcript)
    check(
      'the transcript is bounded by the viewport rather than its content',
      transcript && transcript.clientHeight < transcript.scrollHeight,
      transcript
    )
    check(
      'the transcript actually scrolls',
      transcript && transcript.movedTo === 250,
      transcript
    )

    section('nothing is pushed out of the window')
    const chrome = await run(`(() => {
      // DOMRect keeps its values on the prototype, which does not survive the
      // trip out of the renderer — flatten them here.
      const box = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, height: r.height, width: r.width }
      }
      const rect = (sel) => box(document.querySelector(sel))
      const composer = document.getElementById('composer-input')
      return {
        bodyScrollHeight: document.body.scrollHeight,
        viewportHeight: window.innerHeight,
        composer: box(composer),
        sendButtonVisible: [...document.querySelectorAll('.composer__bar .btn')]
          .some((b) => b.textContent.trim() === 'Send' &&
                       b.getBoundingClientRect().bottom <= window.innerHeight + 1),
        topbarVisible: (rect('.topbar')?.top ?? -1) >= 0
      }
    })()`)

    check(
      'the page does not overflow the viewport',
      chrome.bodyScrollHeight <= chrome.viewportHeight + 4,
      chrome
    )
    check(
      'the composer sits inside the window',
      chrome.composer &&
        chrome.composer.height > 0 &&
        chrome.composer.bottom <= chrome.viewportHeight + 1,
      chrome.composer
    )
    check('the send button is reachable', chrome.sendButtonVisible, chrome)
    check('the top bar is on screen', chrome.topbarVisible, chrome)

    section('hiding the sidebar keeps the app full width')
    const measure = () => run(`(() => {
      const main = document.querySelector('.main')
      const composer = document.getElementById('composer-input')
      return {
        sidebarState: document.querySelector('.app').dataset.sidebar,
        sidebarRendered: !!document.querySelector('.sidebar'),
        mainWidth: main ? Math.round(main.getBoundingClientRect().width) : 0,
        composerWidth: composer ? Math.round(composer.getBoundingClientRect().width) : 0,
        composerCentre: composer
          ? Math.round(composer.getBoundingClientRect().left + composer.getBoundingClientRect().width / 2)
          : 0,
        mainCentre: main
          ? Math.round(main.getBoundingClientRect().left + main.getBoundingClientRect().width / 2)
          : 0,
        viewport: window.innerWidth
      }
    })()`)
    const toggle = () => run(
      `[...document.querySelectorAll('.topbar .btn')].find((b) => b.textContent.trim() === '\u2630').click()`
    )

    const shown = await measure()
    check('the main column leaves room for the sidebar', shown.mainWidth < shown.viewport, shown)

    await toggle()
    await settle(400)
    const hidden = await measure()

    check('the sidebar is gone', hidden.sidebarState === 'hidden' && !hidden.sidebarRendered, hidden)
    check(
      'the main column takes the whole window instead of collapsing',
      hidden.mainWidth >= hidden.viewport - 2,
      hidden
    )
    // The composer is deliberately capped for line length, so it recentres
    // rather than growing — what matters is that it stays centred and readable.
    check(
      'the composer keeps its readable width',
      hidden.composerWidth === shown.composerWidth && hidden.composerWidth > 400,
      { hidden: hidden.composerWidth, shown: shown.composerWidth }
    )
    check(
      'and recentres in the wider column',
      Math.abs(hidden.composerCentre - hidden.mainCentre) <= 2 &&
        hidden.composerCentre < shown.composerCentre,
      { hidden, shown: shown.composerCentre }
    )

    await toggle()
    await settle(400)
    const restored = await measure()
    check(
      'toggling back restores the sidebar and the original width',
      restored.sidebarRendered && Math.abs(restored.mainWidth - shown.mainWidth) <= 2,
      restored
    )

    section('image attachments render and load')
    // The app only ever renders these as <img>, never fetches them, and the CSP
    // deliberately allows dpimg: for images only — so decoding the element is
    // both the real path and the strongest available assertion.
    const images = await run(`(async () => {
      const el = document.querySelector('.attachment img')
      if (!el) return { rendered: 0 }
      try { await el.decode() } catch (e) { return { rendered: 1, decodeError: String(e) } }
      return {
        rendered: document.querySelectorAll('.attachment img').length,
        src: el.src,
        complete: el.complete,
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight
      }
    })()`)

    check('the attachment is rendered in the transcript', images.rendered === 1, images)
    check(
      'it is addressed over the dpimg protocol',
      String(images.src || '').startsWith('dpimg://attachment/'),
      images.src
    )
    check(
      'the protocol served bytes the browser could decode',
      images.complete === true && images.naturalWidth === 1 && images.naturalHeight === 1,
      images
    )
    check(
      'the rendered image is the one that was stored',
      String(images.src || '').endsWith(storedImage.id),
      { src: images.src, id: storedImage.id }
    )

    section('attaching, and where notifications land')
    // A long paste becomes a chip rather than filling the box, and says so by
    // appearing — not by a toast sitting on top of the Send button.
    await run(`(() => {
      const el = document.getElementById('composer-input')
      const dt = new DataTransfer()
      dt.setData('text/plain', 'x'.repeat(6000))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })()`)
    await settle(700)

    const afterPaste = await run(`({
      chips: document.querySelectorAll('.textchip').length,
      toasts: document.querySelectorAll('.toast[data-tone]').length,
      composerHeight: Math.round(document.querySelector('.composer').getBoundingClientRect().height),
      published: getComputedStyle(document.documentElement).getPropertyValue('--composer-height').trim()
    })`)

    check('a long paste becomes one attachment chip', afterPaste.chips === 1, afterPaste)
    check('and raises no toast, because the chip already says it', afterPaste.toasts === 0, afterPaste)
    check(
      'the composer publishes its height for overlays to avoid',
      afterPaste.published === `${afterPaste.composerHeight}px`,
      afterPaste
    )

    // Something that genuinely must be reported: an oversized file.
    await run(`(() => {
      const el = document.getElementById('composer-input')
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(3 * 1024 * 1024)], 'huge.txt', { type: 'text/plain' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })()`)
    await settle(800)

    const toast = await run(`(() => {
      const el = document.querySelector('.toast[data-tone]')
      if (!el) return { shown: false }
      const t = el.getBoundingClientRect()
      const c = document.querySelector('.composer').getBoundingClientRect()
      const overlapping = [...document.querySelectorAll('.composer__bar .btn')]
        .filter((b) => {
          const r = b.getBoundingClientRect()
          return !(t.right < r.left || t.left > r.right || t.bottom < r.top || t.top > r.bottom)
        })
        .map((b) => b.textContent.trim())
      return {
        shown: true,
        text: el.textContent.trim(),
        clearsComposer: t.bottom <= c.top,
        overlapping
      }
    })()`)

    check('a rejected attachment is reported', toast.shown && /3\.0 MB/.test(toast.text), toast)
    check('the toast sits clear of the composer', toast.clearsComposer === true, toast)
    check('and covers none of its buttons', (toast.overlapping ?? []).length === 0, toast)

    section('drag regions are confined to the macOS title bar')
    const drag = await run(`document.documentElement.dataset.windowDrag`)
    check(
      process.platform === 'darwin'
        ? 'dragging is enabled on macOS in windowed mode'
        : 'dragging is disabled off macOS, where it breaks Wayland hit-testing',
      process.platform === 'darwin' ? drag === 'on' : drag === 'off',
      drag
    )

    section('rich content renders')
    const rich = await run(`({
      codeBlocks: document.querySelectorAll('.codeblock').length,
      katex: document.querySelectorAll('.katex').length
    })`)
    check('code blocks are highlighted', rich.codeBlocks > 5, rich)
    check('LaTeX is typeset', rich.katex > 5, rich)

    section('editing a prompt keeps the caret where it was')
    await run(`[...document.querySelectorAll('.sidebar__footer .btn')]
      .find((b) => b.textContent.trim() === 'Settings').click()`)
    await settle(500)
    await run(`[...document.querySelectorAll('.tab')]
      .find((t) => t.textContent.trim() === 'Prompts').click()`)
    await settle(500)

    const caret = await run(`(async () => {
      const el = document.querySelector('.panel__body textarea')
      if (!el) return { error: 'no textarea' }
      const original = el.value
      el.focus()

      // Type one character in the middle, the way a person editing a long
      // prompt would, then wait past the debounce and the IPC write.
      const at = 10
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, original.slice(0, at) + 'X' + original.slice(at))
      el.setSelectionRange(at + 1, at + 1)
      el.dispatchEvent(new Event('input', { bubbles: true }))

      await new Promise((r) => setTimeout(r, 1400))
      return { expected: at + 1, caret: el.selectionStart, insertedInPlace: el.value[at] === 'X' }
    })()`)

    check('the caret does not jump to the end', caret.caret === caret.expected, caret)
    check('the character lands where it was typed', caret.insertedInPlace === true, caret)
  },
  { bootApp: true }
)
