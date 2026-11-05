import { clipboard, Menu, shell } from 'electron'
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from 'electron'
import { reportProblem } from './report'

export function linkContextMenuItems(
  { linkURL, linkText }: Pick<ContextMenuParams, 'linkURL' | 'linkText'>
): MenuItemConstructorOptions[] {
  if (!linkURL) return []

  // Keep the same web-only policy as ordinary link clicks.
  let canOpen = false
  try {
    const { protocol } = new URL(linkURL)
    canOpen = protocol === 'http:' || protocol === 'https:'
  } catch {
    // Even an invalid address can still be copied.
  }

  return [
    {
      label: 'Open Link in Browser',
      enabled: canOpen,
      click: () => {
        if (!canOpen) return
        void shell.openExternal(linkURL).catch((error) => reportProblem(error, 'Could not open link'))
      }
    },
    { type: 'separator' },
    { label: 'Copy Link Address', click: () => clipboard.writeText(linkURL) },
    ...(linkText.trim()
      ? [{ label: 'Copy Link Text', click: () => clipboard.writeText(linkText) }]
      : [])
  ]
}

/** Chromium supplies the link even when its text contains nested markup. */
export function registerLinkContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const items = linkContextMenuItems(params)
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })
}
