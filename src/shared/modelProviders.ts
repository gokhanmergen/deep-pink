import type { ChatModel } from './types'

export type ChatProvider = ChatModel['provider']

const CODEX_PREFIX = 'codex:'

/** OpenRouter model ids are kept as-is for existing settings and thread data. */
export function providerForModel(model: string | null | undefined): ChatProvider {
  return model?.startsWith(CODEX_PREFIX) ? 'codex' : 'openrouter'
}

/** The id stored in settings and threads is namespaced to avoid provider collisions. */
export function modelIdForProvider(provider: ChatProvider, id: string): string {
  return provider === 'codex' ? `${CODEX_PREFIX}${id}` : id
}

export function providerModelId(model: string): string {
  return providerForModel(model) === 'codex' ? model.slice(CODEX_PREFIX.length) : model
}
