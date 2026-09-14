import { useMemo } from 'react'

/**
 * A lot of plain text, laid out only where it is being looked at.
 *
 * A `<pre>` is one text node, and the browser must lay out every line of it to
 * know how tall it is — before it can draw the first one, and whether or not
 * the box it sits in shows twenty lines or twelve thousand. A half-megabyte
 * attachment is twelve thousand lines of wrapped monospace, and that is
 * seconds of layout for a panel four hundred pixels tall.
 *
 * So the text is cut into blocks and each block is told it may be skipped.
 * `content-visibility: auto` means a block off screen is not laid out at all;
 * `contain-intrinsic-size: auto` means the browser guesses its height until it
 * has measured it once, and then remembers the real one — so the scrollbar
 * settles as you move rather than breathing. It is the same arrangement the
 * transcript uses for messages, and for the same reason.
 *
 * Nothing is hidden and nothing is truncated: every line is present, findable
 * and selectable. What changes is when the work of drawing it happens.
 */

/**
 * Lines to a block.
 *
 * Small enough that a block is cheap to lay out, large enough that a long file
 * is not thousands of elements — twelve thousand lines is sixty-one of these.
 */
const LINES_PER_BLOCK = 200

/**
 * Below this, one `<pre>` is the right answer.
 *
 * Splitting has its own cost, and a tool result of forty lines was never the
 * problem. This only earns its keep where there is enough text for the layout
 * to be felt.
 */
const WORTH_SPLITTING = 400

/** Roughly a wrapped line of 12px monospace. `auto` corrects it after one pass. */
const LINE_HEIGHT = 18

export function LongText({ text }: { text: string }): React.JSX.Element {
  const blocks = useMemo(() => {
    const lines = text.split('\n')
    if (lines.length <= WORTH_SPLITTING) return null

    const out: string[] = []
    for (let i = 0; i < lines.length; i += LINES_PER_BLOCK) {
      out.push(lines.slice(i, i + LINES_PER_BLOCK).join('\n'))
    }
    return out
  }, [text])

  if (!blocks) return <pre>{text}</pre>

  return (
    <pre>
      {blocks.map((block, index) => (
        /*
         * A block element rather than a span, because containment is something
         * only a block can have. The line that separated one chunk from the
         * next is the break between these, which is why the chunks are joined
         * without their trailing newline — putting it back would double every
         * two-hundredth line.
         */
        <div
          key={index}
          className="longtext__block"
          style={{ containIntrinsicSize: `auto ${block.split('\n').length * LINE_HEIGHT}px` }}
        >
          {block}
        </div>
      ))}
    </pre>
  )
}
