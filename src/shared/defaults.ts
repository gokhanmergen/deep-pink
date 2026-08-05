import type {
  CompactionSettings,
  ProviderRouting,
  Settings,
  TaggingSettings,
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

export const DEFAULT_TAG_PROMPT = `You maintain the tags on a conversation, so it can be found again later.

A tag names what the conversation is about: its subject, the technology involved, or the kind of work being done. Not its tone, not its format, and never "chat", "question" or "help".

Rules:
- One to three words, lower case.
- Reuse an existing tag over inventing a near-synonym of one.
- Add a tag only when it describes the conversation as a whole, not a passing mention.
- Remove a tag once it no longer describes what the conversation became.
- Two or three tags is usually right. Tagging exhaustively makes tags useless.
- Leave the tags alone when they are already correct.

Reply with JSON and nothing else, in this shape:
{"add": ["…"], "remove": ["…"]}

Use empty arrays when nothing should change.`

export const DEFAULT_TAGGING: TaggingSettings = {
  // Off by default: unlike naming a thread, this runs on every message, so it
  // is a recurring cost the user should choose deliberately.
  enabled: false,
  model: 'google/gemini-2.5-flash-lite',
  prompt: DEFAULT_TAG_PROMPT,
  allowNewTags: true,
  maxTagsPerThread: 6
}

export const DEFAULT_UI: UiSettings = {
  accent: '#ff1493',
  threadSort: 'edited',
  showTagsInSidebar: true,
  fontSize: 14,
  zoomLevel: 0,
  messageDensity: 'comfortable',
  codeTheme: 'github-dark-default',
  showReasoningByDefault: false,
  sendOnEnter: true,
  pasteAsFileThreshold: 2000
}

/**
 * `mod` resolves to Cmd on macOS and Ctrl elsewhere. Every action in the app is
 * reachable from here, and every binding is user-rebindable in Settings.
 */
export const DEFAULT_KEYBINDS: Record<string, string> = {
  // Threads
  'thread.new': 'mod+n',
  'thread.rename': 'f2',
  'thread.delete': 'mod+shift+backspace',
  'thread.pin': 'mod+shift+p',
  'thread.archive': 'mod+shift+a',
  'thread.branch': 'mod+shift+d',
  'thread.export': 'mod+shift+x',
  'thread.next': 'alt+down',
  'thread.prev': 'alt+up',

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
  'message.deleteLast': 'mod+shift+backspace',

  // Model & routing
  'model.picker': 'mod+m',
  'provider.picker': 'mod+shift+m',
  'titleModel.picker': 'mod+shift+t',
  'tagModel.picker': 'mod+alt+t',

  // Tags
  'tags.add': 'mod+shift+k',
  'tags.retag': 'mod+alt+k',

  // How the thread list is ordered
  'view.sortEdited': 'alt+1',
  'view.sortCreated': 'alt+2',
  'view.sortTags': 'alt+3',

  // Capabilities
  'web.toggle': 'mod+shift+w',
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

export const DEFAULT_SETTINGS: Settings = {
  hasApiKey: false,
  defaultModel: 'anthropic/claude-sonnet-4.5',
  titleModel: 'google/gemini-2.5-flash-lite',
  titleGenerationEnabled: true,
  titlePrompt: DEFAULT_TITLE_PROMPT,
  baseSystemPrompt: DEFAULT_BASE_SYSTEM_PROMPT,
  includeDateTimeInPrompt: false,
  defaultProviderRouting: DEFAULT_PROVIDER_ROUTING,
  modelProviderRouting: {},
  temperature: 1,
  maxTokens: null,
  streamReasoning: true,
  web: DEFAULT_WEB_SETTINGS,
  compaction: DEFAULT_COMPACTION,
  tagging: DEFAULT_TAGGING,
  sendAppAttribution: false,
  keybinds: DEFAULT_KEYBINDS,
  ui: DEFAULT_UI
}
