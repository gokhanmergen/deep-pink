/**
 * Keybinding parsing and matching. Bindings are stored as strings like
 * `mod+shift+k`, where `mod` is Cmd on macOS and Ctrl everywhere else.
 */

const isMac = window.deepPink.platform === 'darwin'

const KEY_ALIASES: Record<string, string> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  escape: 'esc',
  ' ': 'space',
  // `+` and `_` are the shifted forms of `=` and `-`. Treating them as the same
  // key is what lets a `mod+=` binding answer to the `+` on the keycap.
  '+': '=',
  _: '-'
}

/**
 * Keys whose shifted form is a different character. A binding on one of these
 * ignores shift, so `mod+=`, `mod++` and `mod+shift+=` all mean zoom in — which
 * is how every browser behaves, and what users expect from whichever symbol is
 * printed on their keyboard.
 */
const SHIFT_AGNOSTIC = new Set(['=', '-'])

function normalizeKey(key: string): string {
  const lower = key.toLowerCase()
  return KEY_ALIASES[lower] ?? lower
}

export interface ParsedBinding {
  mod: boolean
  shift: boolean
  alt: boolean
  ctrl: boolean
  key: string
}

export function parseBinding(binding: string): ParsedBinding {
  const parts = binding.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)

  // A trailing literal `+` (as in `mod+=`) survives the split as an empty part.
  const key = normalizeKey(parts[parts.length - 1] || '+')

  return {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt') || parts.includes('option'),
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    key
  }
}

export function matchesBinding(event: KeyboardEvent, binding: string): boolean {
  const parsed = parseBinding(binding)
  const modPressed = isMac ? event.metaKey : event.ctrlKey

  if (parsed.mod !== modPressed) return false
  if (parsed.shift !== event.shiftKey && !SHIFT_AGNOSTIC.has(parsed.key)) return false
  if (parsed.alt !== event.altKey) return false
  // `mod` already accounts for Ctrl on non-Mac platforms.
  if (!isMac && !parsed.mod && parsed.ctrl !== event.ctrlKey) return false
  if (isMac && parsed.ctrl !== event.ctrlKey) return false

  if (normalizeKey(event.key) === parsed.key) return true

  // Option on macOS rewrites the character a key produces, so Alt+1 arrives as
  // '¡' and a digit binding would never match. The physical key is unambiguous
  // where a digit is concerned, so fall back to it.
  return /^\d$/.test(parsed.key) && event.code === `Digit${parsed.key}`
}

const SYMBOLS: Record<string, string> = {
  mod: isMac ? '⌘' : 'Ctrl',
  shift: isMac ? '⇧' : 'Shift',
  alt: isMac ? '⌥' : 'Alt',
  ctrl: isMac ? '⌃' : 'Ctrl',
  enter: isMac ? '↵' : 'Enter',
  backspace: isMac ? '⌫' : 'Backspace',
  esc: 'Esc',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  space: 'Space'
}

/** Human-readable form for display in menus and the cheatsheet. */
export function formatBinding(binding: string): string {
  return binding
    .split('+')
    .map((part) => {
      const lower = part.toLowerCase()
      if (SYMBOLS[lower]) return SYMBOLS[lower]
      if (lower.length === 1) return lower.toUpperCase()
      if (/^f\d+$/.test(lower)) return lower.toUpperCase()
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(isMac ? '' : '+')
}

/** Actions grouped for the cheatsheet, in the order they should be shown. */
export const KEYBIND_GROUPS: { title: string; actions: { id: string; label: string }[] }[] = [
  {
    title: 'Threads',
    actions: [
      { id: 'thread.new', label: 'New thread' },
      { id: 'thread.rename', label: 'Rename thread' },
      { id: 'thread.retitle', label: 'Regenerate thread name' },
      { id: 'thread.delete', label: 'Delete thread' },
      { id: 'thread.pin', label: 'Pin / unpin thread' },
      { id: 'thread.archive', label: 'Archive thread' },
      { id: 'thread.branch', label: 'Branch from message' },
      { id: 'thread.export', label: 'Export thread as JSON' },
      { id: 'thread.next', label: 'Next thread' },
      { id: 'thread.prev', label: 'Previous thread' }
    ]
  },
  {
    title: 'Folders',
    actions: [
      { id: 'folder.new', label: 'New folder' },
      { id: 'folder.fileThread', label: 'File this thread in a folder' }
    ]
  },
  {
    title: 'Navigation',
    actions: [
      { id: 'palette.open', label: 'Command palette' },
      { id: 'search.threads', label: 'Search all threads' },
      { id: 'search.inThread', label: 'Search in thread' },
      { id: 'sidebar.toggle', label: 'Toggle sidebar' },
      { id: 'focus.composer', label: 'Focus composer' },
      { id: 'settings.open', label: 'Settings' },
      { id: 'keybinds.cheatsheet', label: 'Keyboard shortcuts' }
    ]
  },
  {
    title: 'Messages',
    actions: [
      { id: 'message.send', label: 'Send message' },
      { id: 'message.newline', label: 'Insert newline' },
      { id: 'message.stop', label: 'Stop generating' },
      { id: 'message.regenerate', label: 'Regenerate last reply' },
      { id: 'message.editLast', label: 'Edit last message' },
      { id: 'message.copyLast', label: 'Copy last reply' }
    ]
  },
  {
    title: 'Model & routing',
    actions: [
      { id: 'model.picker', label: 'Change model' },
      { id: 'provider.picker', label: 'Choose provider' },
      { id: 'titleModel.picker', label: 'Choose thread-naming model' }
    ]
  },
  {
    title: 'Capabilities',
    actions: [
      { id: 'web.toggle', label: 'Toggle web access' },
      { id: 'mcp.panel', label: 'MCP servers' },
      { id: 'reasoning.toggle', label: 'Show / hide reasoning' },
      { id: 'context.compact', label: 'Compact context now' }
    ]
  },
  {
    title: 'Transparency',
    actions: [
      { id: 'prompt.inspect', label: 'Inspect system prompt' },
      { id: 'stats.thread', label: 'Thread statistics' },
      { id: 'stats.global', label: 'Global statistics' }
    ]
  },
  {
    title: 'View',
    actions: [
      { id: 'view.zoomIn', label: 'Zoom in' },
      { id: 'view.zoomOut', label: 'Zoom out' },
      { id: 'view.zoomReset', label: 'Reset zoom' }
    ]
  }
]

export const ACTION_LABELS: Record<string, string> = Object.fromEntries(
  KEYBIND_GROUPS.flatMap((group) => group.actions.map((action) => [action.id, action.label]))
)
