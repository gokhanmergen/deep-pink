/**
 * The one sentence of a reply worth reading first, found and then marked.
 *
 * Two halves that have to agree exactly. Candidates are read out of the reply
 * as it is drawn; the winner comes back as text and has to be found again in
 * the same drawing. Reading both from the rendered page rather than from the
 * markdown is what makes that reliable — the source is full of markers that
 * never reach the screen, so a sentence taken from it would carry asterisks
 * and backticks that no text node contains.
 *
 * The mark itself is a `Range` registered with the CSS Custom Highlight API,
 * not an element wrapped around anything. Nothing in the DOM React owns is
 * touched, a range crosses bold and links and inline code without caring, and
 * turning the highlight off is forgetting a range rather than re-rendering a
 * message.
 */

/** What a sentence can live inside. A sentence never spans two of these. */
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt'

/**
 * What is not prose, and so is not a sentence.
 *
 * The code block matters most and is easy to miss: its text is not only the
 * code but the language written above it and the word on its copy button, and
 * a walk that takes every text node cheerfully produces "so set:bashcopyon
 * the service" out of a paragraph that ran into one.
 */
const NOT_PROSE = '.codeblock, .chartblock, .docsblock, .katex, pre, code, button'

/** Below this a sentence is a fragment — a label, a lead-in, a list marker. */
const SHORTEST = 40

/** The name the stylesheet knows this highlight by. */
const REGISTRY = 'key-point'

interface Span {
  node: Text
  at: number
  len: number
}

/** Every text node of a block that is actually prose, in reading order. */
function proseOf(block: Element): Span[] {
  const spans: Span[] = []
  let at = 0
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT
      return node.parentElement?.closest(NOT_PROSE)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    }
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    spans.push({ node: text, at, len: text.nodeValue?.length ?? 0 })
    at += text.nodeValue?.length ?? 0
  }
  return spans
}

/** The sentence boundaries in a piece of text, as [start, end) pairs. */
function boundaries(text: string): [number, number][] {
  const out: [number, number][] = []
  // A full stop followed by space, and a hard line break: a soft break inside
  // a paragraph is a new line to the reader and reads as a new sentence.
  const ends = /[.!?](?=\s|$)|\n/g
  let from = 0
  let match: RegExpExecArray | null
  while ((match = ends.exec(text))) {
    out.push([from, match.index + 1])
    from = match.index + 1
  }
  if (from < text.length) out.push([from, text.length])
  return out
}

/** A sentence found in the page, with the range that covers it. */
export interface Candidate {
  text: string
  range: Range
}

/**
 * The sentences of one rendered reply, each with the range it occupies.
 *
 * Innermost blocks only: a list item holding a paragraph would otherwise be
 * read twice, once as itself and once as the paragraph inside it.
 */
export function sentencesIn(body: Element): Candidate[] {
  const found: Candidate[] = []

  for (const block of body.querySelectorAll(BLOCKS)) {
    if (block.querySelector(BLOCKS)) continue

    const spans = proseOf(block)
    if (!spans.length) continue

    const text = spans.map((span) => span.node.nodeValue ?? '').join('')
    const at = (offset: number): { node: Text; offset: number } | null => {
      for (const span of spans) {
        if (offset >= span.at && offset <= span.at + span.len) {
          return { node: span.node, offset: offset - span.at }
        }
      }
      return null
    }

    for (const [from, to] of boundaries(text)) {
      const raw = text.slice(from, to)
      const sentence = raw.trim()
      if (sentence.length < SHORTEST) continue

      const start = at(from + (raw.length - raw.trimStart().length))
      const end = at(to - (raw.length - raw.trimEnd().length))
      if (!start || !end) continue

      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      found.push({ text: sentence, range })
    }
  }

  return found
}

/**
 * Marks a sentence in a reply, and says whether it could be found.
 *
 * Every highlight in the app lives in one registry, keyed by the element it
 * belongs to, so a reply scrolling away or being rebuilt takes its own mark
 * with it and leaves everyone else's alone.
 */
const marked = new Map<Element, Range>()

function republish(): void {
  if (!('highlights' in CSS)) return
  const ranges = [...marked.values()]
  if (!ranges.length) {
    CSS.highlights.delete(REGISTRY)
    return
  }
  CSS.highlights.set(REGISTRY, new Highlight(...ranges))
}

export function markKeyPoint(body: Element, sentence: string | null): boolean {
  marked.delete(body)

  if (!sentence || !('highlights' in CSS)) {
    republish()
    return false
  }

  const hit = sentencesIn(body).find((candidate) => candidate.text === sentence)
  if (hit) marked.set(body, hit.range)
  republish()
  return Boolean(hit)
}

/** Forgets a reply's mark, when it is scrolled away or the thread is left. */
export function forgetKeyPoint(body: Element): void {
  if (!marked.delete(body)) return
  republish()
}

/**
 * Replies that have just finished and have not been asked about yet.
 *
 * The two halves of the trigger happen in different places. Whether to ask is
 * known when the reply lands, in the store; the sentences can only be read
 * once it is on screen, in the component. And it has to be the landing that
 * decides — asking whenever a reply is drawn would mean a request per reply
 * every time an old thread is opened, which is a bill for looking at
 * something you wrote last week.
 */
const wanted = new Set<string>()

export function wantKeyPoint(messageId: string): void {
  wanted.add(messageId)
}

/** True once, for whoever renders the reply first. */
export function takeKeyPointWish(messageId: string): boolean {
  return wanted.delete(messageId)
}
