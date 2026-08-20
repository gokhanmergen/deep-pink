/**
 * Barrel of everything under test. Bundled once by scripts/run-tests.mjs so the
 * test files can require a single CommonJS artifact from inside Electron.
 */
export { getDb } from '@/db/index'
export * as repo from '@/db/repo'
export { streamChat, OpenRouterError } from '@/providers/openrouter'
export { toChatParams } from '@/chat/engine'
export { assembleContext, estimateTokens } from '@/chat/prompt'
export { htmlToText, runWebFetch, runWebSearch } from '@/tools/web'
export * as attachments from '@/attachments'
export * as chatgpt from '@/import/chatgpt'
export * as importer from '@/import/index'
export * as repoTools from '@/tools/repo'
