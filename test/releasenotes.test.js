const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { suite, settle } = require('./support/harness')

suite(
  'release notes — authored Markdown and the settings popup',
  async ({ check, section, subject, getWindow }) => {
    const { parseReleaseNotes, releaseNotesForVersion, shouldShowReleaseNotes } =
      subject.releaseNotes

    section('versioned feature bullets')
    const source =
      '# 1.2.3\n\n- **Sample feature**\n  A continuation.\n- [Sample link](https://example.invalid)\n'
    const notes = parseReleaseNotes(source)
    check('the version is read from the Markdown heading', notes?.version === '1.2.3', notes)
    check(
      'feature Markdown is preserved verbatim',
      notes?.body === source.split('\n\n')[1].trim(),
      notes
    )
    check(
      'Windows newlines and a byte-order mark work',
      parseReleaseNotes('\uFEFF' + source.replace(/\n/g, '\r\n'))?.version === '1.2.3'
    )
    check(
      'comments are never presented as features',
      parseReleaseNotes('# 1.2.3\n<!-- Draft -->\n- Sample')?.body === '- Sample'
    )
    check(
      'an unfinished human draft has no release notes',
      parseReleaseNotes('# 1.2.3\n<!-- Write bullets here -->') === null
    )
    check('a heading must specify a version', parseReleaseNotes('# Latest\n- Sample') === null)
    check(
      'feature prose without bullets is refused',
      parseReleaseNotes('# 1.2.3\nSample paragraph') === null
    )
    check(
      'extra headings cannot leak another version into the popup',
      parseReleaseNotes(source + '\n# 1.2.4\n- Another') === null
    )
    check(
      'a different version is never shown as current',
      releaseNotesForVersion(source, '1.2.4') === null
    )
    check(
      'the matching version can be opened',
      releaseNotesForVersion(source, '1.2.3')?.version === '1.2.3'
    )

    section('one automatic announcement per version')
    check('unseen notes are announced', shouldShowReleaseNotes(notes, '1.2.3', null))
    check(
      'the same version is not announced twice',
      !shouldShowReleaseNotes(notes, '1.2.3', '1.2.3')
    )
    check('notes are announced after an upgrade', shouldShowReleaseNotes(notes, '1.2.3', '1.2.2'))
    check(
      'stale notes cannot announce an upgrade',
      !shouldShowReleaseNotes(notes, '1.2.4', '1.2.2')
    )
    check(
      'an unfinished draft never creates an empty automatic popup',
      !shouldShowReleaseNotes(null, '1.2.3', null)
    )

    section('opening the latest notes from Settings')
    const win = getWindow()
    check('the window exists', Boolean(win))
    if (!win) return
    await settle(6000)
    const run = (js) => win.webContents.executeJavaScript(js)
    check(
      'unrelated UI suites suppress automatic release popups',
      (await run('window.deepPink.releaseNotesSuppressed')) === true
    )
    const click = async (js) => {
      const found = await run(js)
      await settle(500)
      return found
    }
    const settingsOpened = await click(`(() => {
    const button = [...document.querySelectorAll('.sidebar__footer .btn')].find((b) => b.textContent.trim() === 'Settings')
    if (!button) return false
    button.click()
    return true
  })()`)
    check('Settings opens', settingsOpened)
    if (!settingsOpened) return
    const aboutOpened = await click(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.textContent.trim() === 'Updates & about')
    if (!tab) return false
    tab.click()
    return true
  })()`)
    check('the updates section opens', aboutOpened)
    if (!aboutOpened) return
    const openNotes = () =>
      click(`(() => {
    const button = document.getElementById('show-release-notes')
    if (!button) return false
    button.click()
    return true
  })()`)
    const notesOpened = await openNotes()
    check('the latest notes button opens the popup', notesOpened)
    if (!notesOpened) return
    const version = require('../package.json').version
    const current = releaseNotesForVersion(
      readFileSync(join(__dirname, '..', 'release-notes.md'), 'utf8'),
      version
    )
    const popup = await run(`(() => ({
    dialog: !!document.querySelector('.panel--release-notes[role=dialog]'),
    title: document.querySelector('.panel--release-notes')?.getAttribute('aria-label'),
    version: document.querySelector('.release-notes__version')?.textContent,
    bullets: document.querySelectorAll('.release-notes li').length,
    text: document.querySelector('.release-notes')?.textContent,
    focused: document.activeElement?.textContent
  }))()`)
    check('the popup is a named dialog', popup.dialog && popup.title === 'What’s new', popup)
    check(
      'the popup specifies the installed version',
      popup.version === 'Version ' + version,
      popup
    )
    check(
      'published notes use bullets; a draft has a clear empty state',
      current
        ? popup.bullets > 0
        : popup.bullets === 0 && popup.text.includes('Release notes aren’t available'),
      popup
    )
    check('the close action receives keyboard focus', popup.focused === 'Done', popup)
    if (current)
      check(
        'seeing current notes is remembered',
        (await run(`localStorage.getItem('deep-pink:release-notes-seen')`)) === version
      )
    await run(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    )
    await settle(400)
    check(
      'Escape returns to the settings section that opened it',
      await run(
        `!!document.getElementById('show-release-notes') && !document.querySelector('.panel--release-notes')`
      )
    )
    check('latest notes remain available after closing', await openNotes())
    check(
      'reopening still shows the popup',
      await run(`!!document.querySelector('.panel--release-notes')`)
    )
  },
  { bootApp: true }
)
