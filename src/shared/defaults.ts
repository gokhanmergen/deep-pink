import type {
  CompactionSettings,
  ProviderRouting,
  Settings,
  UiSettings,
  WebSearchSettings
} from './types'
import { DEFAULT_REASONING } from './reasoning'

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

export const DEFAULT_QUICK_QUESTION_PROMPT = `Answer the question directly and briefly. Use one short paragraph at most, with no heading or list.`

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
  'reasoning.more': 'mod+shift+.',
  'reasoning.less': 'mod+shift+,',
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
 * The most sentences a reply may have marked, ever.
 *
 * Not a setting and not a target — a bound, so that "however many I asked
 * for" cannot become four hundred yes/no questions in one call or an
 * instruction to a model to mark half of what it wrote. Twenty is far past
 * the number of distinct things any one reply answers, so in practice it is
 * never what decides: the count from the question is.
 */
/**
 * Messages that exist only to carry a cost.
 *
 * A request the app makes on your behalf — naming a thread, picking the
 * sentence worth reading first — is paid for and so has to appear in the
 * statistics, and usage is recorded against a message. Neither has a message
 * of its own, so each gets an empty one with `compacted_into` set to its
 * kind, which keeps it out of the transcript and out of every count of what
 * was said.
 *
 * Listed here rather than written out at each of the four places that have
 * to know, because the fourth was the one that got forgotten: a new kind
 * added beside `title` showed up in the sidebar as an extra message.
 */
export const COST_MARKERS = ['title', 'keyPoint'] as const

export const MOST_KEY_POINTS = 20

/**
 * The ceiling the two settings mean.
 *
 * One is a real limit and is meant to bite: it says mark the single most
 * important sentence whatever was asked. The other is not a limit anybody
 * reaches, and is only here so nothing downstream has to handle "no bound".
 */
export function keyPointCeiling(many: boolean): number {
  return many ? MOST_KEY_POINTS : 1
}

/** A number from anywhere, held to something the rest of the app can act on. */
export function clampKeyPoints(most: number): number {
  if (!Number.isFinite(most)) return 1
  return Math.min(Math.max(Math.round(most), 1), MOST_KEY_POINTS)
}

export const DEFAULT_SETTINGS: Settings = {
  hasApiKey: false,
  defaultModel: 'anthropic/claude-sonnet-4.5',
  /*
   * Named by a model with somewhere to fall back to.
   *
   * This was gemma-3-12b-it, which is cheap and writes a fine title and is
   * served by exactly one provider. When that provider rate-limits — "google/
   * gemma-3-12b-it is temporarily rate-limited upstream", measured 2026-09-22
   * — OpenRouter has nobody to route to, so every attempt fails together and
   * the thread keeps no name. Retrying does not help against a model that is
   * out; the fix is a model that is served by more than one machine.
   *
   * gemini-2.5-flash-lite has five providers at twice the price of a title,
   * which is a hundredth of a cent either way.
   */
  titleModel: 'google/gemini-2.5-flash-lite',
  titleGenerationEnabled: true,
  // Off: it is a second request for every conversation, and the name it writes
  // is replaced a moment later. Worth it to somebody who watches the list while
  // a reply arrives, which is why it is offered rather than assumed.
  titlePregenEnabled: false,
  titlePregenModel: 'google/gemini-2.5-flash-lite',
  titlePrompt: DEFAULT_TITLE_PROMPT,
  baseSystemPrompt: DEFAULT_BASE_SYSTEM_PROMPT,
  includeDateTimeInPrompt: false,
  defaultProviderRouting: DEFAULT_PROVIDER_ROUTING,
  modelProviderRouting: {},
  temperature: 1,
  maxTokens: null,
  streamReasoning: true,
  reasoning: DEFAULT_REASONING,
  /*
   * The parts that are still moving are out of the way until asked for.
   *
   * Six of these carry the experimental mark, and all six together are more
   * of the settings panel than the settled app is. Somebody opening Deep Pink
   * for the first time should meet a chat client, not a workshop — and the
   * mark was only ever a warning label on a door nobody needed to open.
   *
   * Switched on by default, and `loadSettings` declines to switch it on for
   * an install that was already using one of them: arriving at an app that
   * has quietly turned off the bucket you sync to is not a clean first
   * impression, it is a bug.
   */
  hideExperimental: true,
  chartsEnabled: false,
  skillsOnDemand: true,
  customSkills: [],
  keyPointEnabled: false,
  keyPointSource: 'jev',
  /*
   * Only consulted when the source is `model`, and deliberately not the tiny
   * model the app names threads with.
   *
   * Naming a thread is a paraphrase and a 12B model does it well. This is a
   * counting problem — how many separate things did the reader want to know —
   * and measured across four questions (2026-09-20) gemma-3-12b answered a
   * single question about closures with four marks and a three-part question
   * with three, while haiku-4.5 and gpt-4.1-mini were right on every one. A
   * mark in the wrong place is worse than no mark, and this call is a rounding
   * error beside the reply it annotates.
   */
  keyPointModel: 'anthropic/claude-haiku-4.5',
  /*
   * More than one allowed, because the question decides how many.
   *
   * On, because the common case for anybody who turned this on at all is a
   * question with parts, and off means those parts go unmarked however many
   * there were. A reply making one point still gets exactly one mark either
   * way — that is the count doing its job, not this.
   */
  keyPointMany: true,
  web: DEFAULT_WEB_SETTINGS,
  compaction: DEFAULT_COMPACTION,
  quickQuestion: {
    model: 'google/gemini-2.5-flash-lite',
    systemPrompt: DEFAULT_QUICK_QUESTION_PROMPT,
    webAccessEnabled: false,
    keepRunning: false
  },
  sendAppAttribution: true,
  keybinds: DEFAULT_KEYBINDS,
  ui: DEFAULT_UI
}
