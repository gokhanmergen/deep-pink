/**
 * The code block the pointer is over, and its exact source.
 *
 * Every rendered block already carries a copy button, which is fine when the
 * hand is on the mouse and a nuisance when it is on the keyboard: reading down
 * a reply, finding the snippet you want and then having to travel to a 30-pixel
 * target in its corner is the one thing in the app that makes you aim.
 *
 * So the pointer says *which* and a key says *copy*.
 */

/**
 * Where the pointer was, rather than what it was over.
 *
 * This asked the document for `.codeblock:hover` instead, which reads well and
 * does not work: `:hover` is recomputed when the pointer moves, and a reply
 * still streaming replaces the elements underneath a pointer that is not
 * moving — so the block being pointed at could be a block the browser no
 * longer believed was hovered. Coordinates have no such problem. They are also
 * the whole of what has to be remembered: which element is at them is a
 * question worth asking at the moment the key is pressed, against the DOM as
 * it is then, rather than a stale answer cached on the way past.
 *
 * -1 means the pointer has not been seen yet — a session driven entirely from
 * the keyboard, where there is nothing to copy and nothing to report.
 */
let pointerX = -1
let pointerY = -1

/**
 * Starts watching, and returns the way to stop.
 *
 * One passive listener on the window rather than a pair on every block in the
 * transcript, and all it does is store two numbers — no lookups, no layout, no
 * allocation, on an event that fires hundreds of times a second.
 */
export function watchPointer(): () => void {
  const onMove = (event: PointerEvent): void => {
    pointerX = event.clientX
    pointerY = event.clientY
  }
  window.addEventListener('pointermove', onMove, { passive: true })
  return () => window.removeEventListener('pointermove', onMove)
}

/** A block that can be copied, and what it does about having been. */
export interface Block {
  /**
   * The text the block was built from.
   *
   * Highlighted code is a tree of spans, and reading the text back out of it
   * returns something very close to the original but not guaranteed to be it —
   * a trailing newline here, a soft-wrap artefact there. What is copied should
   * be what the model wrote, so the component hands over the string it
   * rendered rather than this reading it off the screen.
   */
  code: string
  /**
   * Says so on the block itself, or null for a block with nothing to say it
   * with.
   *
   * A rendered block has a copy button, and that button already knows how to
   * report a copy: it becomes the word "copied" for a moment. Doing it that
   * way rather than raising a toast means the answer appears on the thing you
   * were pointing at, which is where you are already looking — and it is the
   * same acknowledgement whether you reached for the button or the key, so
   * there is nothing extra to learn.
   */
  flash: (() => void) | null
}

/**
 * Every block on screen, keyed on the element showing it.
 *
 * Weak, so a block that scrolls out of the transcript and is unmounted takes
 * its entry with it. A long conversation would otherwise accumulate every
 * snippet it has ever shown.
 */
const blocks = new WeakMap<Element, Block>()

export function rememberBlock(element: Element | null, block: Block): void {
  if (element) blocks.set(element, block)
}

/**
 * The code under the pointer, or null if the pointer is not over any.
 *
 * `closest` is what makes the whole block the target rather than the text in
 * it: the language strip along the top, the copy button, the padding down the
 * sides and the code itself all sit inside the same element, so pointing at
 * any of them is pointing at the block.
 */
export function blockUnderPointer(): Block | null {
  if (pointerX < 0) return null

  const at = document.elementFromPoint(pointerX, pointerY)
  const element = at?.closest('.codeblock')
  if (!element) return null

  const known = blocks.get(element)
  if (known) return known

  /*
   * Blocks the app builds itself rather than rendering from a reply — a tool
   * call's arguments, the system prompt inspector — are plain `<pre>` and were
   * never registered. Their text is their source, and reading it is exact.
   * They have no copy button either, so there is nothing on them to flash and
   * the caller has to say it some other way.
   */
  const text = element.querySelector('pre')?.textContent
  return text === null || text === undefined ? null : { code: text, flash: null }
}
