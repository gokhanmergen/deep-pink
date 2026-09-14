import type { Message } from '@shared/types'

/**
 * Roughly how tall a message will be, before anything has been laid out.
 *
 * This is what `contain-intrinsic-size` is given, and it matters far more than
 * a placeholder height sounds like it should. A message off screen is never
 * laid out — that is the whole point of `content-visibility` — so the guess is
 * not a guess that gets corrected in a moment. For everything above the
 * viewport it is simply what the transcript believes, for as long as the
 * reader does not scroll there.
 *
 * Every measurement the view is positioned by is made against those beliefs.
 * The stylesheet used to say 220 pixels for all of them, which on a
 * conversation of long replies is out by a factor of five or six — so "the top
 * of the last exchange" was computed as a fifth of the way down the real
 * transcript, the scrollbar claimed a document a fifth of the true length, and
 * the scroll that was supposed to reach the last exchange was clamped to
 * somewhere near the middle. The landing did not drift; it was aimed wrong.
 *
 * None of this needs to be right. It needs to be the same order of magnitude,
 * which one number for every message in every conversation cannot be and a
 * number read off the message's own length always is.
 */

/** Room for the head row, the margin under it, and the usual two of padding. */
const FURNITURE = 64

/** What the reasoning line adds, collapsed — which is how it starts. */
const REASONING_LINE = 30

/** A line of prose at the default size, near enough. */
const LINE = 22

/**
 * How wide a line of text is in characters.
 *
 * Derived from the measure the reader chose rather than assumed, because the
 * setting exists and doubling the width halves the number of lines. Eight
 * pixels a character is about right for the interface font at fourteen.
 */
function charsPerLine(chatWidth: number): number {
  return Math.max(Math.round(chatWidth / 8), 20)
}

/**
 * A message's likely height in pixels.
 *
 * Deliberately crude. Every refinement — code blocks do not wrap, tables are
 * denser, a heading is taller — trades accuracy on one conversation for
 * accuracy on another, and what is being avoided is being wrong by a multiple
 * rather than by a third.
 */
export function estimateHeight(message: Message, chatWidth: number): number {
  const width = charsPerLine(chatWidth)

  let lines = 0
  for (const line of message.content.split('\n')) {
    lines += Math.max(1, Math.ceil(line.length / width))
  }

  let height = FURNITURE + lines * LINE
  if (message.reasoningChars > 0) height += REASONING_LINE

  // A picture is drawn at its own shape, up to the width of the column.
  for (const file of message.attachments) {
    if (file.kind !== 'image') {
      height += REASONING_LINE
      continue
    }
    const scale = file.width ? Math.min(1, chatWidth / file.width) : 1
    height += Math.min((file.height ?? 240) * scale, 360) + 12
  }

  // Bounded at both ends: a one-word reply still occupies a row, and a guess
  // of forty thousand pixels makes a scrollbar that is its own kind of wrong.
  return Math.min(Math.max(Math.round(height), 72), 12_000)
}

/** The same, for the several messages a single assistant turn is drawn from. */
export function estimateTurnHeight(messages: Message[], chatWidth: number): number {
  const total = messages.reduce((sum, message) => sum + estimateHeight(message, chatWidth), 0)
  return Math.min(total, 24_000)
}
