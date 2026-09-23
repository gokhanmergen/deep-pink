/**
 * Shared types — the contract between the Electron main process and the renderer.
 * Nothing in here may import from `electron` or the DOM.
 */

/* ------------------------------------------------------------------ *
 * Threads & messages
 * ------------------------------------------------------------------ */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type MessageStatus = 'complete' | 'streaming' | 'error' | 'aborted'

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string as emitted by the model; may be partial while streaming. */
  arguments: string
}

export interface ToolResult {
  toolCallId: string
  name: string
  content: string
  isError: boolean
  /** Milliseconds the tool took to run. */
  durationMs: number
}

/**
 * An image attached to a message. The bytes live on disk under the user data
 * directory; only metadata is stored in the database and only metadata crosses
 * IPC. The renderer loads the image through the `dpimg://` protocol so a thread
 * full of pictures does not have to be serialised into the transcript payload.
 */
export type AttachmentKind = 'image' | 'text'

export interface Attachment {
  id: string
  messageId: string
  mime: string
  filename: string
  bytes: number
  /** Intrinsic size, for images. */
  width: number | null
  height: number | null
  createdAt: number
  /** Where the renderer should load it from: `dpimg://attachment/<id>`. */
  url: string
  /**
   * Images travel to the model as `image_url` parts. Text is inlined into the
   * message — OpenRouter has no notion of a text file, so treating a long paste
   * as an attachment is a composer convenience, not a protocol feature.
   */
  kind: AttachmentKind
  /** First few lines, so the transcript can show a collapsed chip cheaply. */
  preview: string | null
}

/** An attachment on its way to being sent, before it has been stored. */
export interface PendingAttachment {
  mime: string
  filename: string
  /** Base64 payload, without a data-URL prefix. */
  data: string
  width: number | null
  height: number | null
}

export interface Message {
  id: string
  threadId: string
  role: Role
  content: string
  /**
   * Reasoning / thinking trace, when the model returns one.
   *
   * Null in a transcript read from disk even where there is one: traces are a
   * third of everything this app stores and none of it is on screen until
   * asked for, so a page of the conversation leaves them behind and they are
   * fetched when a reader opens one. Present while a reply is arriving, and
   * present in the full reads the engine and the exporter do.
   */
  reasoning: string | null
  /**
   * How long that trace is, whether or not it came with the message.
   *
   * What tells the transcript there is something to offer, and what the token
   * estimate is made from. Kept separate from the text precisely so the text
   * does not have to be there.
   */
  reasoningChars: number
  createdAt: number
  /** Model that produced this message (assistant messages only). */
  model: string | null
  /** Upstream provider that actually served the request, as reported by OpenRouter. */
  provider: string | null
  status: MessageStatus
  error: string | null
  toolCalls: ToolCall[] | null
  toolResult: ToolResult | null
  /**
   * Snapshot of the exact system prompt sent with this turn. Persisted so the
   * user can audit after the fact what went into the context — including
   * anything injected by MCP servers.
   */
  systemPromptSnapshot: SystemPromptSegment[] | null
  /**
   * Whether there is one, which is all the transcript ever wanted to know.
   *
   * The snapshot itself is only tested for truthiness on screen — it decides
   * whether a reply offers to show what went into it — while the panel that
   * opens computes a fresh preview rather than reading this. So a page of the
   * conversation carries the answer and leaves the several kilobytes of prompt
   * per message where they are.
   */
  hasPromptSnapshot: boolean
  /**
   * The sentences of this reply worth reading first, stored verbatim. Empty
   * when nothing was asked, nothing stood out, or the reply predates the
   * feature. More than one only where the reader allowed it.
   */
  keyPoints: string[]
  /** Set when this message replaced older messages during context compaction. */
  isCompactionSummary: boolean
  /** Compacted-away messages are hidden from the transcript but kept on disk. */
  compactedInto: string | null
  usage: Usage | null
  /** Images the user attached to this message. */
  attachments: Attachment[]
}

/**
 * A range of a transcript, as the screen reads it.
 *
 * A conversation is read from its end backwards, so what travels is a range
 * and where it starts. The renderer keeps `startSeq` and hands it back — to ask
 * for the page before this one, or to re-read this one when something in it
 * changed. `seq` itself never crosses: it is the database's ordering, and the
 * renderer has no business doing arithmetic on it.
 */
export interface MessagePage {
  messages: Message[]
  /** Where this range begins, or null when the thread has nothing to show. */
  startSeq: number | null
  /** Whether anything a reader would see comes before it. */
  hasOlder: boolean
}

/**
 * Everything the screen needs to open a conversation, in one answer.
 *
 * Four separate questions were asked at once and awaited together, which is
 * four crossings of the process boundary for one click. They are all cheap and
 * all about the same thread, so they are now one.
 */
export interface OpenedThread {
  page: MessagePage
  totals: ThreadTotals
  generating: boolean
  live: LiveStream[]
}

/** What a whole thread has cost, however much of it is on screen. */
export interface ThreadTotals {
  costUsd: number
  totalTokens: number
}

export interface Thread {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  archived: boolean
  /** The folder this thread is filed in, or null when it sits in the list. */
  folderId: string | null
  /**
   * A chat that is deleted the moment you leave it, and on the next start if
   * the app was closed with one open. Never named by the model and never
   * synced; pinning, filing or archiving one keeps it instead.
   */
  temporary: boolean
  /** Messages a reader would see — cost markers and compacted text excluded. */
  messageCount: number
  /** Per-thread overrides; anything unset falls back to global settings. */
  config: ThreadConfig
}

/* ------------------------------------------------------------------ *
 * Folders
 * ------------------------------------------------------------------ */

/**
 * A folder in the thread list.
 *
 * Deliberately thin: what is in a folder is a property of the threads, so the
 * list is assembled from the threads the sidebar already has rather than from
 * a second, separately-fetched membership that could disagree with them.
 */
export interface Folder {
  id: string
  name: string
  createdAt: number
  /** Pinned to the top of the list, exactly as a thread is. */
  pinned: boolean
}

export interface ThreadConfig {
  model: string | null
  providerRouting: ProviderRouting | null
  systemPrompt: string | null
  temperature: number | null
  maxTokens: number | null
  webAccessEnabled: boolean | null
  enabledMcpServers: string[] | null
  /**
   * Directories attached to this thread, granting read-only access to their
   * contents. Attached from the composer, and scoped to this thread alone.
   */
  repoPaths: string[]
  /** Segment ids the user has explicitly switched off for this thread. */
  disabledPromptSegments: string[]
  /**
   * Whether the model is told it may answer with charts, and whether this
   * thread draws them. Null follows the global setting, as web access does.
   */
  chartsEnabled: boolean | null
  /**
   * Whether a reply may be a set of documents rather than one. Unset falls
   * back to the global setting, exactly as charts does.
   */
  docsEnabled: boolean | null
}

/* ------------------------------------------------------------------ *
 * System prompt transparency
 * ------------------------------------------------------------------ */

export type SystemPromptSource =
  | 'base'
  | 'thread'
  | 'mcp-instructions'
  | 'mcp-resource'
  | 'tools'
  | 'web'
  | 'repo'
  | 'compaction'
  | 'datetime'
  | 'charts'
  | 'docs'
  /** The catalogue of what can be asked for, when skills load on demand. */
  | 'skills'
  | 'keyPoint'

export interface SystemPromptSegment {
  /** Stable id so a segment can be toggled off and remembered. */
  id: string
  source: SystemPromptSource
  /** Human label shown in the system-prompt inspector. */
  label: string
  /** Where this text came from, e.g. an MCP server name. */
  origin: string | null
  text: string
  tokens: number
  enabled: boolean
  /** False for segments the app requires (e.g. tool schemas while tools are on). */
  removable: boolean
}

/* ------------------------------------------------------------------ *
 * Usage, cost & stats
 * ------------------------------------------------------------------ */

export interface Usage {
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  cachedTokens: number
  totalTokens: number
  costUsd: number
  /** Wall-clock from request start to final chunk. */
  latencyMs: number
  /** Time to first streamed token. */
  timeToFirstTokenMs: number | null
  /**
   * How long the model spent thinking before it began answering.
   *
   * From the first reasoning token to the first content token, measured as
   * they arrive rather than worked out afterwards — the token count divided by
   * a rate would be a guess, and reasoning does not stream at the rate the
   * answer does. Null for a model that does not reason, and for every turn
   * recorded before this was measured.
   */
  reasoningMs: number | null
  tokensPerSecond: number | null
  /** OpenRouter generation id, for cross-referencing on their dashboard. */
  generationId: string | null
}

export interface ThreadStats {
  threadId: string
  messageCount: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  cachedTokens: number
  totalTokens: number
  costUsd: number
  /** Tokens currently occupied by the live context window. */
  contextTokens: number
  contextLimit: number | null
  avgTokensPerSecond: number | null
  avgTimeToFirstTokenMs: number | null
  toolCallCount: number
  toolUsage: ToolUsageRollup[]
  byModel: ModelUsageRollup[]
  /** Every request in the thread, oldest first — the shape of the conversation. */
  byTurn: TurnUsage[]
}

/** What one request cost, for plotting a thread against its own history. */
export interface TurnUsage {
  at: number
  costUsd: number
  totalTokens: number
}

export interface ModelUsageRollup {
  model: string
  provider: string | null
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsd: number
}

/** What tool calls cost, split by where they came from. */
export interface ToolUsageRollup {
  /** 'repo', 'web' or 'mcp'. */
  source: string
  calls: number
  chars: number
  estimatedTokens: number
  totalMs: number
}

export interface GlobalStats {
  threadCount: number
  messageCount: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  cachedTokens: number
  totalTokens: number
  costUsd: number
  firstUsedAt: number | null
  toolCallCount: number
  toolUsage: ToolUsageRollup[]
  byModel: ModelUsageRollup[]
  byProvider: ModelUsageRollup[]
  byDay: DailyUsage[]
  /** Per day and model, for a line each. Bounded to the same 90 days. */
  byDayModel: DailyModelUsage[]
}

export interface DailyUsage {
  day: string
  totalTokens: number
  costUsd: number
  requests: number
}

/** The same day, split by model, so each can be drawn as its own line. */
export interface DailyModelUsage extends DailyUsage {
  model: string
}

/* ------------------------------------------------------------------ *
 * OpenRouter
 * ------------------------------------------------------------------ */

export interface ProviderRouting {
  /** Ordered provider preference, e.g. ['anthropic', 'google-vertex']. */
  order: string[]
  /** When false, OpenRouter will not fall back to providers outside `order`. */
  allowFallbacks: boolean
  /** Restrict to these providers entirely. */
  only: string[]
  ignore: string[]
  sort: 'price' | 'throughput' | 'latency' | null
  requireParameters: boolean
  /** 'deny' opts out of providers that may train on your data. */
  dataCollection: 'allow' | 'deny'
}

export interface ModelPricing {
  prompt: number
  completion: number
  request: number
  image: number
  webSearch: number
  internalReasoning: number
  inputCacheRead: number
  inputCacheWrite: number
  /**
   * What each token of a generated image costs.
   *
   * Per token, not per image, which is worth stating because the number looks
   * like the latter and is three orders of magnitude away from it: one 1024px
   * image from gemini-2.5-flash-image came back as 1,290 image tokens at
   * $0.00003 each — four cents, measured (2026-09-22), for a request whose
   * headline price reads as a thirtieth of a penny.
   */
  imageOutput: number
}

export interface OpenRouterModel {
  id: string
  name: string
  description: string
  contextLength: number
  pricing: ModelPricing
  supportedParameters: string[]
  inputModalities: string[]
  /**
   * What the model can produce. `['text']` for almost everything; a model that
   * draws also lists `image`, and is asked for one by sending `modalities`.
   */
  outputModalities: string[]
  supportsTools: boolean
  supportsReasoning: boolean
  created: number
}

/** One upstream provider serving a given model, from /models/:id/endpoints. */
export interface ModelEndpoint {
  providerName: string
  tag: string
  contextLength: number | null
  pricing: ModelPricing
  quantization: string | null
  maxCompletionTokens: number | null
  supportedParameters: string[]
  uptimeLast30m: number | null
  status: number | null
}

/* ------------------------------------------------------------------ *
 * MCP
 * ------------------------------------------------------------------ */

export type McpTransport = 'stdio' | 'http'

export interface McpServerConfig {
  id: string
  name: string
  transport: McpTransport
  /** stdio */
  command: string | null
  args: string[]
  env: Record<string, string>
  cwd: string | null
  /** http */
  url: string | null
  headers: Record<string, string>
  enabled: boolean
  /**
   * When true, the server's `instructions` are injected into the system prompt.
   * Off by default — nothing reaches the system prompt without consent.
   */
  injectInstructions: boolean
  /** Tool names the user has disabled for this server. */
  disabledTools: string[]
  /** Require confirmation before each tool call from this server. */
  requireApproval: boolean
}

export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface McpToolInfo {
  serverId: string
  serverName: string
  name: string
  /** Namespaced name actually exposed to the model. */
  qualifiedName: string
  description: string
  inputSchema: unknown
  enabled: boolean
}

export interface McpServerStatus {
  id: string
  name: string
  state: McpConnectionState
  error: string | null
  /** Server-provided instructions, surfaced verbatim for inspection. */
  instructions: string | null
  tools: McpToolInfo[]
  resourceCount: number
  promptCount: number
  connectedAt: number | null
}

/* ------------------------------------------------------------------ *
 * Built-in tools
 * ------------------------------------------------------------------ */

export interface WebSearchSettings {
  enabled: boolean
  /** 'openrouter' uses OpenRouter's :online plugin; 'searxng' hits a self-hosted instance. */
  engine: 'openrouter' | 'searxng' | 'duckduckgo'
  searxngUrl: string
  maxResults: number
  /** Max characters of fetched page text handed back to the model. */
  fetchCharLimit: number
  /** Domains the fetch tool will refuse. */
  blockedDomains: string[]
}

/* ------------------------------------------------------------------ *
 * Context compaction
 * ------------------------------------------------------------------ */

export interface CompactionSettings {
  enabled: boolean
  /** Compact once context exceeds this fraction of the model's window. */
  triggerRatio: number
  /** Never compact these most-recent messages. */
  keepRecentMessages: number
  /** Model used to write the summary; falls back to the thread model. */
  model: string | null
  /** Prompt used to produce the summary. Fully user-editable. */
  prompt: string
  /** Ask before compacting rather than doing it silently. */
  requireConfirmation: boolean
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export type KeyPointSource = 'jev' | 'model' | 'self'

export interface Settings {
  /** Whether an OpenRouter key is stored. The key itself never crosses IPC. */
  hasApiKey: boolean
  defaultModel: string
  /** Model used to generate thread titles. */
  titleModel: string
  titleGenerationEnabled: boolean
  /**
   * Whether a thread is named from the question before the answer arrives.
   *
   * Naming has always waited for the reply, which is the better material and
   * the wrong moment — the row is nameless for exactly as long as you are
   * looking at it. With this on, a small model writes a name from what you
   * just asked, and the considered one replaces it when the turn ends. It is
   * off by default because it is a second request per conversation.
   */
  titlePregenEnabled: boolean
  /** The model that writes that first name. Empty falls back to `titleModel`. */
  titlePregenModel: string
  titlePrompt: string
  baseSystemPrompt: string
  includeDateTimeInPrompt: boolean
  defaultProviderRouting: ProviderRouting
  /** Per-model provider routing overrides, keyed by model id. */
  modelProviderRouting: Record<string, ProviderRouting>
  temperature: number
  maxTokens: number | null
  streamReasoning: boolean
  /**
   * Lets the model answer with charts. Off by default: it is a paragraph of
   * system prompt on every turn, and an app that quietly spends tokens on a
   * feature nobody asked for is not one worth trusting.
   */
  /**
   * Keeps the unfinished parts of the app out of sight, and switched off.
   *
   * One switch rather than six, because the six are not really separate
   * choices — what somebody wants is either the app or the workshop. The
   * features keep their own settings underneath, so turning this back off
   * returns the app to exactly how it was left.
   */
  hideExperimental: boolean
  chartsEnabled: boolean
  docsEnabled: boolean
  /**
   * Whether a skill's instructions are fetched when the model wants them, or
   * held open in the prompt from the first turn.
   *
   * On, which is the default: the prompt carries a line per skill saying when
   * it earns its keep, and the model calls `load_skill` for the rest if it
   * decides this is one of those times. Off: every enabled skill's full
   * instructions are in front of the model on every turn, which is how this
   * worked before and is a page of chart grammar in front of "what time is it
   * in Tokyo". The trade is one round trip against those tokens — and against
   * the model being unable to judge, because a prompt full of chart syntax is
   * a prompt that has already decided.
   */
  skillsOnDemand: boolean
  /**
   * After a reply lands, asks a decision model which sentence matters most and
   * marks it. Off by default: it is a second request per reply, and a reader
   * who did not ask for one should not be paying for one.
   */
  keyPointEnabled: boolean
  /**
   * Who decides which sentence matters.
   *
   * `jev` asks a decision model, which is the only one of the three that
   * returns a probability for every candidate and so the only one that can
   * say "nothing here stands out" and mean it. `model` asks an ordinary chat
   * model of your choosing, which will almost always pick something. `self`
   * asks nobody: the model writing the reply names its own sentence as it
   * goes, so there is no second request at all.
   */
  keyPointSource: KeyPointSource
  /** The chat model asked, when `keyPointSource` is `model`. */
  keyPointModel: string
  /**
   * Whether a reply may have more than one sentence marked.
   *
   * Two states and not a number, because the number never had a job. How
   * many get marked is decided by the question — the model is asked how many
   * separate things the reader wanted to know, and marks the sentence that
   * answers each — so a typed ceiling only ever did one of two things: sat
   * above the count and changed nothing, or sat below it and cut an answer
   * off. The only setting anybody actually wanted was between "one, always"
   * and "however many I asked for".
   */
  keyPointMany: boolean
  web: WebSearchSettings
  compaction: CompactionSettings
  /** Sends app name/url to OpenRouter for leaderboard attribution. On by default. */
  sendAppAttribution: boolean
  keybinds: Record<string, string>
  ui: UiSettings
}

/**
 * Settings updates are shallow at the top level but partial one level deep, so
 * the UI can save a single nested field without restating the whole group.
 */
export type SettingsPatch = Omit<
  Partial<Settings>,
  'web' | 'compaction' | 'ui' | 'defaultProviderRouting'
> & {
  web?: Partial<WebSearchSettings>
  compaction?: Partial<CompactionSettings>
  /**
   * `replyChips` is partial within the partial: it is eight switches and a
   * caller turning one of them over should not have to restate the other
   * seven. `loadSettings` and `saveSettings` merge it a level deeper for the
   * same reason.
   */
  ui?: Omit<Partial<UiSettings>, 'replyChips'> & { replyChips?: Partial<ReplyChips> }
  defaultProviderRouting?: Partial<ProviderRouting>
}

export interface UiSettings {
  accent: string
  fontSize: number
  /**
   * How wide the transcript and composer are allowed to get, in pixels. Wider
   * fits more code on a line; narrower keeps prose at a readable measure.
   */
  chatWidth: number
  /**
   * Chromium zoom level, where 0 is 100% and each step scales by 1.2. Scales the
   * whole interface, unlike `fontSize` which only changes text.
   */
  zoomLevel: number
  messageDensity: 'comfortable' | 'compact'
  codeTheme: string
  showReasoningByDefault: boolean
  sendOnEnter: boolean
  /**
   * Pasted text at least this long becomes an attachment instead of filling the
   * composer. 0 disables the behaviour.
   */
  pasteAsFileThreshold: number
  /**
   * Whether things move.
   *
   * Nothing in this app animates to tell you something — every bit of motion
   * is a softening of a change you asked for — so switching it off costs no
   * information. The system's own "reduce motion" already turns all of it off;
   * this is for somebody whose system does not say that but who wants the app
   * still anyway.
   */
  animations: boolean
  /**
   * Whether the app reads a conversation in as you scroll, or all at once.
   *
   * On — which is the default — a thread opens with the screenful you are
   * about to read and fetches the rest as you go back through it, and the
   * sidebar builds its rows in batches. That is what keeps a thread of two
   * thousand messages opening as fast as a thread of five.
   *
   * Off, everything arrives in one go. Opening a long thread then costs what
   * the whole of it costs — seconds, on the largest — but nothing is ever
   * fetched later, which is what somebody wants who scrolls by dragging the
   * bar to a point rather than by wheeling towards it, or who wants a whole
   * conversation in the window's own find.
   */
  loadEverythingAtOnce: boolean
  /**
   * Which figures a finished reply carries under it.
   *
   * There are seven and most people want two or three. Which two or three is
   * not something an app can know — somebody watching what a thread costs
   * wants the money, somebody comparing models wants the rate, somebody who
   * has neither question wants the row to be empty — so it is asked rather
   * than guessed at.
   */
  replyChips: ReplyChips
}

/** One switch per figure. See `UiSettings.replyChips`. */
export interface ReplyChips {
  /** Tokens sent: this message and the conversation behind it. */
  sent: boolean
  /** Tokens in the reply. */
  back: boolean
  /** Tokens spent thinking, for a model that reasons. */
  thinking: boolean
  /** Tokens that were already cached and cost less. */
  cached: boolean
  cost: boolean
  /** Tokens per second while it was writing. */
  speed: boolean
  /** How long before the first token arrived. */
  start: boolean
  /** How long the whole turn took, first byte to last. */
  took: boolean
}

/* ------------------------------------------------------------------ *
 * Streaming events (main → renderer)
 * ------------------------------------------------------------------ */

export type StreamEvent =
  | { type: 'start'; messageId: string; threadId: string }
  | { type: 'reasoning'; messageId: string; delta: string }
  | { type: 'content'; messageId: string; delta: string }
  | { type: 'tool-call'; messageId: string; toolCalls: ToolCall[] }
  /**
   * A tool round that finished, and the thread it finished in.
   *
   * `messageId` is the row just written for the result, which the renderer
   * has by definition never seen — so it cannot be what decides whether this
   * event is about the conversation on screen. Without the thread named here
   * the answer was "no", every time, and the step only appeared the next time
   * the thread was opened and read from the database.
   */
  | { type: 'tool-result'; threadId: string; messageId: string; result: ToolResult }
  | { type: 'tool-approval-request'; messageId: string; toolCall: ToolCall; serverName: string }
  /**
   * A picture the model drew, already stored and addressable.
   *
   * The whole `Attachment`, not a URL: it is the same row the reader's own
   * images get, so the transcript, the viewer, export and sync all take it
   * without being told that a model made this one.
   */
  | { type: 'image'; messageId: string; attachment: Attachment }
  | { type: 'usage'; messageId: string; usage: Usage }
  | { type: 'done'; messageId: string; message: Message }
  /*
   * `threadId` because the renderer has to know whose failure this is without
   * looking it up. It used to match the message against a map built from the
   * `start` events it had seen, and an error it could not place was an error
   * it dropped — leaving the sidebar showing a reply still arriving, forever.
   */
  | { type: 'error'; messageId: string; threadId?: string; error: string }
  /** The turn was stopped before it produced anything and was discarded. */
  | { type: 'aborted'; messageId: string; threadId: string }
  | { type: 'compaction-start'; threadId: string }
  | { type: 'compaction-done'; threadId: string; summaryMessageId: string; freedTokens: number }
  /**
   * A thread was named, or naming finished without a name.
   *
   * Null is the whole reason this carries a title at all rather than being a
   * nudge to re-read the list. The sidebar shimmers where the name will go,
   * and for as long as nothing said otherwise it could only stop by running a
   * clock — two minutes of pretending to work on a request that had already
   * failed in one second, which reads as a thread stuck mid-reply.
   */
  | { type: 'title'; threadId: string; title: string | null }

export interface SendMessageRequest {
  threadId: string
  content: string
  /** Regenerate from an existing message instead of appending a new user turn. */
  regenerateFromMessageId?: string
  /** Images to attach to the user turn. */
  attachments?: PendingAttachment[]
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

/** What `prompt:preview` returns — the inspector's view of the next request. */
export interface PromptPreview {
  segments: SystemPromptSegment[]
  systemText: string
  estimatedTokens: number
  toolCount: number
}

export interface CompactionStatus {
  needed: boolean
  used: number
  limit: number | null
}

/* ------------------------------------------------------------------ *
 * Exporting a thread
 * ------------------------------------------------------------------ */

/**
 * `markdown` is for reading and for anywhere that renders Markdown; it is a
 * transcript, not a backup. `archive` is the format this app can read back —
 * the thread's name, its settings, every message and its cost — so a
 * conversation can move between machines without losing anything.
 */
export type ExportFormat = 'markdown' | 'archive'

/* ------------------------------------------------------------------ *
 * Importing from other clients, and from Deep Pink itself
 * ------------------------------------------------------------------ */

/** Which reader a chosen file was recognised by. */
export type ImportKind = 'chatgpt' | 'deep-pink'

export interface ImportSkipped {
  hiddenOrSystem: number
  toolTraffic: number
  empty: number
  unreadableConversations: number
}

/** What an export contains, reported before anything is written. */
export interface ImportPreview {
  kind: ImportKind
  filename: string
  conversations: number
  messages: number
  /** Present from an earlier import; these are left alone. */
  alreadyImported: number
  oldest: number | null
  newest: number | null
  skipped: ImportSkipped
  imagesFound: number
  /**
   * Models the file names that OpenRouter is not offering you — retired, or
   * never on your account. A thread set to one of them is imported all the
   * same and falls back to your default model; what each message was answered
   * by is left alone, because that is a record of what happened.
   */
  unavailableModels: string[]
}

export interface ImportResult extends ImportPreview {
  threadsCreated: number
  messagesCreated: number
  imagesAttached: number
  imagesMissing: number
  /** Threads whose model was unavailable and now follow your default. */
  modelsCleared: number
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

/**
 * Which way a scope travels.
 *
 * Two-way is what most people want and what everything defaults to. The other
 * two exist because "sync my settings" is not one wish: a machine can be the
 * one that decides how the app is set up (`push`), or the one that follows
 * whatever the others decided (`pull`), and leaving that unsaid means a laptop
 * can quietly overwrite a desktop's shortcuts by being edited last.
 */
export type SyncDirection = 'two-way' | 'push' | 'pull'

/** What a machine is willing to put in the bucket, and take out of it. */
export interface SyncScopes {
  /** Threads, messages, folders and attachments. */
  conversations: boolean
  /** App settings and MCP servers. Never the OpenRouter key. */
  settings: boolean
  /** Which way conversations travel when they are on. */
  conversationsDirection: SyncDirection
  /** Which way settings and MCP servers travel when they are on. */
  settingsDirection: SyncDirection
}

/**
 * Everything about syncing that is not a secret. The S3 secret access key and
 * the encryption key live under the OS keyring and never cross IPC.
 */
/**
 * A pause, which is not the same as switching sync off.
 *
 * Off means "this machine does not sync"; paused means "not for now" — the
 * bucket, the key and the choices all stay exactly as they are, and it starts
 * again by itself if a time was given.
 */
export interface SyncPause {
  /** When it resumes on its own, or null for "until I say so". */
  until: number | null
  at: number
}

export interface SyncConfig {
  enabled: boolean
  /** Null when syncing normally. */
  pause: SyncPause | null
  /** Empty for AWS; an origin for R2, MinIO, Backblaze and the rest. */
  endpoint: string
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  scopes: SyncScopes
  /** How this machine names itself to the others. */
  deviceName: string
}

export interface SyncResult {
  at: number
  /** True when a pause cut the run short. What it managed is still recorded. */
  stopped: boolean
  pushed: number
  pulled: number
  /** Records deleted here because another machine deleted them. */
  deleted: number
  /** Machines seen in the bucket, this one included. */
  devices: number
  bytesUp: number
  bytesDown: number
  error: string | null
}

/**
 * Where a run has got to.
 *
 * Sent while it works rather than only at the end: a first sync of a long
 * library is thousands of objects, and a spinner that says nothing for two
 * minutes is indistinguishable from one that has hung.
 */
export interface SyncProgress {
  phase: 'listing' | 'receiving' | 'sending' | 'tidying' | 'done' | 'error'
  done: number
  total: number
  /** What it is doing, in words, e.g. "receiving messages". */
  detail: string
  pushed: number
  pulled: number
  deleted: number
}

export interface SyncState {
  config: SyncConfig
  hasKey: boolean
  /** Eight characters derived from the key, for checking two machines match. */
  keyFingerprint: string | null
  /** Whether an S3 secret access key is stored. */
  hasSecret: boolean
  /** Everything needed to sync is present. */
  ready: boolean
  /** Paused right now — a pause with a time on it expires by itself. */
  paused: boolean
  running: boolean
  lastSyncedAt: number | null
  lastError: string | null
  lastResult: SyncResult | null
}

/** Build identity, read from Electron rather than written down. */
export interface AppInfo {
  version: string
  electron: string
  chromium: string
  node: string
  platform: string
  arch: string
}

/** A reply still arriving, so a view can catch up on what it missed. */
export interface LiveStream {
  threadId: string
  messageId: string
  content: string
  reasoning: string
}

/** A directory attached to a thread, as the composer shows it. */
export interface AttachedRepo {
  path: string
  name: string
  /** False once the directory has been moved or removed. */
  available: boolean
}

export interface SearchHit {
  threadId: string
  threadTitle: string
  messageId: string | null
  role: Role | null
  /** FTS snippet with <mark> around matches. */
  snippet: string
  createdAt: number
  score: number
  /** What matched: the thread's name, or a message body. */
  kind: 'title' | 'message'
  /** So a hit in a temporary chat is labelled as one rather than "Untitled". */
  temporary: boolean
}
