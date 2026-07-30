import type {
  ModelEndpoint,
  ModelPricing,
  OpenRouterModel,
  ProviderRouting,
  ToolCall,
  Usage
} from '@shared/types'
import { getCache, setCache } from '../db/repo'
import { getApiKey } from '../secrets'

const BASE = 'https://openrouter.ai/api/v1'
const CATALOG_TTL = 6 * 60 * 60 * 1000

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null
  ) {
    super(message)
    this.name = 'OpenRouterError'
  }
}

function authHeaders(attribution: boolean): Record<string, string> {
  const key = getApiKey()
  if (!key) throw new OpenRouterError('No OpenRouter API key set. Add one in Settings.', 401)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  }
  // Opt-in only: this is what puts an app on OpenRouter's public leaderboards.
  if (attribution) {
    headers['HTTP-Referer'] = 'https://github.com/gokhanmergen/deep-pink'
    headers['X-Title'] = 'Deep Pink'
  }
  return headers
}

function num(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function toPricing(raw: Record<string, unknown> | undefined): ModelPricing {
  return {
    prompt: num(raw?.prompt),
    completion: num(raw?.completion),
    request: num(raw?.request),
    image: num(raw?.image),
    webSearch: num(raw?.web_search),
    internalReasoning: num(raw?.internal_reasoning),
    inputCacheRead: num(raw?.input_cache_read),
    inputCacheWrite: num(raw?.input_cache_write)
  }
}

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

export async function listModels(force = false): Promise<OpenRouterModel[]> {
  if (!force) {
    const cached = getCache<OpenRouterModel[]>('models', CATALOG_TTL)
    if (cached) return cached
  }

  const res = await fetch(`${BASE}/models`)
  if (!res.ok) {
    const stale = getCache<OpenRouterModel[]>('models', Number.MAX_SAFE_INTEGER)
    if (stale) return stale
    throw new OpenRouterError(`Could not load models (HTTP ${res.status})`, res.status)
  }

  const body = (await res.json()) as { data: Record<string, never>[] }
  const models: OpenRouterModel[] = body.data.map((m) => {
    const supported = (m['supported_parameters'] as string[] | undefined) ?? []
    const architecture = (m['architecture'] as Record<string, unknown> | undefined) ?? {}
    return {
      id: String(m['id']),
      name: String(m['name'] ?? m['id']),
      description: String(m['description'] ?? ''),
      contextLength: num(m['context_length']),
      pricing: toPricing(m['pricing'] as Record<string, unknown> | undefined),
      supportedParameters: supported,
      inputModalities: (architecture['input_modalities'] as string[] | undefined) ?? ['text'],
      supportsTools: supported.includes('tools'),
      supportsReasoning: supported.includes('reasoning') || supported.includes('include_reasoning'),
      created: num(m['created'])
    }
  })

  models.sort((a, b) => a.id.localeCompare(b.id))
  setCache('models', models)
  return models
}

/**
 * The providers actually serving a model, with their individual pricing,
 * context limits and quantisation. This is what the provider picker shows.
 */
export async function listEndpoints(modelId: string, force = false): Promise<ModelEndpoint[]> {
  const cacheKey = `endpoints:${modelId}`
  if (!force) {
    const cached = getCache<ModelEndpoint[]>(cacheKey, CATALOG_TTL)
    if (cached) return cached
  }

  const res = await fetch(`${BASE}/models/${modelId}/endpoints`)
  if (!res.ok) {
    const stale = getCache<ModelEndpoint[]>(cacheKey, Number.MAX_SAFE_INTEGER)
    if (stale) return stale
    throw new OpenRouterError(`Could not load providers for ${modelId}`, res.status)
  }

  const body = (await res.json()) as {
    data?: { endpoints?: Record<string, never>[] }
  }

  const endpoints: ModelEndpoint[] = (body.data?.endpoints ?? []).map((e) => ({
    providerName: String(e['provider_name'] ?? ''),
    tag: String(e['tag'] ?? e['provider_name'] ?? ''),
    contextLength: e['context_length'] != null ? num(e['context_length']) : null,
    pricing: toPricing(e['pricing'] as Record<string, unknown> | undefined),
    quantization: (e['quantization'] as string | null) ?? null,
    maxCompletionTokens:
      e['max_completion_tokens'] != null ? num(e['max_completion_tokens']) : null,
    supportedParameters: (e['supported_parameters'] as string[] | undefined) ?? [],
    uptimeLast30m: e['uptime_last_30m'] != null ? num(e['uptime_last_30m']) : null,
    status: e['status'] != null ? num(e['status']) : null
  }))

  setCache(cacheKey, endpoints)
  return endpoints
}

/** Remaining credit on the key, for the global stats view. */
export async function getCredits(
  attribution: boolean
): Promise<{ totalCredits: number; totalUsage: number } | null> {
  try {
    const res = await fetch(`${BASE}/credits`, { headers: authHeaders(attribution) })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: { total_credits?: number; total_usage?: number } }
    return {
      totalCredits: num(body.data?.total_credits),
      totalUsage: num(body.data?.total_usage)
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Chat completions
 * ------------------------------------------------------------------ */

/** A part of a multimodal message. Images ride along as data URLs. */
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

export interface ChatRequest {
  model: string
  messages: ChatMessageParam[]
  temperature?: number
  maxTokens?: number | null
  tools?: ToolParam[]
  providerRouting?: ProviderRouting | null
  includeReasoning?: boolean
  attribution: boolean
  signal?: AbortSignal
  /** Appends OpenRouter's `:online` web plugin to the model slug. */
  webPlugin?: boolean
}

export interface StreamHandlers {
  onContent?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onToolCalls?: (calls: ToolCall[]) => void
  onProvider?: (provider: string) => void
}

export interface StreamResult {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  finishReason: string | null
  provider: string | null
  usage: Usage
}

function toProviderParam(routing: ProviderRouting | null | undefined): unknown {
  if (!routing) return undefined
  const param: Record<string, unknown> = {}
  if (routing.order.length) param.order = routing.order
  if (routing.only.length) param.only = routing.only
  if (routing.ignore.length) param.ignore = routing.ignore
  if (routing.sort) param.sort = routing.sort
  if (routing.requireParameters) param.require_parameters = true
  if (routing.dataCollection === 'deny') param.data_collection = 'deny'
  param.allow_fallbacks = routing.allowFallbacks
  return Object.keys(param).length ? param : undefined
}

/**
 * Streams a completion, returning the assembled result. Deltas are handed to
 * `handlers` as they arrive so the renderer can paint them immediately.
 */
export async function streamChat(
  req: ChatRequest,
  handlers: StreamHandlers = {}
): Promise<StreamResult> {
  const startedAt = Date.now()
  let firstTokenAt: number | null = null

  const body: Record<string, unknown> = {
    model: req.webPlugin ? `${req.model}:online` : req.model,
    messages: req.messages,
    stream: true,
    // Ask OpenRouter to include real accounting (including cost) in the final chunk.
    usage: { include: true }
  }
  if (req.temperature != null) body.temperature = req.temperature
  if (req.maxTokens != null) body.max_tokens = req.maxTokens
  if (req.tools?.length) body.tools = req.tools
  if (req.includeReasoning) body.reasoning = { exclude: false }

  const provider = toProviderParam(req.providerRouting)
  if (provider) body.provider = provider

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(req.attribution),
    body: JSON.stringify(body),
    signal: req.signal
  })

  if (!res.ok || !res.body) {
    let message = `Request failed (HTTP ${res.status})`
    let code: string | null = null
    try {
      const err = (await res.json()) as { error?: { message?: string; code?: string } }
      if (err.error?.message) message = err.error.message
      if (err.error?.code) code = String(err.error.code)
    } catch {
      /* response was not JSON; keep the generic message */
    }
    throw new OpenRouterError(message, res.status, code)
  }

  let content = ''
  let reasoning = ''
  let finishReason: string | null = null
  let servedBy: string | null = null
  let usage: Usage = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    timeToFirstTokenMs: null,
    tokensPerSecond: null,
    generationId: null
  }

  /** Tool calls arrive as indexed fragments that must be stitched together. */
  const toolAcc = new Map<number, ToolCall>()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let lineEnd: number
      while ((lineEnd = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, lineEnd).trim()
        buffer = buffer.slice(lineEnd + 1)

        // OpenRouter sends `: OPENROUTER PROCESSING` comments as keep-alives.
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue

        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue

        let chunk: Record<string, never>
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }

        if (chunk['id'] && !usage.generationId) usage.generationId = String(chunk['id'])
        if (chunk['provider'] && !servedBy) {
          servedBy = String(chunk['provider'])
          handlers.onProvider?.(servedBy)
        }

        const choice = (chunk['choices'] as Record<string, never>[] | undefined)?.[0]
        if (choice) {
          if (choice['finish_reason']) finishReason = String(choice['finish_reason'])

          const delta = (choice['delta'] as Record<string, never> | undefined) ?? {}

          const reasoningDelta = delta['reasoning'] as string | undefined
          if (reasoningDelta) {
            firstTokenAt ??= Date.now()
            reasoning += reasoningDelta
            handlers.onReasoning?.(reasoningDelta)
          }

          const contentDelta = delta['content'] as string | undefined
          if (contentDelta) {
            firstTokenAt ??= Date.now()
            content += contentDelta
            handlers.onContent?.(contentDelta)
          }

          const calls = delta['tool_calls'] as Record<string, never>[] | undefined
          if (calls) {
            for (const call of calls) {
              const index = num(call['index'])
              const existing = toolAcc.get(index) ?? { id: '', name: '', arguments: '' }
              const fn = (call['function'] as Record<string, never> | undefined) ?? {}
              toolAcc.set(index, {
                id: (call['id'] as string | undefined) ?? existing.id,
                name: (fn['name'] as string | undefined) ?? existing.name,
                arguments: existing.arguments + ((fn['arguments'] as string | undefined) ?? '')
              })
            }
          }
        }

        const rawUsage = chunk['usage'] as Record<string, never> | undefined
        if (rawUsage) {
          const promptDetails =
            (rawUsage['prompt_tokens_details'] as Record<string, never> | undefined) ?? {}
          const completionDetails =
            (rawUsage['completion_tokens_details'] as Record<string, never> | undefined) ?? {}
          usage = {
            ...usage,
            promptTokens: num(rawUsage['prompt_tokens']),
            completionTokens: num(rawUsage['completion_tokens']),
            reasoningTokens: num(completionDetails['reasoning_tokens']),
            cachedTokens: num(promptDetails['cached_tokens']),
            totalTokens: num(rawUsage['total_tokens']),
            costUsd: num(rawUsage['cost'])
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const finishedAt = Date.now()
  const toolCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call)
  if (toolCalls.length) handlers.onToolCalls?.(toolCalls)

  const generationSeconds = firstTokenAt ? (finishedAt - firstTokenAt) / 1000 : 0
  usage.latencyMs = finishedAt - startedAt
  usage.timeToFirstTokenMs = firstTokenAt ? firstTokenAt - startedAt : null
  usage.tokensPerSecond =
    generationSeconds > 0 && usage.completionTokens > 0
      ? usage.completionTokens / generationSeconds
      : null

  return { content, reasoning, toolCalls, finishReason, provider: servedBy, usage }
}

/** Non-streaming call, used for thread titles and compaction summaries. */
export async function complete(req: Omit<ChatRequest, 'tools'>): Promise<StreamResult> {
  return streamChat({ ...req, includeReasoning: false })
}
