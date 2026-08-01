import type { ImportSkipped, Role } from '@shared/types'

/**
 * Reads a ChatGPT data export (Settings → Data controls → Export data).
 *
 * The archive contains `conversations.json`: an array of conversations, each
 * holding a `mapping` of nodes keyed by id. That mapping is a TREE, not a list —
 * every edit or regenerate creates a sibling branch — and `current_node` points
 * at the leaf of the branch that was on screen. Walking parent links up from
 * that leaf and reversing gives the conversation as the user last saw it.
 *
 * Everything here is pure so it can be tested against real export shapes without
 * touching a database.
 */

export interface ParsedMessage {
  role: Role
  content: string
  createdAt: number
  model: string | null
  /** Asset ids referenced by the message, e.g. `file-ABC123`. */
  assets: string[]
}

export interface ParsedConversation {
  /** ChatGPT's conversation id, used to avoid importing twice. */
  sourceId: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ParsedMessage[]
}

export interface ParseReport {
  conversations: ParsedConversation[]
  /** Counts of what was deliberately left out, for an honest summary. */
  skipped: ImportSkipped
}

interface RawNode {
  id?: string
  parent?: string | null
  children?: string[]
  message?: RawMessage | null
}

interface RawMessage {
  id?: string
  author?: { role?: string; name?: string | null }
  create_time?: number | null
  content?: {
    content_type?: string
    parts?: unknown[]
    text?: string
    result?: string
  }
  metadata?: {
    model_slug?: string
    is_visually_hidden_from_conversation?: boolean
  }
  recipient?: string
}

interface RawConversation {
  id?: string
  conversation_id?: string
  title?: string | null
  create_time?: number | null
  update_time?: number | null
  current_node?: string | null
  mapping?: Record<string, RawNode>
}

/** Export timestamps are float seconds; everything here is milliseconds. */
function toMillis(seconds: number | null | undefined, fallback: number): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return fallback
  return Math.round(seconds * 1000)
}

/**
 * The path from the root to `current_node`, which is the branch that was visible
 * when the export was taken. Sibling branches — earlier edits and regenerates —
 * are deliberately dropped: importing them all would interleave alternate
 * realities into one transcript.
 */
function activeBranch(conversation: RawConversation): RawNode[] {
  const mapping = conversation.mapping ?? {}

  let leafId = conversation.current_node ?? null
  if (!leafId || !mapping[leafId]) {
    // Some exports omit current_node. Fall back to the node with no children
    // that has the latest timestamp — the end of the longest-lived branch.
    let best: { id: string; time: number } | null = null
    for (const [id, node] of Object.entries(mapping)) {
      if (node.children?.length) continue
      const time = node.message?.create_time ?? 0
      if (!best || time > best.time) best = { id, time }
    }
    leafId = best?.id ?? null
  }

  const chain: RawNode[] = []
  const seen = new Set<string>()
  let cursor = leafId

  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor)
    chain.push(mapping[cursor])
    cursor = mapping[cursor].parent ?? null
  }

  return chain.reverse()
}

const ROLES: Record<string, Role> = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
  tool: 'tool'
}

/**
 * Pulls the asset id out of a pointer or a filename.
 *
 * Pointers look like `file-service://file-ABC123`, and the scheme itself starts
 * with `file-`, so it has to be stripped first or it matches instead of the id.
 * Archive members look like `file-ABC123-original-name.png`.
 */
export function assetIdFrom(value: string): string | null {
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const match = /file[-_][A-Za-z0-9]{6,}/.exec(withoutScheme)
  return match ? match[0] : null
}

export interface ExtractedContent {
  text: string
  assets: string[]
}

/**
 * Flattens one message's content. ChatGPT uses several shapes: plain text,
 * code-interpreter source and output, and multimodal parts that reference
 * uploaded images by asset pointer.
 */
export function extractContent(message: RawMessage): ExtractedContent {
  const content = message.content
  if (!content) return { text: '', assets: [] }

  const assets: string[] = []
  const type = content.content_type ?? 'text'

  const collectPointer = (pointer: unknown): void => {
    if (typeof pointer !== 'string') return
    const id = assetIdFrom(pointer)
    if (id) assets.push(id)
  }

  if (type === 'code') {
    const source = typeof content.text === 'string' ? content.text : ''
    return { text: source ? `\`\`\`python\n${source}\n\`\`\`` : '', assets }
  }

  if (type === 'execution_output') {
    const output = typeof content.text === 'string' ? content.text : ''
    return { text: output ? `\`\`\`\n${output}\n\`\`\`` : '', assets }
  }

  if (type === 'tether_browsing_display' || type === 'tether_quote') {
    const quoted = typeof content.result === 'string' ? content.result : content.text
    return { text: typeof quoted === 'string' ? quoted : '', assets }
  }

  const parts = Array.isArray(content.parts) ? content.parts : []
  const pieces: string[] = []

  for (const part of parts) {
    if (typeof part === 'string') {
      if (part.trim()) pieces.push(part)
      continue
    }
    if (part && typeof part === 'object') {
      const record = part as Record<string, unknown>
      collectPointer(record.asset_pointer)
      if (typeof record.text === 'string' && record.text.trim()) pieces.push(record.text)
    }
  }

  return { text: pieces.join('\n\n'), assets }
}

export function parseExport(raw: unknown): ParseReport {
  const skipped = {
    hiddenOrSystem: 0,
    toolTraffic: 0,
    empty: 0,
    unreadableConversations: 0
  }

  // The file is normally an array; some exports wrap it in an object.
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { conversations?: unknown[] })?.conversations)
      ? ((raw as { conversations: unknown[] }).conversations as unknown[])
      : []

  const conversations: ParsedConversation[] = []

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      skipped.unreadableConversations++
      continue
    }
    const conversation = entry as RawConversation
    const sourceId = conversation.conversation_id ?? conversation.id
    if (!sourceId || !conversation.mapping) {
      skipped.unreadableConversations++
      continue
    }

    const createdAt = toMillis(conversation.create_time, Date.now())
    const messages: ParsedMessage[] = []

    for (const node of activeBranch(conversation)) {
      const message = node.message
      if (!message) continue

      const role = ROLES[message.author?.role ?? '']
      if (!role) continue

      // Hidden scaffolding, and the custom-instructions block ChatGPT injects.
      if (message.metadata?.is_visually_hidden_from_conversation || role === 'system') {
        skipped.hiddenOrSystem++
        continue
      }

      // Traffic between the model and its own tools: `recipient` is the tool
      // name rather than `all`. Faithful to keep, but unreadable in a transcript
      // that has no matching tool-call records.
      if (role === 'tool' || (message.recipient && message.recipient !== 'all')) {
        skipped.toolTraffic++
        continue
      }

      const { text, assets } = extractContent(message)
      if (!text.trim() && !assets.length) {
        skipped.empty++
        continue
      }

      messages.push({
        role,
        content: text,
        createdAt: toMillis(message.create_time, createdAt),
        model: message.metadata?.model_slug ?? null,
        assets
      })
    }

    if (!messages.length) {
      skipped.unreadableConversations++
      continue
    }

    conversations.push({
      sourceId,
      title: (conversation.title ?? '').trim() || 'Imported chat',
      createdAt,
      updatedAt: toMillis(conversation.update_time, createdAt),
      messages
    })
  }

  return { conversations, skipped }
}
