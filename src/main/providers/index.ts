import { providerForModel } from '@shared/modelProviders'
import type { ChatModel, ProviderStatus } from '@shared/types'
import * as codex from './codex'
import {
  complete as completeOpenRouter,
  knownModel as knownOpenRouterModel,
  listModels as listOpenRouterModels,
  streamChat as streamOpenRouterChat
} from './openrouter'
import type { ChatRequest, StreamHandlers, StreamResult } from './types'

/** The catalog is composed here; each provider owns its discovery and transport. */
export async function listModels(force = false): Promise<ChatModel[]> {
  const [openrouter, codexModels] = await Promise.allSettled([
    listOpenRouterModels(force),
    codex.listModels(force)
  ])

  const models: ChatModel[] = []
  if (openrouter.status === 'fulfilled') {
    models.push(...openrouter.value.map((model) => ({ ...model, provider: 'openrouter' as const })))
  }
  if (codexModels.status === 'fulfilled') models.push(...codexModels.value)

  if (models.length) return models.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
  const errors = [openrouter, codexModels]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason))
  throw new Error(errors.join('\n'))
}

export function knownModel(id: string): ChatModel | null {
  if (providerForModel(id) === 'codex') return codex.knownModel(id)
  const model = knownOpenRouterModel(id)
  return model ? { ...model, provider: 'openrouter' } : null
}

export function providerStatus(): ProviderStatus {
  return { codex: codex.status() }
}

export function contextLimitFor(model: string): number | null {
  if (providerForModel(model) === 'codex') return codex.contextLimitFor(model)
  return knownOpenRouterModel(model)?.contextLength ?? null
}

export function streamChat(
  request: ChatRequest,
  handlers: StreamHandlers = {}
): Promise<StreamResult> {
  return providerForModel(request.model) === 'codex'
    ? codex.streamChat(request, handlers)
    : streamOpenRouterChat(request, handlers)
}

export function complete(request: Omit<ChatRequest, 'tools'>): Promise<StreamResult> {
  return providerForModel(request.model) === 'codex'
    ? codex.complete(request)
    : completeOpenRouter(request)
}

export { OpenRouterError } from './openrouter'
export type { ChatMessageParam, Citation, ContentPart, StreamResult, ToolParam } from './types'
