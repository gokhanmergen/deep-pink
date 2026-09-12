const { suite, settle } = require('./support/harness')

/**
 * Temporary chats, driven through the app that actually renders them.
 *
 * The storage suite proves the row goes and the sync suite proves it never
 * travelled; neither can say whether the thing on screen is reachable. A chat
 * is made temporary with a keystroke, on a chat that is already open and has
 * nothing in it — so this boots the real app and presses the key.
 */
suite(
  'temporary chats — as typed, not as called',
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

    /**
     * The binding, pressed.
     *
     * `mod` is Ctrl off macOS, and the handler is on `window`, so this is the
     * same event the keyboard would deliver. One binding both ways, which is
     * what makes pressing it twice a round trip rather than a dead end.
     */
    const pressToggleTemporary = () =>
      run(`(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 't', ctrlKey: true, altKey: true, bubbles: true
        }))
        return true
      })()`)

    const view = () =>
      run(`(() => ({
        groups: [...document.querySelectorAll('.sidebar__group-label')].map((e) => e.textContent.trim()),
        temporaryRows: document.querySelectorAll('.thread-item[data-temporary="true"]').length,
        rowLabels: [...document.querySelectorAll('.thread-item__title')].map((e) => e.textContent),
        badge: document.querySelector('.temp-badge')?.textContent ?? null,
        // The switch reads the same either way; what it says is in the styling.
        badgeOn: document.querySelector('.temp-badge')?.dataset.on ?? null,
        title: document.querySelector('.topbar__title')?.textContent ?? null,
        // The one raised by an action, not the standing "no API key yet"
        // banner, which is drawn as a toast and comes first in the document.
        toast: document.querySelector('.toast[data-tone]')?.textContent ?? null
      }))()`)

    section('the chat you are in becomes the temporary one')
    check('a new thread can be started', await clickByText('.sidebar__actions .btn', 'New thread'))
    await settle(700)
    check(
      'and it says how to make it temporary, where that can still be done',
      await run(`document.querySelector('.transcript .empty').textContent.includes('temporary')`)
    )

    // The switch is there to be seen and clicked, not only pressed: a feature
    // reachable by shortcut alone is a feature most people never find.
    const offered = await view()
    check('the switch is on screen before it is used', offered.badge !== null, offered)
    check('and it is showing as off', offered.badgeOn === 'false', offered.badgeOn)

    await pressToggleTemporary()
    await settle(700)

    const started = await view()
    check('it is headed off from the dated list', started.groups.some((g) => g.startsWith('Temporary')), started.groups)
    check('and drawn as a temporary row', started.temporaryRows === 1, started)
    check('labelled as what it is, since nothing will name it', started.rowLabels.includes('Temporary chat'), started.rowLabels)
    check('the title bar says so too', started.title === 'Temporary chat', started.title)
    check('and the switch is now showing as on', started.badgeOn === 'true', started.badgeOn)
    check('saying what it is rather than what to do about it',
      (started.badge ?? '').trim() === 'Temporary', started.badge)
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
    // The thread moved to has been spoken in, so there is nothing to switch.
    check('and no switch on a conversation that has been had', left.badge === null, left.badge)
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

    section('a conversation that has been had cannot be un-had')
    // The ordinary thread is open and has been spoken in. The binding still
    // fires — a shortcut that did nothing and said nothing would be worse —
    // but it refuses, and says why.
    await pressToggleTemporary()
    await settle(600)
    const refused = await view()
    check('the thread is left exactly as it was', repo.getThread(keeper.id).temporary === false)
    check('it is not drawn as temporary either', refused.temporaryRows === 0, refused)
    check(
      'and the refusal is explained rather than silent',
      (refused.toast ?? '').includes('Only a new chat'),
      refused.toast
    )

    section('keeping one instead')
    await clickByText('.sidebar__actions .btn', 'New thread')
    await settle(700)
    await pressToggleTemporary()
    await settle(700)
    const kept = repo.listThreads().find((t) => t.temporary)
    check('a second one is made', Boolean(kept), repo.listThreads().map((t) => t.title))

    // Said in it before it is kept, because an empty unnamed thread is swept
    // when it is left whatever it used to be — see the section below.
    repo.insertMessage({ threadId: kept.id, role: 'user', content: 'worth keeping' })

    check('the switch can be clicked back', await run(`(() => {
      const el = document.querySelector('.temp-badge')
      if (!el) return false
      el.click()
      return true
    })()`))
    await settle(700)

    const after = await view()
    // Spoken in by now, so switching it back also takes the switch away.
    check('and it goes, because there is nothing left to switch', after.badge === null, after.badge)
    check('and the row rejoins the list', after.temporaryRows === 0, after)
    check(
      'the chat is no longer temporary on disk',
      repo.getThread(kept.id)?.temporary === false,
      repo.getThread(kept.id)
    )

    await clickByText('.thread-item', 'An ordinary thread')
    await settle(800)
    check('so leaving it now leaves it alone', repo.getThread(kept.id) !== null)

    section('the same key both ways')
    await clickByText('.sidebar__actions .btn', 'New thread')
    await settle(700)
    await pressToggleTemporary()
    await settle(700)
    check('one press makes it temporary', (await view()).badgeOn === 'true')
    await pressToggleTemporary()
    await settle(700)
    check('and the next press keeps it', (await view()).badgeOn === 'false')
    check(
      'which the database agrees with',
      repo.listThreads().filter((t) => t.temporary).length === 0,
      repo.listThreads().map((t) => [t.title, t.temporary])
    )

    section('the older rule still wins over an empty one')
    // Keeping a chat nothing was said in does not make it worth a row: the
    // abandoned-thread sweep has removed unnamed empty threads on the way out
    // since long before temporary chats existed, and "kept" is not a claim that
    // there is anything to keep.
    await clickByText('.sidebar__actions .btn', 'New thread')
    await settle(700)
    await pressToggleTemporary()
    await settle(700)
    const hollow = repo.listThreads().find((t) => t.temporary)
    check('an empty one can be kept', Boolean(hollow))
    await pressToggleTemporary()
    await settle(700)
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
