/**
 * The code block the pointer is over, and its exact source.
 *
 * Every rendered block already carries a copy button, which is fine when the
 * hand is on the mouse and a nuisance when it is on the keyboard: reading down
 * a reply, finding the snippet you want and then having to travel to a 30-pixel
 * target in its corner is the one thing in the app that makes you aim.
 *
 * So the pointer says *which* and a key says *copy*. `:hover` is what makes
 * that work without tracking anything: the browser already knows what the
 * pointer is over, it keeps knowing while the mouse sits still, and asking it
 * costs one selector at the moment the key is pressed rather than a listener on
 * every block in the transcript.
 */

/**
 * The source each block was built from, keyed on the element showing it.
 *
 * Highlighted code is a tree of spans, and reading the text back out of it
 * returns something very close to the original but not guaranteed to be it —
 * a trailing newline here, a soft-wrap artefact there. What was copied should
 * be what the model wrote, so the component hands over the string it rendered
 * and this remembers it.
 *
 * Weak, so a block that scrolls out of the transcript and is unmounted takes
 * its entry with it. A long conversation would otherwise accumulate every
 * snippet it has ever shown.
 */
const sources = new WeakMap<Element, string>()

export function rememberCode(element: Element | null, code: string): void {
  if (element) sources.set(element, code)
}

/**
 * The code under the pointer, or null if the pointer is not over any.
 *
 * `:hover` matches every ancestor in the chain, so a block inside a document
 * set matches the outer box as well as itself. The last one is the innermost,
 * which is the one being pointed at.
 */
export function codeUnderPointer(): string | null {
  const hovered = document.querySelectorAll('.codeblock:hover')
  const block = hovered[hovered.length - 1]
  if (!block) return null

  const known = sources.get(block)
  if (known !== undefined) return known

  /*
   * Blocks the app builds itself rather than rendering from a reply — a tool
   * call's arguments, the system prompt inspector — are plain `<pre>` and were
   * never registered. Their text is their source, and reading it is exact.
   */
  return block.querySelector('pre')?.textContent ?? null
}
