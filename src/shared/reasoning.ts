/**
 * How hard the model is asked to think, and whether you get to read it.
 *
 * Two different questions that have been one switch. `streamReasoning` asked
 * for the trace back; nothing asked for more or less of it. So a reasoning
 * model ran at whatever its provider's default happened to be — high for
 * some, minimal for others, and on a per-provider basis that changed under
 * the app without the app or the reader knowing.
 *
 * Which matters because reasoning is the expensive part. Reasoning tokens are
 * billed as output, and the gap between minimal and maximum on a large model
 * is most of the cost of the turn and most of the wait. "What is the capital
 * of France" and "find the bug in this file" are not the same question, and
 * until now they were asked the same way.
 *
 * OpenRouter normalises this across families that disagree about it —
 * OpenAI takes an effort word and no budget, Anthropic takes a budget and an
 * effort, Gemini maps effort onto its own thinking levels. So the app speaks
 * in efforts, offers a budget for the models that prefer one, and lets
 * OpenRouter translate.
 */

/** The ladder, low to high, as OpenRouter names them. */
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ReasoningEffort = (typeof EFFORTS)[number]

export type ReasoningMode =
  /** Say nothing, and let the model and its provider decide. */
  | 'auto'
  /** Ask it not to think at all, for models that can be told. */
  | 'off'
  | ReasoningEffort
  /** A number of tokens rather than a word. See `budgetTokens`. */
  | 'budget'

export interface ReasoningConfig {
  mode: ReasoningMode
  /** Only read when the mode is `budget`. */
  budgetTokens: number
}

export const DEFAULT_REASONING: ReasoningConfig = { mode: 'auto', budgetTokens: 4096 }

/** What each rung is called on screen, and what it is for. */
export const REASONING_LABELS: Record<ReasoningMode, string> = {
  auto: 'Automatic',
  off: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Very high',
  max: 'Maximum',
  budget: 'A token budget'
}

/** The short form, for the composer, where there is room for one word. */
export function shortReasoningLabel(config: ReasoningConfig): string {
  if (config.mode === 'auto') return 'Thinking'
  if (config.mode === 'budget') return `${config.budgetTokens.toLocaleString()} tokens`
  return REASONING_LABELS[config.mode]
}

/**
 * The `reasoning` field of the request, or null for "do not mention it".
 *
 * `effort` and `max_tokens` are mutually exclusive at OpenRouter, which is
 * why the two are one setting here rather than two fields somebody can set
 * against each other.
 *
 * `exclude` is the other half, and it is sent on every shape rather than only
 * when it is true: left unsaid, a provider returns its reasoning by default,
 * so the switch asking not to see it did nothing at all. Excluded reasoning
 * is still done and still billed — what is saved is the reading, not the
 * money, and the setting says so.
 */
export function reasoningParam(
  config: ReasoningConfig,
  include: boolean
): Record<string, unknown> | null {
  if (config.mode === 'off') return { enabled: false }
  if (config.mode === 'auto') return { exclude: !include }
  if (config.mode === 'budget') {
    // A budget of nothing is not a budget; fall back to saying nothing rather
    // than asking for zero tokens of thought and getting an error for it.
    if (!(config.budgetTokens > 0)) return { exclude: !include }
    return { max_tokens: Math.round(config.budgetTokens), exclude: !include }
  }
  return { effort: config.mode, exclude: !include }
}

/** The thread's answer if it has one, otherwise the global default. */
export function resolveReasoning(
  threadConfig: ReasoningConfig | null | undefined,
  fallback: ReasoningConfig | null | undefined
): ReasoningConfig {
  return threadConfig ?? fallback ?? DEFAULT_REASONING
}
