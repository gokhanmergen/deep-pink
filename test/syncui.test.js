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

    section('status')
    const status = await run(`document.querySelector('.panel__body .list-card')?.textContent ?? ''`)
    check('it says it has not synced yet', /Not synced yet/.test(status), status)
    check('and what is still missing', /No bucket credentials yet/.test(status), status)
  },
  { bootApp: true }
)
