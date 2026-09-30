import type { Message } from '@shared/types'

/** Keep a whole user turn so calls, results and their question stay together. */
export function compactionBoundary(messages: Message[], keep: number): number {
  let boundary = Math.max(0, messages.length - keep)
  while (boundary > 0 && messages[boundary].role !== 'user') boundary--
  return boundary
}
