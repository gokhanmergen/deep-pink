const { suite, settle } = require('./support/harness')

/**
 * Temporary chats, driven through the app that actually renders them.
 *
 * The storage suite proves the row goes and the sync suite proves it never
 * travelled; neither can say whether the thing on screen is reachable. The
 * promise here is made by a button and kept by a click on a different thread,
 * so this boots the real app and does both.
 */
suite(
  'temporary chats — as clicked, not as called',
  async ({ check, section, subject, getWindow }) => {
    const { getDb, repo } = subject
    getDb()

    const keeper = repo.createThread('An ordinary thread')
    repo.insertMessage({ threadId: keeper.id, role: 'user', content: 'still here tomorrow' })

    const win = getWindow()
    check('the window exists', Boolean(win))
    if (!win) return

    await settle(6000)
    const run = (js) => win.webContents.executeJavaScript(js)

    /** Clicks the first element matching a selector whose text contains `text`. */
    const clickByText = (selector, text) =>
      run(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((e) => e.textContent.includes(${JSON.stringify(text)}))
        if (!el) return false
        el.click()
        return true
      })()`)

    const view = () =>
      run(`(() => ({
        groups: [...document.querySelectorAll('.sidebar__group-label')].map((e) => e.textContent.trim()),
        temporaryRows: document.querySelectorAll('.thread-item[data-temporary="true"]').length,
        rowLabels: [...document.querySelectorAll('.thread-item__title')].map((e) => e.textContent),
        badge: document.querySelector('.temp-badge')?.textContent ?? null,
        title: document.querySelector('.topbar__title')?.textContent ?? null
      }))()`)

    section('starting one')
    check(
      'the sidebar offers a temporary chat',
      await clickByText('.sidebar__minor .minor-btn', 'Temporary chat')
    )
    await settle(600)

    const started = await view()
    check('it is headed off from the dated list', started.groups.some((g) => g.startsWith('Temporary')), started.groups)
    check('and drawn as a temporary row', started.temporaryRows === 1, started)
    check('labelled as what it is, since nothing will name it', started.rowLabels.includes('Temporary chat'), started.rowLabels)
    check('the title bar says so too', started.title === 'Temporary chat', started.title)
    check('with the way out of it right there', (started.badge ?? '').includes('keep'), started.badge)
    check(
      'and the database agrees there is one',
      repo.listThreads().filter((t) => t.temporary).length === 1,
      repo.listThreads().map((t) => [t.title, t.temporary])
    )

    section('leaving it ends it')
    check(
      'the ordinary thread can be clicked',
      await clickByText('.thread-item', 'An ordinary thread')
    )
    await settle(800)

    const left = await view()
    check('the temporary row is gone', left.temporaryRows === 0, left)
    check('so is its heading', !left.groups.some((g) => g.startsWith('Temporary')), left.groups)
    check('the badge goes with it', left.badge === null, left.badge)
    check('and the thread moved to is open', left.title === 'An ordinary thread', left.title)
    check(
      'nothing of it is left on disk',
      repo.listThreads().filter((t) => t.temporary).length === 0,
      repo.listThreads().map((t) => t.title)
    )
    check(
      'and no tombstone for another machine to act on',
      getDb().prepare("SELECT COUNT(*) AS n FROM sync_deletions WHERE kind = 'thread'").get().n === 0
    )

    section('keeping one instead')
    await clickByText('.sidebar__minor .minor-btn', 'Temporary chat')
    await settle(600)
    const kept = repo.listThreads().find((t) => t.temporary)
    check('a second one starts', Boolean(kept), repo.listThreads().map((t) => t.title))

    // Said in it before it is kept, because an empty unnamed thread is swept
    // when it is left whatever it used to be — see the section below.
    repo.insertMessage({ threadId: kept.id, role: 'user', content: 'worth keeping' })

    check('the badge is a button', await run(`(() => {
      const el = document.querySelector('.temp-badge')
      if (!el) return false
      el.click()
      return true
    })()`))
    await settle(600)

    const after = await view()
    check('clicking it takes the badge away', after.badge === null, after.badge)
    check('and the row rejoins the list', after.temporaryRows === 0, after)
    check(
      'the chat is no longer temporary on disk',
      repo.getThread(kept.id)?.temporary === false,
      repo.getThread(kept.id)
    )

    await clickByText('.thread-item', 'An ordinary thread')
    await settle(800)
    check('so leaving it now leaves it alone', repo.getThread(kept.id) !== null)

    section('the older rule still wins over an empty one')
    // Keeping a chat nothing was said in does not make it worth a row: the
    // abandoned-thread sweep has removed unnamed empty threads on the way out
    // since long before temporary chats existed, and "kept" is not a claim that
    // there is anything to keep.
    await clickByText('.sidebar__minor .minor-btn', 'Temporary chat')
    await settle(600)
    const hollow = repo.listThreads().find((t) => t.temporary)
    check('an empty one can be kept', Boolean(hollow) && (await run(`(() => {
      const el = document.querySelector('.temp-badge')
      if (!el) return false
      el.click()
      return true
    })()`)))
    await settle(600)
    check('and it is no longer temporary', repo.getThread(hollow.id)?.temporary === false)

    await clickByText('.thread-item', 'An ordinary thread')
    await settle(800)
    check(
      'but leaving it still sweeps it, because it is empty and unnamed',
      repo.getThread(hollow.id) === null,
      repo.getThread(hollow.id)
    )
  },
  { bootApp: true }
)
