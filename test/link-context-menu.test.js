const { suite } = require('./support/harness')
const { BrowserWindow, Menu, clipboard, shell } = require('electron')

suite('link context menu', async ({ check, subject }) => {
  const { linkContextMenuItems, registerLinkContextMenu } = subject
  const linkURL = 'https://example.org/article?q=hello%20world#details'
  const linkText = 'Read the article'
  const items = linkContextMenuItems({ linkURL, linkText })
  const select = (label) => items.find((item) => item.label === label).click()

  select('Copy Link Address')
  check('copies the full destination rather than the displayed text', clipboard.readText() === linkURL)
  select('Copy Link Text')
  check('copies the displayed link text separately', clipboard.readText() === linkText)
  check('ordinary text has no link menu', linkContextMenuItems({ linkURL: '', linkText: '' }).length === 0)
  check(
    'image links omit the empty copy-text action',
    !linkContextMenuItems({ linkURL, linkText: '' }).some((item) => item.label === 'Copy Link Text')
  )

  const originalOpen = shell.openExternal
  const originalPopup = Menu.prototype.popup
  const opened = []
  const popups = []
  let win
  try {
    shell.openExternal = async (url) => { opened.push(url) }
    Menu.prototype.popup = function (options) { popups.push({ menu: this, options }) }
    select('Open Link in Browser')
    check('opens the destination in the browser', opened.length === 1 && opened[0] === linkURL)
    for (const url of ['http://example.org', 'https://example.org']) {
      check(`allows web link ${url}`, linkContextMenuItems({ linkURL: url, linkText: '' })[0].enabled)
    }
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:test@example.org', 'invalid']) {
      const unsafeItems = linkContextMenuItems({ linkURL: url, linkText: '' })
      unsafeItems[0].click()
      check(`refuses to open ${url}`, unsafeItems[0].enabled === false && opened.length === 1)
      unsafeItems.find((item) => item.label === 'Copy Link Address').click()
      check(`can still copy ${url}`, clipboard.readText() === url)
    }

    win = new BrowserWindow({ show: false })
    registerLinkContextMenu(win)
    win.webContents.emit('context-menu', {}, { linkURL: '', linkText: '' })
    check('right-clicking ordinary content leaves its menu handling alone', popups.length === 0)
    win.webContents.emit('context-menu', {}, { linkURL, linkText })
    check(
      'right-clicking a link opens its menu in the owning window',
      popups.length === 1 && popups[0].options.window === win &&
        popups[0].menu.items.some((item) => item.label === 'Copy Link Address')
    )
  } finally {
    win?.destroy()
    shell.openExternal = originalOpen
    Menu.prototype.popup = originalPopup
  }
})
