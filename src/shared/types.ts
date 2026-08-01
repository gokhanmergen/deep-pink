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
  /** Reasoning / thinking trace, when the model returns one. */
  reasoning: string | null
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
  /** Set when this message replaced older messages during context compaction. */
  isCompactionSummary: boolean
  /** Compacted-away messages are hidden from the transcript but kept on disk. */
  compactedInto: string | null
  usage: Usage | null
  /** Images the user attached to this message. */
  attachments: Attachment[]
}

export interface Thread {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  archived: boolean
  /** Per-thread overrides; anything unset falls back to global settings. */
  config: ThreadConfig
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
}

export interface DailyUsage {
  day: string
  totalTokens: number
  costUsd: number
  requests: number
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
}

export interface OpenRouterModel {
  id: string
  name: string
  description: string
  contextLength: number
  pricing: ModelPricing
  supportedParameters: string[]
  inputModalities: string[]
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

export interface Settings {
  /** Whether an OpenRouter key is stored. The key itself never crosses IPC. */
  hasApiKey: boolean
  defaultModel: string
  /** Model used to generate thread titles. */
  titleModel: string
  titleGenerationEnabled: boolean
  titlePrompt: string
  baseSystemPrompt: string
  includeDateTimeInPrompt: boolean
  defaultProviderRouting: ProviderRouting
  /** Per-model provider routing overrides, keyed by model id. */
  modelProviderRouting: Record<string, ProviderRouting>
  temperature: number
  maxTokens: number | null
  streamReasoning: boolean
  web: WebSearchSettings
  compaction: CompactionSettings
  /** Sends app name/url to OpenRouter for leaderboard attribution. Off by default. */
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
  ui?: Partial<UiSettings>
  defaultProviderRouting?: Partial<ProviderRouting>
}

export interface UiSettings {
  accent: string
  fontSize: number
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
}

/* ------------------------------------------------------------------ *
 * Streaming events (main → renderer)
 * ------------------------------------------------------------------ */

export type StreamEvent =
  | { type: 'start'; messageId: string; threadId: string }
  | { type: 'reasoning'; messageId: string; delta: string }
  | { type: 'content'; messageId: string; delta: string }
  | { type: 'tool-call'; messageId: string; toolCalls: ToolCall[] }
  | { type: 'tool-result'; messageId: string; result: ToolResult }
  | { type: 'tool-approval-request'; messageId: string; toolCall: ToolCall; serverName: string }
  | { type: 'usage'; messageId: string; usage: Usage }
  | { type: 'done'; messageId: string; message: Message }
  | { type: 'error'; messageId: string; error: string }
  /** The turn was stopped before it produced anything and was discarded. */
  | { type: 'aborted'; messageId: string; threadId: string }
  | { type: 'compaction-start'; threadId: string }
  | { type: 'compaction-done'; threadId: string; summaryMessageId: string; freedTokens: number }
  | { type: 'title'; threadId: string; title: string }

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
 * Importing from other clients
 * ------------------------------------------------------------------ */

export interface ImportSkipped {
  hiddenOrSystem: number
  toolTraffic: number
  empty: number
  unreadableConversations: number
}

/** What an export contains, reported before anything is written. */
export interface ImportPreview {
  filename: string
  conversations: number
  messages: number
  /** Present from an earlier import; these are left alone. */
  alreadyImported: number
  oldest: number | null
  newest: number | null
  skipped: ImportSkipped
  imagesFound: number
}

export interface ImportResult extends ImportPreview {
  threadsCreated: number
  messagesCreated: number
  imagesAttached: number
  imagesMissing: number
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
}
