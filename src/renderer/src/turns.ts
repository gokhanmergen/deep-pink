import type { Message } from '@shared/types'

/**
 * The transcript is stored as one row per API message, because that is what the
 * provider needs to be sent back. A turn that uses tools therefore spans
 * several rows: the reply that asked for the tool, the tool's result, and the
 * reply that follows it.
 *
 * Reading that as three separate "ASSISTANT" blocks is wrong — it is one
 * answer, with work shown in the middle. This groups the rows back into the
 * turns a reader recognises.
 */

export type Block =
  | { kind: 'message'; id: string; message: Message }
  | { kind: 'turn'; id: string; messages: Message[] }

/** True when a message would render as nothing at all. */
export function isEmptyAssistantMessage(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    !message.content &&
    !message.reasoning &&
    !message.toolCalls?.length &&
    !message.error &&
    message.status !== 'streaming'
  )
}

export function groupIntoTurns(messages: Message[]): Block[] {
  const blocks: Block[] = []
  let run: Message[] = []

  const flush = (): void => {
    // A run of nothing but empty placeholders is not a turn.
    if (run.some((m) => !isEmptyAssistantMessage(m))) {
      blocks.push({ kind: 'turn', id: run[0].id, messages: run })
    }
    run = []
  }

  for (const message of messages) {
    // Cost markers for thread naming are bookkeeping, not conversation.
    if (message.compactedInto === 'title') continue

    if (message.role === 'assistant' || message.role === 'tool') {
      run.push(message)
      continue
    }

    if (run.length) flush()
    blocks.push({ kind: 'message', id: message.id, message })
  }

  if (run.length) flush()
  return blocks
}
