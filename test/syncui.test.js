const { suite, settle } = require('./support/harness')

/**
 * The sync panel, in the window.
 *
 * The engine has its own suite; this is about the half a person touches — that
 * the key can be made and read back from the window it will be copied out of,
 * that nothing can be switched on before it could possibly work, and that the
 * secret access key is never rendered into the page.
 */
suite(
  'sync — setting it up',
  async ({ check, section, subject, getWindow }) => {
    const { getDb } = subject
    getDb()

    const win = getWindow()
    check('the window exists', Boolean(win))
    if (!win) return

    await settle(6000)
    const run = (js) => win.webContents.executeJavaScript(js)

    section('finding it')
    await run(`[...document.querySelectorAll('.sidebar__footer .btn')]
      .find((b) => b.textContent.trim() === 'Settings').click()`)
    await settle(500)

    const tabs = await run(`[...document.querySelectorAll('.tab')].map((t) => t.textContent.trim())`)
    check('there is a Sync section', tabs.includes('Sync'), tabs)

    await run(`[...document.querySelectorAll('.tab')]
      .find((t) => t.textContent.trim() === 'Sync').click()`)
    await settle(400)

    const before = await run(`(() => {
      const panel = document.querySelector('.panel__body')
      const toggles = [...panel.querySelectorAll('.switch input')]
      return {
        text: panel.textContent,
        enableDisabled: toggles[0]?.disabled,
        buttons: [...panel.querySelectorAll('button')].map((b) => b.textContent.trim())
      }
    })()`)

    check('it explains itself before anything is configured', /encrypted/i.test(before.text))
    check('it cannot be switched on with no key and no bucket', before.enableDisabled === true, before)
    check('it offers to make a key', before.buttons.includes('Generate a key'), before.buttons)
    check('and to take one from another machine', before.buttons.includes('Import'), before.buttons)

    section('making a key')
    await run(`[...document.querySelectorAll('.panel__body button')]
      .find((b) => b.textContent.trim() === 'Generate a key').click()`)
    await settle(700)

    const made = await run(`(() => {
      const panel = document.querySelector('.panel__body')
      const shown = [...panel.querySelectorAll('input')].map((i) => i.value).find((v) => v.startsWith('DPSK1'))
      const chip = [...panel.querySelectorAll('.chip')].map((c) => c.textContent.trim())
      return { shown, chip, buttons: [...panel.querySelectorAll('button')].map((b) => b.textContent.trim()) }
    })()`)

    check('the key is shown so it can be copied', Boolean(made.shown), made)
    check('it is written in the format the other machine reads', /^DPSK1(-[0-9A-HJKMNP-TV-Z]{1,5})+$/.test(made.shown ?? ''), made.shown)
    check('with a fingerprint to check machines against', made.chip.some((c) => /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(c)), made.chip)
    check('and a way to put it away again', made.buttons.includes('Hide'), made.buttons)

    // It has to survive the panel being closed and reopened, or it was never
    // stored — the whole point is that the other machines get this one.
    await run(`[...document.querySelectorAll('.panel__body button')]
      .find((b) => b.textContent.trim() === 'Hide').click()`)
    await settle(300)
    await run(`[...document.querySelectorAll('.panel__body button')]
      .find((b) => b.textContent.trim() === 'Show the key').click()`)
    await settle(400)

    const again = await run(
      `[...document.querySelectorAll('.panel__body input')].map((i) => i.value).find((v) => v.startsWith('DPSK1'))`
    )
    check('the same key comes back out of the keyring', again === made.shown, { again, made: made.shown })

    section('the bucket')
    const bucket = await run(`(() => {
      const panel = document.querySelector('.panel__body')
      const secret = [...panel.querySelectorAll('input')].find((i) => i.type === 'password')
      return {
        labels: [...panel.querySelectorAll('.field__label')].map((l) => l.textContent.trim()),
        secretIsHidden: Boolean(secret),
        secretValue: secret?.value,
        buttons: [...panel.querySelectorAll('button')].map((b) => b.textContent.trim())
      }
    })()`)

    for (const label of ['Endpoint', 'Bucket', 'Region', 'Access key ID', 'Secret access key', 'Prefix']) {
      check(`it asks for the ${label.toLowerCase()}`, bucket.labels.includes(label), bucket.labels)
    }
    check('the secret is typed into a password field', bucket.secretIsHidden === true)
    check('and never rendered back into the page', !bucket.secretValue, bucket.secretValue)
    check('the settings can be checked against the bucket', bucket.buttons.includes('Test the connection'))

    section('what travels')
    const scopes = await run(`(() => {
      const panel = document.querySelector('.panel__body')
      return [...panel.querySelectorAll('.switch')].map((s) => s.textContent.trim())
    })()`)
    check('conversations can be chosen', scopes.some((s) => s.startsWith('Conversations')), scopes)
    check('settings can be chosen separately', scopes.some((s) => s.startsWith('Settings and MCP')), scopes)
    check(
      'and it says the OpenRouter key is never included',
      scopes.join(' ').includes('OpenRouter key is never included'),
      scopes
    )

    section('the line in the sidebar')
    /*
     * Configured through the window's own bridge rather than through the copy
     * of the main modules this suite imports: the app under test is a separate
     * instance with its own caches, and configuring the wrong one is a way to
     * test nothing at all. Progress and state events are then pushed over the
     * real channels, which is how the renderer hears about a run without one
     * having to reach a network.
     */
    const appState = () => run(`window.deepPink.sync.state()`)
    const announce = async (patch = {}) =>
      win.webContents.send('sync:event', { ...(await appState()), ...patch })

    await run(`(async () => {
      await window.deepPink.sync.setSecret('test-secret')
      await window.deepPink.sync.save({
        enabled: true,
        endpoint: 'https://s3.example.com',
        bucket: 'b',
        accessKeyId: 'K',
        deviceName: 'This one'
      })
    })()`)
    await announce()
    await settle(300)

    const ready = await appState()
    check('it is ready to sync once it has all three', ready.ready === true, ready)

    const line = () => run(`(() => {
      const el = document.querySelector('.syncline')
      if (!el) return { shown: false }
      const fill = el.querySelector('.syncline__fill')
      return {
        shown: true,
        state: el.dataset.state,
        text: el.querySelector('.syncline__text').textContent.trim(),
        count: el.querySelector('.syncline__count')?.textContent?.trim() ?? null,
        width: fill?.style.width ?? null,
        indeterminate: fill?.dataset.indeterminate ?? null
      }
    })()`)

    const idle = await line()
    check('it appears once sync could actually run', idle.shown === true, idle)
    check('and says it has not synced yet', /not synced/.test(idle.text), idle)
    check('with no bar, because nothing is happening', idle.width === null, idle)

    section('the progress bar')
    await announce({ running: true })
    win.webContents.send('sync:progress', {
      phase: 'listing',
      detail: 'looking for the other machines',
      done: 0,
      total: 0,
      pushed: 0,
      pulled: 0,
      deleted: 0
    })
    await settle(300)

    const listing = await line()
    check('the line says what it is doing', listing.text === 'looking for the other machines', listing)
    check('and shows it is working', listing.state === 'running', listing)
    check(
      'with a bar that does not pretend to a proportion it has not got',
      listing.indeterminate === 'true',
      listing
    )

    win.webContents.send('sync:progress', {
      phase: 'sending',
      detail: 'handing over what is newer here',
      done: 5,
      total: 20,
      pushed: 5,
      pulled: 0,
      deleted: 0
    })
    await settle(300)

    const sending = await line()
    check('once there is a total, the bar fills to it', sending.width === '25%', sending)
    check('and the count is on screen', sending.count === '5/20', sending)

    const panelBar = await run(`(() => {
      const fill = document.querySelector('.syncbar__fill')
      const phase = document.querySelector('.syncphase')
      return { width: fill?.style.width ?? null, text: phase?.textContent?.trim() ?? null }
    })()`)
    check('the settings panel shows the same run', panelBar.width === '25%', panelBar)
    check('and names the step', /handing over/.test(panelBar.text ?? ''), panelBar)

    section('pausing from the panel')
    await announce({ running: false })
    await settle(300)

    const pauseButtons = await run(`[...document.querySelectorAll('.panel__body button')]
      .map((b) => b.textContent.trim())`)
    check('it offers an hour', pauseButtons.includes('Pause for an hour'), pauseButtons)
    check('a night', pauseButtons.includes('Until tomorrow'), pauseButtons)
    check('and indefinitely', pauseButtons.includes('Until I resume'), pauseButtons)

    await run(`[...document.querySelectorAll('.panel__body button')]
      .find((b) => b.textContent.trim() === 'Until I resume').click()`)
    await settle(500)

    const paused = await line()
    check('the sidebar says it is paused', paused.text === 'sync paused', paused)
    check('and shows it as a state of its own, not an error', paused.state === 'paused', paused)
    check('the app agrees, not just the window', (await appState()).paused === true)

    const pausedPanel = await run(`(() => {
      const panel = document.querySelector('.panel__body')
      const card = panel.querySelector('.list-card')
      return {
        text: panel.textContent,
        card: card?.textContent ?? '',
        buttons: [...panel.querySelectorAll('button')].map((b) => b.textContent.trim())
      }
    })()`)
    check('the panel offers the way back', pausedPanel.buttons.includes('Resume'), pausedPanel.buttons)
    check('the status card says so', /Paused/.test(pausedPanel.card), pausedPanel.card)
    check(
      'and it is clear that syncing by hand still works',
      /Sync now still works/.test(pausedPanel.text)
    )
    check(
      'so the button is not disabled by the pause',
      (await run(
        `[...document.querySelectorAll('.panel__body button')].find((b) => b.textContent.trim() === 'Sync now').disabled`
      )) === false
    )

    await run(`[...document.querySelectorAll('.panel__body button')]
      .find((b) => b.textContent.trim() === 'Resume').click()`)
    await settle(500)
    check('resuming puts it back', (await appState()).paused === false)
    check('and the line stops saying paused', (await line()).text !== 'sync paused')

    section('when it stops')
    await announce({ running: false, lastError: 'No bucket at https://s3.example.com/b' })
    await settle(300)

    const failed = await line()
    check('the line goes to an error state', failed.state === 'error', failed)
    check('and says so in words', /stopped/.test(failed.text), failed)
    check('the bar is gone with the run', failed.width === null, failed)

    section('status')
    const status = await run(`document.querySelector('.panel__body .list-card')?.textContent ?? ''`)
    check('the card says it has not synced yet', /Not synced yet/.test(status), status)
    check('and reports what stopped it', /No bucket at/.test(status), status)
  },
  { bootApp: true }
)
