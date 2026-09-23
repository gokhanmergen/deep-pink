const { suite, settle, openThread } = require('./support/harness')

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

    /*
     * The workshop out, because most of what this suite measures is in it.
     *
     * Attaching a repository, the MCP button, the update line and the
     * experimental marks themselves are all behind `hideExperimental`, which
     * defaults to on — so with nothing said, this suite measured the geometry
     * of four things that were not on screen. Seeded before the renderer asks
     * for its settings, the way the chart suite does.
     */
    repo.setSetting('settings', { hideExperimental: false })

    /*
     * And no real update check, because this suite injects its own.
     *
     * Not what broke it — that was two sections sharing a version number, and
     * is fixed below — but a check reaching GitHub mid-suite would replace an
     * injected status with the truth, and which of the two the window happens
     * to be showing when a measurement is taken is not something to leave to
     * a runner's resolver.
     */
    repo.setSetting('updates', { check: false, autoInstall: false })

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

    /*
     * A reply with a mark on it, for the highlighter's geometry.
     *
     * Its own thread rather than a message in the fixture above, because what
     * is being measured is where the panel sits relative to the column and a
     * transcript that is scrolling is a transcript where that moves.
     */
    const EDGE =
      'A sentence long enough that it certainly wraps across the whole width of ' +
      'the column and so has a line reaching the left edge and a line reaching ' +
      'the right edge, which is the case this is here for.'
    const inked = repo.createThread('Ink fixture')
    repo.insertMessage({ threadId: inked.id, role: 'user', content: 'ask' })
    const marked = repo.insertMessage({
      threadId: inked.id,
      role: 'assistant',
      model: 'test/model',
      content: `${EDGE}\n\nA short closing line.`
    })
    repo.setKeyPoints(marked.id, [EDGE])

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

    // Starting the app opens a blank chat, not the top of the list, so the
    // fixture has to be asked for.
    check(
      "the fixture thread opens",
      await openThread(getWindow(), "Layout fixture"),
      "no row named Layout fixture"
    )
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
    // Found by its label rather than by the character it used to draw: the
    // button wears an icon now, and matching on a glyph made the whole suite
    // throw `Script failed to execute` the moment that changed. Returning
    // whether it was there turns the same breakage into a named failure.
    const toggle = () => run(`(() => {
      const button = document.querySelector('.topbar .btn[aria-label="Toggle sidebar"]')
      button?.click()
      return Boolean(button)
    })()`)

    const shown = await measure()
    check('the main column leaves room for the sidebar', shown.mainWidth < shown.viewport, shown)

    check('the sidebar toggle is in the top bar', await toggle())
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
    /*
     * How many, is not the question any more.
     *
     * The transcript builds a message's contents when it comes near the
     * window, so the number of code blocks on screen is a fact about the
     * window's height rather than about the conversation — it used to be a
     * page's worth because a page's worth was always built. What is worth
     * asserting is what the name always claimed: that the blocks which are
     * there have been highlighted, and that the maths has been typeset.
     */
    const rich = await run(`({
      codeBlocks: document.querySelectorAll('.codeblock').length,
      highlighted: document.querySelectorAll('.codeblock .shiki').length,
      katex: document.querySelectorAll('.katex').length
    })`)
    check('code blocks are highlighted', rich.codeBlocks > 0 && rich.highlighted > 0, rich)
    check('LaTeX is typeset', rich.katex > 0, rich)

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

    // Runs last: it creates and deletes threads, which changes what the
    // transcript shows.
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await settle(400)

    section('attaching a repository says what it is and is not')
    /*
     * Two words doing different jobs, at the only moment there is to say
     * them. "read-only" is the promise — this cannot write to your code —
     * and "experimental" is the caveat, which the rest of the unsettled
     * features carry too.
     *
     * Said rather than marked with the dot the sidebar uses for MCP, because
     * a dot needs somewhere to explain itself and a repository has no panel
     * of its own: it is attached from this menu and lives on the thread.
     */
    await run(`[...document.querySelectorAll('button')].find((b) => /Attach/.test(b.textContent))?.click()`)
    await settle(500)
    const attachMenu = await run(`(() => {
      const item = [...document.querySelectorAll('.context-menu__item')]
        .find((e) => /Code repository/.test(e.textContent ?? ''))
      const menu = document.querySelector('.context-menu')
      return {
        found: !!item,
        hint: item?.querySelector('.context-menu__hint')?.textContent?.trim() ?? null,
        // One line, not wrapped: the hint grew and the menu has to still fit it.
        oneLine: item ? item.getBoundingClientRect().height < 40 : false,
        insideMenu: item && menu
          ? item.getBoundingClientRect().width <= menu.getBoundingClientRect().width
          : false
      }
    })()`)
    check('the repository entry is there', attachMenu.found, attachMenu)
    check('it still promises read-only', /read-only/.test(attachMenu.hint ?? ''), attachMenu.hint)
    check('and admits to being experimental', /experimental/i.test(attachMenu.hint ?? ''), attachMenu.hint)
    check('without wrapping the row', attachMenu.oneLine && attachMenu.insideMenu, attachMenu)

    await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
    await settle(300)

    section('an attached repository is read on a worker')
    const repoFixture = require('node:fs').mkdtempSync(
      require('node:path').join(require('node:os').tmpdir(), 'dp-attach-')
    )
    require('node:fs').writeFileSync(
      require('node:path').join(repoFixture, 'ATTACHED.md'), '# marker\n'
    )
    const repoThread = repo.createThread('Has a repo')
    repo.insertMessage({ threadId: repoThread.id, role: 'user', content: 'hi' })
    repo.updateThread(repoThread.id, { config: { repoPaths: [repoFixture] } })

    // The composer asks for status when a repo is attached, which is what warms
    // the layout — exercising the worker exactly as the app does.
    const status = await run(
      `window.deepPink.repo.status([${JSON.stringify(repoFixture)}])`
    )
    check('the directory reports as available', status[0]?.available === true, status)
    check('and is named by its folder', typeof status[0]?.name === 'string' && status[0].name.length > 0)

    await settle(1500)
    const preview = await run(`window.deepPink.prompt.preview(${JSON.stringify(repoThread.id)})`)
    const repoSegment = preview?.segments?.find((s) => s.source === 'repo')

    check('the prompt gains a repository segment', Boolean(repoSegment), preview?.segments?.map((s) => s.id))
    check('it states the access is read-only', /read-only/.test(repoSegment?.text ?? ''), repoSegment?.text?.slice(0, 80))
    check(
      'and carries the layout the worker read',
      (repoSegment?.text ?? '').includes('ATTACHED.md'),
      repoSegment?.text?.slice(0, 200)
    )
    check(
      'the repository tools are offered',
      (preview?.toolCount ?? 0) >= 4,
      preview?.toolCount
    )

    require('node:fs').rmSync(repoFixture, { recursive: true, force: true })

    section('changing the default model')
    const modelBefore = await run(`window.deepPink.settings.get().then((s) => s.defaultModel)`)
    const threadModelBefore = repo.getThread(thread.id).config.model

    await run(`[...document.querySelectorAll('.sidebar__footer .btn')]
      .find((b) => b.textContent.trim() === 'Settings').click()`)
    await settle(500)
    await run(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.trim() === 'Models').click()`)
    await settle(500)

    // The first button under "Default model" opens the picker.
    await run(`(() => {
      const heading = [...document.querySelectorAll('.section-title')]
        .find((e) => e.textContent.trim() === 'Default model')
      heading.nextElementSibling.querySelector('.btn').click()
    })()`)
    await settle(700)

    const picker = await run(`({
      open: !!document.querySelector('.panel__search'),
      placeholder: document.querySelector('.panel__search')?.placeholder,
      options: document.querySelectorAll('.cmdlist .cmditem').length
    })`)
    check('the picker opens', picker.open === true, picker)
    check('and says it is for new threads', /new threads/.test(picker.placeholder ?? ''), picker.placeholder)

    /*
     * Every match is reachable, not just the screenful built for the first
     * frame.
     *
     * Opening this cost almost exactly what it cost to build its rows —
     * measured at 106ms for three hundred against 20ms for fifty — so the
     * first frame now carries a screenful and the rest follow a tick later.
     * The risk that buys is a list that never finishes arriving, and a model
     * you cannot scroll to is a model you cannot pick.
     */
    const settled = await run(`(async () => {
      await new Promise((r) => setTimeout(r, 400))
      const rows = [...document.querySelectorAll('.cmdlist .cmditem')]
      const counter = [...document.querySelectorAll('.panel span')]
        .map((e) => e.textContent ?? '')
        .find((t) => / models$/.test(t.trim()))
      return { rows: rows.length, counter: counter?.trim() ?? null }
    })()`)
    check(
      'and every model it counts is a row you can reach',
      settled.rows > 0 && settled.counter === `${settled.rows} models`,
      settled
    )
    // The reason for building in two passes at all: more rows than a screen.
    check('which is more than the first frame builds', settled.rows > 60, settled.rows)

    if (picker.options > 0) {
      const chosen = await run(`(() => {
        const item = [...document.querySelectorAll('.cmdlist .cmditem')]
          .find((el) => el.querySelector('.cmditem__sub')?.textContent?.trim() !== ${JSON.stringify(modelBefore)})
        const id = item?.querySelector('.cmditem__sub')?.textContent?.trim()
        item?.click()
        return id
      })()`)
      await settle(900)

      const after = await run(`window.deepPink.settings.get().then((s) => s.defaultModel)`)
      check('picking a model changes the default', after === chosen && after !== modelBefore,
        { before: modelBefore, chosen, after })
      check(
        'and leaves the open thread on its own model',
        repo.getThread(thread.id).config.model === threadModelBefore,
        { was: threadModelBefore, now: repo.getThread(thread.id).config.model }
      )
      check(
        'closing returns to Settings rather than the transcript',
        await run(`!!document.querySelector('.tabs')`)
      )
    } else {
      check('model catalogue unavailable offline — picker behaviour not exercised', true)
    }

    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await settle(300)
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await settle(300)

    section('right-clicking a thread')
    const extra = repo.createThread('Context menu fixture')
    repo.insertMessage({ threadId: extra.id, role: 'user', content: 'x' })
    // The store loaded its thread list at startup and does not poll, so nudge it
    // with an action that refreshes — which picks up the row written above too.
    await run(`[...document.querySelectorAll('.sidebar__actions .btn')]
      .find((b) => b.textContent.includes('New thread')).click()`)
    await settle(1200)

    const rightClick = (title) => run(`(() => {
      const el = [...document.querySelectorAll('.thread-item')]
        .find((t) => t.textContent.includes(${JSON.stringify(title)}))
      if (!el) return false
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 10)
      }))
      return true
    })()`)

    const menu = () => run(`(() => {
      const m = document.querySelector('.context-menu')
      if (!m) return { open: false }
      const r = m.getBoundingClientRect()
      return {
        open: true,
        items: [...m.querySelectorAll('.context-menu__label')].map((e) => e.textContent.trim()),
        onScreen:
          r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight
      }
    })()`)

    const opened = await rightClick('Context menu fixture')
    await settle(300)
    const menuShown = await menu()

    check('right-clicking opens a menu', opened && menuShown.open, menuShown)
    check(
      'offering everything that acts on one thread, in order',
      JSON.stringify(menuShown.items) ===
        '["Rename","Pin","Regenerate name","Archive","Export as Markdown","Export as an archive","Delete"]',
      menuShown.items
    )
    check('positioned on screen', menuShown.onScreen === true, menuShown)

    // It must act on the thread under the cursor, not whichever is open.
    const activeBefore = await run(`document.querySelector('.topbar__title')?.textContent?.trim()`)
    await run(
      `[...document.querySelectorAll('.context-menu__item')].find((b) => b.textContent.includes('Pin')).click()`
    )
    await settle(900)

    const afterPin = await run(`({
      firstThread: document.querySelector('.thread-item__title')?.textContent?.trim(),
      hasPinnedGroup: [...document.querySelectorAll('.sidebar__group-label')]
        .some((e) => e.textContent.trim() === 'Pinned'),
      active: document.querySelector('.topbar__title')?.textContent?.trim(),
      menuClosed: !document.querySelector('.context-menu')
    })`)

    check('pinning moves it to the top', afterPin.firstThread === 'Context menu fixture', afterPin)
    check('under a pinned heading', afterPin.hasPinnedGroup === true, afterPin)
    check('the open thread is not switched', afterPin.active === activeBefore, afterPin)
    check('and the menu closes', afterPin.menuClosed === true, afterPin)

    await rightClick('Context menu fixture')
    await settle(300)
    // In the slot Pin occupied, which is the second: Rename is above it.
    check('reopening offers to unpin', (await menu()).items[1] === 'Unpin', await menu())

    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await settle(300)
    check('escape dismisses it', (await menu()).open === false)

    section('deleting asks in-app, not with a native dialog')
    const threadsBefore = repo.listThreads().length

    const openDeleteDialog = async () => {
      await rightClick('Context menu fixture')
      await settle(300)
      await run(
        `[...document.querySelectorAll('.context-menu__item')].find((b) => b.textContent.includes('Delete')).click()`
      )
      await settle(400)
      return run(`(() => {
        const d = document.querySelector('.dialog')
        if (!d) return { open: false }
        return {
          open: true,
          title: d.querySelector('.dialog__title')?.textContent?.trim(),
          body: d.querySelector('.dialog__text')?.textContent?.trim(),
          buttons: [...d.querySelectorAll('.dialog__actions .btn')].map((b) => b.textContent.trim()),
          focused: document.activeElement?.textContent?.trim()
        }
      })()`)
    }

    const dialog = await openDeleteDialog()
    check('an in-app dialog appears', dialog.open === true, dialog)
    check('it names the thread', /Context menu fixture/.test(dialog.title ?? ''), dialog.title)
    check('it warns the messages go too', /cannot be undone/.test(dialog.body ?? ''), dialog.body)
    check('it offers cancel and delete', JSON.stringify(dialog.buttons) === '["Cancel","Delete"]', dialog.buttons)
    check('the confirming button takes focus', dialog.focused === 'Delete', dialog.focused)

    // Escape must back out without deleting.
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await settle(400)
    check('escape dismisses it', await run(`!document.querySelector('.dialog')`))
    check('and nothing was deleted', repo.listThreads().length === threadsBefore, repo.listThreads().length)

    // Cancel must back out too.
    await openDeleteDialog()
    await run(`[...document.querySelectorAll('.dialog__actions .btn')].find((b) => b.textContent.trim() === 'Cancel').click()`)
    await settle(500)
    check('cancelling keeps the thread', repo.listThreads().length === threadsBefore, repo.listThreads().length)

    // Confirming deletes it.
    await openDeleteDialog()
    await run(`[...document.querySelectorAll('.dialog__actions .btn')].find((b) => b.textContent.trim() === 'Delete').click()`)
    await settle(900)

    check('confirming removes it', repo.listThreads().length === threadsBefore - 1, repo.listThreads().length)
    check('its messages go too', repo.getMessages(extra.id, true).length === 0)
    check('the dialog closes', await run(`!document.querySelector('.dialog')`))

    section('the highlighter keeps its padding at the edge of the column')
    /*
     * The same room on every line, including the ones with no room to spare.
     *
     * The panel reaches a few pixels past the words it holds. `content-
     * visibility` on a message brings paint containment with it, which clips
     * every descendant at the message's own edge — and the body was flush
     * against that edge, measured at exactly zero either side. So the panel
     * was clamped to the text wherever a line reached the edge of the column,
     * which is every line's left edge and the right edge of any line that
     * fills. Padded in the middle and tight at the ends, one mark read as
     * two.
     *
     * Measured against the text rather than against a number, because what
     * has to hold is that the line reaching the edge is treated like any
     * other, not that the gap is four pixels.
     */
    await run(`[...document.querySelectorAll('.thread-item')]
      .find((e) => e.textContent.includes('Ink fixture')).click()`)
    await settle(1200)

    const ink = await run(`(() => {
      const msg = document.querySelector('.message[data-role="assistant"]')
      const body = msg.querySelector('.message__body')
      const base = body.getBoundingClientRect()
      const strokes = [...msg.querySelectorAll('.ink__stroke')].map((s) => {
        const r = s.getBoundingClientRect()
        return { left: +(r.left - base.left).toFixed(1), right: +(base.right - r.right).toFixed(1) }
      })
      // Where the words themselves sit, for the strokes to be compared to.
      const range = document.createRange()
      range.selectNodeContents(msg.querySelector('p'))
      const lines = [...range.getClientRects()]
        .filter((r) => r.width > 1)
        .map((r) => ({ left: +(r.left - base.left).toFixed(1), right: +(base.right - r.right).toFixed(1) }))
      return { strokes, lines, clipped: getComputedStyle(msg).contentVisibility }
    })()`)

    check('the sentence is marked at all', ink.strokes.length >= 2, ink)
    check('and it wrapped, so there is an edge to reach', ink.lines.length >= 2, ink.lines)
    // The whole of the bug: every one of these was 0 before, while the
    // strokes on lines that stopped short kept their padding.
    check(
      'every stroke reaches past the text on its left',
      ink.strokes.every((s) => s.left < 0),
      ink.strokes
    )
    check(
      'and past it on its right',
      ink.strokes.every((s, i) => s.right < (ink.lines[i]?.right ?? Infinity)),
      { strokes: ink.strokes, lines: ink.lines }
    )
    check(
      'by the same amount on the line that fills the column as on the one that does not',
      new Set(ink.strokes.map((s) => s.left)).size === 1,
      ink.strokes
    )
    check(
      'and the message is still the thing being clipped, so this is the real case',
      ink.clipped === 'auto',
      ink.clipped
    )

    section('toasts stack, count themselves, and can be sent away')
    /*
     * The store announces one at a time, and it used to be drawn that way:
     * the next confirmation replaced the last one mid-sentence, nothing said
     * twice was ever counted, and the only way to be rid of an error you had
     * read was to wait out its timer.
     *
     * The copy button on the update line is the cheapest way to raise a real
     * one, so that is what these press.
     *
     * A release of its own, and not the one the next section injects.
     * Dismissal is remembered against the version — saying "not this one" is
     * the whole point of the button — so borrowing the line here and waving
     * it away afterwards taught the window to ignore 9.9.9 for the rest of
     * the suite, and the section below measured a line that could never
     * appear.
     */
    win.webContents.send('updates:changed', {
      currentVersion: '0.0.1',
      latestVersion: '9.9.8',
      releaseUrl: 'https://example.invalid/releases',
      checkedAt: Date.now(),
      installKind: 'pacman',
      canSelfInstall: false,
      readyToInstall: false,
      error: null
    })
    await settle(500)

    await run(`document.querySelector('.updateline__cmd')?.click()`)
    await settle(120)
    await run(`document.querySelector('.updateline__cmd')?.click()`)
    await settle(300)

    const stack = await run(`(() => {
      const box = document.querySelector('.toaster')
      if (!box) return { shown: false }
      const toasts = [...box.querySelectorAll('.toast')]
      return {
        shown: true,
        rows: toasts.length,
        count: toasts[0]?.querySelector('.toast__count')?.textContent ?? null,
        closes: toasts.filter((t) => t.querySelector('.toast__close')).length
      }
    })()`)

    // Said twice, drawn once, with the number — rather than two copies of the
    // same sentence, or the second quietly replacing the first.
    check('the same message twice is one row', stack.shown && stack.rows === 1, stack)
    check('carrying the count', stack.count === '2', stack)
    check('and a way to dismiss it', stack.closes === 1, stack)

    await run(`document.querySelector('.toaster .toast__close')?.click()`)
    await settle(300)
    check(
      'which empties the stack',
      (await run(`document.querySelectorAll('.toaster .toast').length`)) === 0
    )

    /*
     * The standing "no API key" notice is not a toast and must not be drawn
     * as one. It shared the class until the toast became a stack, at which
     * point it lost the positioning it was borrowing and fell into the page.
     */
    const notice = await run(`(() => {
      const n = document.querySelector('.notice')
      if (!n) return null
      const r = n.getBoundingClientRect()
      return { top: Math.round(r.top), fromRight: Math.round(window.innerWidth - r.right) }
    })()`)
    if (notice) {
      check('the standing notice keeps its own corner', notice.top < 40 && notice.fromRight < 40, notice)
    }

    await run(`document.querySelector('.updateline__close')?.click()`)
    await settle(300)
    check(
      'and waving one release away leaves the line gone',
      await run(`!document.querySelector('.updateline')`)
    )

    section('the update line takes its height out of the app, not the window')
    /*
     * `#root` held one child at `height: 100%`. The update line is a second,
     * and two of those come to more than the viewport — which `body` clips,
     * so the composer goes off the bottom and cannot be clicked. That is the
     * bug the top of this file describes, reachable again by adding a
     * sibling, which is why it is checked here rather than trusted.
     *
     * The status is pushed through the same channel the main process uses, so
     * what is measured is the real banner rather than a stand-in.
     */
    const beforeBanner = await run(`(() => {
      const c = document.getElementById('composer-input')
      const t = document.querySelector('.transcript')
      return {
        composerBottom: c ? Math.round(c.getBoundingClientRect().bottom) : null,
        transcriptHeight: t ? Math.round(t.getBoundingClientRect().height) : null
      }
    })()`)

    win.webContents.send('updates:changed', {
      currentVersion: '0.0.1',
      latestVersion: '9.9.9',
      releaseUrl: 'https://example.invalid/releases',
      checkedAt: Date.now(),
      installKind: 'pacman',
      canSelfInstall: false,
      readyToInstall: false,
      error: null
    })
    await settle(600)

    const withBanner = await run(`(() => {
      const line = document.querySelector('.updateline')
      const c = document.getElementById('composer-input')
      const cr = c?.getBoundingClientRect()
      const app = document.querySelector('.app')?.getBoundingClientRect()
      const t = document.querySelector('.transcript')
      return {
        shown: !!line,
        says: line?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
        height: line ? Math.round(line.getBoundingClientRect().height) : 0,
        lineBottom: line ? Math.round(line.getBoundingClientRect().bottom) : null,
        appTop: app ? Math.round(app.top) : null,
        transcriptHeight: t ? Math.round(t.getBoundingClientRect().height) : null,
        composerBottom: cr ? Math.round(cr.bottom) : null,
        viewport: window.innerHeight,
        overflows: document.body.scrollHeight > window.innerHeight + 4
      }
    })()`)

    /*
     * A newer one than the one just dismissed, which is the behaviour the
     * button promises: saying "not this one" is not saying "never again".
     */
    check('the line appears when there is a newer version', withBanner.shown, withBanner)
    check(
      'even though an older release was waved away a moment ago',
      (await run(`localStorage.getItem('deep-pink:update-dismissed')`)) === '9.9.8'
    )
    check('and names both versions', /9\.9\.9/.test(withBanner.says ?? '') && /0\.0\.1/.test(withBanner.says ?? ''), withBanner.says)
    // The whole point of knowing how it was installed.
    check('and the command for how this copy was installed', /pacman -Syu/.test(withBanner.says ?? ''), withBanner.says)

    check('the page still does not overflow the viewport', !withBanner.overflows, withBanner)
    check('the composer is still on screen', withBanner.composerBottom <= withBanner.viewport + 1, withBanner)
    /*
     * Where the height comes from.
     *
     * This used to say the composer "moved up by exactly the line", and it
     * never ran against a line that was actually on screen until the two
     * sections stopped sharing a version — at which point it failed on a
     * layout doing the right thing. The composer is anchored to the bottom of
     * the app, and the app now starts where the line ends, so the composer
     * does not move at all: the transcript gives up the height instead.
     * Measured: the line 43px, the app starting at 43, the transcript 731 to
     * 688, the composer at 837 both times.
     *
     * The bug this section exists for went the other way — the composer
     * pushed down past the bottom of a window that clips — so "it did not
     * move" is the thing worth pinning, and the other two say why.
     */
    check(
      'and did not move, because the line took its height from the app',
      beforeBanner.composerBottom !== null &&
        Math.abs(beforeBanner.composerBottom - withBanner.composerBottom) <= 2,
      { beforeBanner, withBanner }
    )
    check(
      'which starts where the line ends',
      withBanner.lineBottom !== null && Math.abs(withBanner.appTop - withBanner.lineBottom) <= 1,
      withBanner
    )
    check(
      'and the transcript is what gave the room up',
      beforeBanner.transcriptHeight !== null &&
        Math.abs(beforeBanner.transcriptHeight - withBanner.transcriptHeight - withBanner.height) <= 2,
      { beforeBanner, withBanner }
    )

    // Dismissing puts it back, and is remembered against that version.
    await run(`document.querySelector('.updateline__close')?.click(), true`)
    await settle(400)
    check('dismissing it returns the space', await run(`!document.querySelector('.updateline')`))

    section('MCP says it is still moving')
    /*
     * Marked in two weights, the way every other unsettled feature is: a dot
     * where there is only room for one, and the word where somebody is about
     * to switch it on. MCP has no settings tab to carry the dot — it is
     * reached from the sidebar and opens its own panel — so both marks live
     * somewhere the settings dialog never sees.
     */
    const mcpButton = await run(`(() => {
      const b = [...document.querySelectorAll('.sidebar__footer .btn')]
        .find((x) => x.textContent.trim().startsWith('MCP'))
      return { found: !!b, dot: !!b?.querySelector('.tab__experimental'), title: b?.title ?? null }
    })()`)
    check('the sidebar button carries the mark', mcpButton.found && mcpButton.dot, mcpButton)
    check('and says so to a pointer resting on it', /experimental/i.test(mcpButton.title ?? ''), mcpButton.title)

    await run(`[...document.querySelectorAll('.sidebar__footer .btn')]
      .find((x) => x.textContent.trim().startsWith('MCP'))?.click()`)
    await settle(700)
    const mcpPanel = await run(`(() => {
      const t = document.querySelector('.panel__title')
      return { title: t?.textContent?.trim() ?? null, chip: !!t?.querySelector('.chip--experimental') }
    })()`)
    check('and the panel says the word', mcpPanel.chip, mcpPanel)
    check('beside the name of the thing', /MCP servers/.test(mcpPanel.title ?? ''), mcpPanel.title)

    await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
    await settle(400)

    section('the window does not wait for the renderer to be ready')
    /*
     * Two lines, guarding one measurement.
     *
     * `ready-to-show` is the usual advice for avoiding a white flash, and it
     * waits for a first paint. An empty `#root` gives Chromium nothing to
     * paint, so the window stayed hidden until React had mounted — measured
     * on 2026-09-21 at 2,566ms from launch, of which 216ms was the app and
     * the rest was waiting. Shown as soon as it is loading instead: ~260ms.
     *
     * Neither half can be checked by timing without the check being flaky, so
     * what is checked is the two things that made it slow — a window gated on
     * a paint, and nothing to paint. The app is running right now, so `#root`
     * holds React's output; the shipped file is what has to carry the
     * skeleton, and that is what is read.
     */
    const shipped = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'out', 'renderer', 'index.html'),
      'utf8'
    )
    check(
      'the shipped page has something to paint before any script runs',
      !/<div id="root">\s*<\/div>/.test(shipped),
      shipped.slice(shipped.indexOf('<div id="root">'), shipped.indexOf('<div id="root">') + 120)
    )
    // Inline, because a stylesheet is one more thing to fetch and the point
    // of the skeleton is to need nothing at all.
    check('and it needs no stylesheet to do it', /<style>/.test(shipped))

    const mainSource = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'main', 'index.ts'),
      'utf8'
    )
    check(
      'and the window is not held back until it is ready to show',
      !/once\('ready-to-show'/.test(mainSource),
      /once\('ready-to-show'[\s\S]{0,60}/.exec(mainSource)?.[0]
    )
    check('the window is on screen', win.isVisible())

    section('the About box reports the real version')
    await run(`[...document.querySelectorAll('.sidebar__footer .btn')]
      .find((b) => b.textContent.trim() === 'Settings').click()`)
    await settle(500)
    await run(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.trim() === 'Data').click()`)
    await settle(800)

    const about = await run(`(() => {
      const heading = [...document.querySelectorAll('.section-title')].find((e) => e.textContent.trim() === 'About')
      return heading?.nextElementSibling?.textContent?.trim() ?? null
    })()`)
    const declared = require('../package.json').version


    check('About shows a version at all', typeof about === 'string' && about.length > 0, about)
    check(
      'and it matches package.json rather than a written-down one',
      (about ?? '').includes(`Deep Pink ${declared}`),
      { about, declared }
    )

    /*
     * The footer, with and without the workshop.
     *
     * Every entry takes an equal share of the bar. At three the shares are
     * narrow enough that left-aligned content fills them; at two — MCP being
     * the first thing to go when the experimental parts are put away — each
     * is half the sidebar, and the same rule reads as a word pinned to the far
     * left and a word starting abruptly at the midpoint.
     */
    section('the sidebar footer')

    const padding = `[...document.querySelectorAll('.sidebar__footer .btn')].map((b) => {
      const box = b.getBoundingClientRect()
      const icon = b.querySelector('svg').getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(b)
      const text = range.getBoundingClientRect()
      return {
        label: b.textContent.trim(),
        before: Math.round(icon.left - box.left),
        after: Math.round(box.right - text.right)
      }
    })`

    const three = await run(padding)
    check('three entries, all of them', three.length === 3, three)
    check('sit where they always did', three.every((b) => b.before < 12), three)

    /*
     * Reloaded rather than merely saved. `settings.save` writes through the
     * preload straight to the main process; the renderer's own copy is only
     * updated by the store action the panel calls, so a window told this way
     * keeps drawing the footer it already had.
     */
    await run(`window.deepPink.settings.save({ hideExperimental: true }), true`)
    await settle(700)
    getWindow().webContents.reload()
    await settle(6000)
    const two = await run(padding)
    check('two entries', two.length === 2, two)
    check(
      'are centred in the halves they now have',
      two.every((b) => Math.abs(b.before - b.after) <= 1 && b.before > 12),
      two
    )
  },
  { bootApp: true }
)
