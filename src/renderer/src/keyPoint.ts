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
 * The mark is drawn rather than applied. A `Range` finds where the sentence
 * is and reports a rectangle per line it covers; the reply renders a band over
 * each. Nothing in the DOM React owns is touched and a range crosses bold,
 * links and inline code without caring.
 *
 * Drawn rather than set as a highlight because a highlighter is a shape. The
 * CSS Custom Highlight API can colour text and its background and almost
 * nothing else — no rounded ends, no tilt, no glow, and no way to make the
 * stroke arrive across the line — and all of those are what separate a marker
 * pen from a selection.
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
 * One line's worth of highlighter, as a box to draw.
 *
 * A sentence that wraps is several of these — a pen crossing three lines
 * makes three strokes, not one tall rectangle — which is why this is per
 * client rect rather than per range.
 */
export interface Stroke {
  left: number
  top: number
  width: number
  height: number
  /** Milliseconds before this line is drawn, so the pen crosses them in turn. */
  delay: number
}

/** Rects within this many pixels of each other are the same line of text. */
const SAME_LINE = 3

/**
 * One box per line, out of the many a range reports.
 *
 * `getClientRects` gives a rectangle per *inline box*, not per line, so every
 * bold run, link and piece of inline code inside the sentence starts another
 * one. A sentence of eleven such fragments was eleven separate strokes, each
 * with its own tilt and rounded ends and its own moment of being drawn — a row
 * of disconnected blobs rather than a pen crossing the line. Merged by the
 * line they sit on, a stroke runs through the bold words instead of stopping
 * at them.
 */
function perLine(rects: DOMRect[]): { left: number; top: number; right: number; bottom: number }[] {
  const lines: { left: number; top: number; right: number; bottom: number }[] = []

  for (const rect of rects) {
    const line = lines.find((seen) => Math.abs(seen.top - rect.top) <= SAME_LINE)
    if (!line) {
      lines.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
      continue
    }
    line.left = Math.min(line.left, rect.left)
    line.right = Math.max(line.right, rect.right)
    line.top = Math.min(line.top, rect.top)
    line.bottom = Math.max(line.bottom, rect.bottom)
  }

  return lines.sort((a, b) => a.top - b.top)
}

/**
 * How far the band reaches past the text it covers.
 *
 * Enough to read as a shape holding the words rather than a rule struck
 * through them, and no more. This was three times as much, with the stroke
 * running on past the last word and leaning a third of a degree — a marker
 * pen, which turned out to look like a marker pen: loud, and drawn by
 * somebody in a hurry.
 */
const PAD_Y = 2
const PAD_X = 4

/**
 * The same sentence, whatever it is wearing.
 *
 * Exactly, first. Then without the markdown, because two of the three ways a
 * sentence can be chosen hand back something written rather than something
 * read: a model told to copy a sentence verbatim copies it out of its own
 * reply, asterisks and backticks and all, and none of those characters exist
 * in the text on the page. Jev is given the rendered sentences and so returns
 * one, but the other two are not, and a highlight that silently never
 * appeared for them would look like the feature simply not working.
 */
function bare(text: string): string {
  return text.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim()
}

function match(candidates: Candidate[], sentence: string): Candidate | undefined {
  const exact = candidates.find((candidate) => candidate.text === sentence)
  if (exact) return exact

  const wanted = bare(sentence)
  if (!wanted) return undefined
  return candidates.find((candidate) => bare(candidate.text) === wanted)
}

/**
 * Where to draw the highlighter over a reply, or nothing if none of the
 * sentences is on this page.
 *
 * Positions are relative to the body, so the strokes move with the text and
 * only need working out again when the text reflows.
 *
 * Level, evenly rounded and the same on every line. The first version leaned
 * each line a third of a degree, gave it elliptical ends and ran it on past
 * the last word — an actual marker pen, which read as exactly that: loud, and
 * drawn in a hurry. What is wanted is the quiet rounded panel Google puts
 * behind the answer in an AI Overview: unmistakable because nothing else on
 * the page has one, not because it shouts.
 */
export function strokesFor(body: Element, sentences: string[]): Stroke[] {
  if (!sentences.length) return []

  /*
   * Read once, matched against each.
   *
   * Walking the reply is the expensive half, and a reply with three sentences
   * marked is still one reply. Sentences that cannot be found are simply not
   * drawn — a model that reworded the one it named leaves the others marked
   * rather than losing all of them.
   */
  const candidates = sentencesIn(body)
  const found = sentences
    .map((sentence) => match(candidates, sentence))
    .filter((hit): hit is Candidate => Boolean(hit))
  if (!found.length) return []

  const base = body.getBoundingClientRect()
  const strokes: Stroke[] = []

  /*
   * Lines are merged within a sentence and never across two.
   *
   * Merging everything by the line it sits on is what one sentence needs —
   * bold runs and links otherwise each start their own box. Doing it across
   * sentences joins two of them that happen to share a line, and paints a
   * band straight through whatever was written between them.
   */
  for (const hit of found) {
    const rects = [...hit.range.getClientRects()].filter((rect) => rect.width > 1)
    for (const rect of perLine(rects)) {
      strokes.push({
        left: Math.max(rect.left - base.left - PAD_X, 0),
        top: rect.top - base.top - PAD_Y,
        width: Math.max(
          Math.min(rect.right - base.left + PAD_X, base.width) -
            Math.max(rect.left - base.left - PAD_X, 0),
          0
        ),
        height: rect.bottom - rect.top + PAD_Y * 2,
        // Drawn in the order they are read, whichever sentence they belong to.
        delay: strokes.length * 70
      })
    }
  }

  return strokes
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
