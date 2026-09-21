import type {
  CompactionSettings,
  ProviderRouting,
  Settings,
  UiSettings,
  WebSearchSettings
} from './types'

export const DEFAULT_PROVIDER_ROUTING: ProviderRouting = {
  order: [],
  allowFallbacks: true,
  only: [],
  ignore: [],
  sort: null,
  requireParameters: false,
  // Privacy first: never route to providers that may train on prompts.
  dataCollection: 'deny'
}

export const DEFAULT_WEB_SETTINGS: WebSearchSettings = {
  enabled: false,
  engine: 'duckduckgo',
  searxngUrl: 'http://localhost:8888',
  maxResults: 5,
  fetchCharLimit: 20000,
  blockedDomains: []
}

export const DEFAULT_COMPACTION_PROMPT = `You are compacting a conversation to free up context.

Write a dense summary of the conversation so far. It replaces the messages it summarises, so it must stand alone.

Preserve:
- The user's goals, constraints and stated preferences, in their own words where it matters.
- Decisions made and the reasoning behind them.
- Concrete facts, identifiers, file paths, names, numbers and code that later turns may need.
- Unresolved questions and the current state of any in-progress work.

Drop pleasantries, restatements and reasoning that led nowhere. Do not add information that is not in the conversation. Write in plain prose and lists, not as a dialogue.`

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  triggerRatio: 0.75,
  keepRecentMessages: 6,
  model: null,
  prompt: DEFAULT_COMPACTION_PROMPT,
  requireConfirmation: true
}

export const DEFAULT_TITLE_PROMPT = `Write a title for this conversation.

Rules:
- 2 to 6 words.
- No quotes, no trailing punctuation, no "Chat about".
- Describe the specific subject, not the format.

Reply with the title and nothing else.`

export const DEFAULT_UI: UiSettings = {
  accent: '#8a8eff',
  fontSize: 14,
  // Around 90 characters at the default size — a comfortable measure for prose,
  // and the width the app was designed at.
  chatWidth: 780,
  zoomLevel: 0,
  messageDensity: 'comfortable',
  codeTheme: 'github-dark-default',
  showReasoningByDefault: false,
  sendOnEnter: true,
  pasteAsFileThreshold: 2000,
  animations: true,
  loadEverythingAtOnce: false,
  /*
   * On by default: what it cost, how fast, and how long. Token counts are off,
   * because four numbers that are all tokens is a row nobody reads — they are
   * there for when you go looking, which is what the switches are for.
   */
  replyChips: {
    sent: false,
    back: false,
    thinking: false,
    cached: false,
    cost: true,
    speed: true,
    start: false,
    took: true
  }
}

/**
 * `mod` resolves to Cmd on macOS and Ctrl elsewhere. Every action in the app is
 * reachable from here, and every binding is user-rebindable in Settings.
 */
export const DEFAULT_KEYBINDS: Record<string, string> = {
  // Threads
  'thread.new': 'mod+n',
  // Turning the chat you are in into one that ends when you leave it, and back.
  'thread.toggleTemporary': 'mod+alt+t',
  'thread.rename': 'f2',
  // F2 names it yourself; shift asks the model to.
  'thread.retitle': 'shift+f2',
  'thread.delete': 'mod+shift+backspace',
  'thread.pin': 'mod+shift+p',
  'thread.archive': 'mod+shift+a',
  'thread.branch': 'mod+shift+d',
  // Markdown to read, and the archive that can be read back in.
  'thread.export': 'mod+shift+x',
  'thread.exportArchive': 'mod+alt+x',
  'thread.next': 'alt+down',
  'thread.prev': 'alt+up',

  // Folders
  'folder.new': 'mod+shift+n',
  'folder.fileThread': 'mod+shift+f',

  // Navigation & panels
  'palette.open': 'mod+k',
  'search.threads': 'mod+p',
  'search.inThread': 'mod+f',
  'sidebar.toggle': 'mod+b',
  'settings.open': 'mod+,',
  'keybinds.cheatsheet': 'mod+/',
  'focus.composer': 'mod+l',

  // Composing
  'message.send': 'enter',
  'message.newline': 'shift+enter',
  'message.stop': 'mod+.',
  'message.regenerate': 'mod+r',
  'message.editLast': 'mod+up',
  'message.copyLast': 'mod+shift+y',
  /*
   * Copy whichever code block the pointer happens to be over.
   *
   * `mod` rather than a literal `ctrl` because that is how every binding here
   * is written, and because the matcher treats Ctrl as `mod` off macOS — a
   * binding spelled `ctrl+space` would be dead on the platform it was asked
   * for. This is Ctrl+Space on Linux and Windows, and Cmd+Space on macOS,
   * where Spotlight has it and it is worth rebinding.
   */
  'code.copyHovered': 'mod+space',
  'message.deleteLast': 'mod+shift+backspace',

  // Model & routing
  'model.picker': 'mod+m',
  'provider.picker': 'mod+shift+m',
  'titleModel.picker': 'mod+shift+t',

  // Capabilities
  'web.toggle': 'mod+shift+w',
  'charts.toggle': 'mod+shift+b',
  /*
   * Not `mod+shift+d`, which it shipped with and which branching a thread has
   * held since long before documents existed. Two actions on one chord is
   * resolved by declaration order, and branching is declared first — so this
   * was simply unreachable from the keyboard for two releases.
   */
  'docs.toggle': 'mod+shift+o',
  'sync.pause': 'mod+shift+u',
  'mcp.panel': 'mod+shift+e',
  'reasoning.toggle': 'mod+shift+r',
  'context.compact': 'mod+shift+c',

  // Transparency & stats
  'prompt.inspect': 'mod+i',
  'stats.thread': 'mod+shift+s',
  'stats.global': 'mod+shift+g',

  // View
  'view.zoomIn': 'mod+=',
  'view.zoomOut': 'mod+-',
  'view.zoomReset': 'mod+0'
}

export const DEFAULT_BASE_SYSTEM_PROMPT =
  'You are a helpful assistant. Be direct and concise. Use Markdown for structure, fenced code blocks with a language tag for code, and LaTeX between $…$ or $$…$$ for mathematics.'

/**
 * The most sentences a reply may have marked.
 *
 * Not a shape the feature breaks at — a ceiling, so a typed number cannot
 * become a request for four hundred yes/no questions in one call, or an
 * instruction to a model to mark half of what it wrote. Twenty is far past
 * the number of distinct things any one reply answers.
 */
export const MOST_KEY_POINTS = 20

/** A typed number, held to something the rest of the app can act on. */
export function clampKeyPoints(most: number): number {
  if (!Number.isFinite(most)) return 1
  return Math.min(Math.max(Math.round(most), 1), MOST_KEY_POINTS)
}

export const DEFAULT_SETTINGS: Settings = {
  hasApiKey: false,
  defaultModel: 'anthropic/claude-sonnet-4.5',
  titleModel: 'google/gemma-3-12b-it',
  titleGenerationEnabled: true,
  // Off: it is a second request for every conversation, and the name it writes
  // is replaced a moment later. Worth it to somebody who watches the list while
  // a reply arrives, which is why it is offered rather than assumed.
  titlePregenEnabled: false,
  titlePregenModel: 'google/gemma-3-12b-it',
  titlePrompt: DEFAULT_TITLE_PROMPT,
  baseSystemPrompt: DEFAULT_BASE_SYSTEM_PROMPT,
  includeDateTimeInPrompt: false,
  defaultProviderRouting: DEFAULT_PROVIDER_ROUTING,
  modelProviderRouting: {},
  temperature: 1,
  maxTokens: null,
  streamReasoning: true,
  chartsEnabled: false,
  docsEnabled: false,
  keyPointEnabled: false,
  keyPointSource: 'jev',
  // The same small, cheap model the app names threads with. Only consulted
  // when the source is `model`.
  keyPointModel: 'google/gemma-3-12b-it',
  keyPointMost: 1,
  web: DEFAULT_WEB_SETTINGS,
  compaction: DEFAULT_COMPACTION,
  sendAppAttribution: true,
  keybinds: DEFAULT_KEYBINDS,
  ui: DEFAULT_UI
}
