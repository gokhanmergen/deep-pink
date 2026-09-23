import { COST_MARKERS } from '@shared/defaults'
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
    // The length rather than the text. A transcript read from disk leaves
    // traces behind until they are opened, so a reply that was *only* thinking
    // arrives with `reasoning` null — and testing the text would have called
    // it empty and dropped it from the conversation.
    !message.reasoningChars &&
    !message.reasoning &&
    !message.toolCalls?.length &&
    // A reply can be a picture and nothing else, and a picture is not nothing.
    // Models that draw answer this way routinely — the words are the caption,
    // and there may be none.
    //
    // Optional because this is asked of messages from more than one place: a
    // row read from the database always has the array, and a turn assembled
    // in flight or handed in by a caller may not. Throwing here takes the
    // whole transcript down rather than mis-drawing one reply.
    !message.attachments?.length &&
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
    // Cost markers — naming a thread, picking its key sentence — are
    // bookkeeping, not conversation.
    if (message.compactedInto && isCostMarker(message.compactedInto)) continue

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

/** Whether a `compacted_into` names a cost marker rather than a summary. */
function isCostMarker(into: string): boolean {
  return (COST_MARKERS as readonly string[]).includes(into)
}
