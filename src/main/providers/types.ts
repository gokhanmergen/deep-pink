import type { ProviderRouting, ToolCall, ToolResult, Usage } from '@shared/types'

/** A part of a multimodal chat message. Images are represented as data URLs. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessageParam {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  name?: string
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
}

export interface ToolParam {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

/** Common input passed by the chat engine to a registered provider. */
export interface ChatRequest {
  model: string
  messages: ChatMessageParam[]
  temperature?: number
  maxTokens?: number | null
  tools?: ToolParam[]
  providerRouting?: ProviderRouting | null
  includeReasoning?: boolean
  reasoning?: Record<string, unknown> | null
  attribution: boolean
  signal?: AbortSignal
  webPlugin?: boolean
  /** Allow only Codex's native web search and page-reading tool. */
  nativeWebSearch?: boolean
  modalities?: string[]
}

export interface StreamHandlers {
  onContent?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onToolCalls?: (calls: ToolCall[]) => void
  /** Handle a client-owned Codex App Server dynamic tool call. */
  onDynamicToolCall?: (call: ToolCall) => Promise<ToolResult>
  onProvider?: (provider: string) => void
  onImage?: (dataUrl: string) => void
}

export interface Citation {
  url: string
  title: string
  snippet: string
}

export interface StreamResult {
  content: string
  reasoning: string
  images: string[]
  citations: Citation[]
  toolCalls: ToolCall[]
  /** True when the provider already executed its returned tool calls in-turn. */
  toolCallsHandled?: boolean
  finishReason: string | null
  provider: string | null
  usage: Usage
}
