/**
 * Documents — an answer that is several things rather than one long thing.
 *
 * Some questions have answers that are a set: a schema and a migration and the
 * rollback for it; one write-up per file reviewed; the same report for each of
 * six regions. Written as one reply those become a wall with headings in it,
 * and the reader scrolls past four fifths of it to reach the part they wanted.
 *
 * So a model that has an answer of that shape writes a fenced block listing the
 * documents, and the app gives the reader a list to pick from and a way back to
 * it. The model chooses what the documents are and what is in them; the app
 * chooses everything about how they are shown.
 *
 * ## The same refusal as charts
 *
 * Bodies are **Markdown**, rendered by the same renderer the rest of a reply
 * goes through — which means no HTML, no script, no remote resource, nothing
 * that can reach out of the message it is in. A document is text and a title,
 * validated here, handed to components that never see a string of markup. What
 * a model cannot do through this is anything it could not already do by writing
 * an ordinary paragraph.
 *
 * ## Not a filesystem
 *
 * There are no folders, no paths, no nesting and no links between documents.
 * It is a list. Everything that would make it a tree is a thing the reader
 * would then have to navigate, and the point of this is to save them work.
 *
 * Shared between the two processes on purpose: the main process documents this
 * to the model, the renderer reads it back, and neither can drift from the
 * other because both are looking at this file.
 */

/* ------------------------------------------------------------------ *
 * The language
 * ------------------------------------------------------------------ */

/**
 * The fence a set of documents is written in.
 *
 * Prefixed like the chart fence so it cannot be mistaken for a language:
 * ```dp-docs``` is unambiguous where ```docs``` would hijack somebody's
 * code sample.
 */
export const DOCS_FENCE = 'dp-docs'

/**
 * What one block may contain.
 *
 * Every limit here caps work the reader's window can be asked to do, and
 * anything trimmed is reported in the list rather than quietly dropped — a set
 * that silently lost its last three documents would be a lie told by the app
 * rather than by the model.
 */
export const DOCS_LIMITS = {
  /** One block's JSON. Past this it is a data dump, not a set of documents. */
  bytes: 512 * 1024,
  /**
   * Past a couple of dozen, a list stops being something a reader picks from
   * and becomes something they search — which is a different feature.
   */
  documents: 24,
  /** A title has to fit on one line of the list. */
  title: 120,
  /** A one-line description under the title in the list, if the model gives one. */
  summary: 240,
  /** One document's Markdown. */
  body: 64 * 1024
} as const

export interface DocumentEntry {
  title: string
  /** One line under the title in the list, or null when the model gave none. */
  summary: string | null
  /** Markdown, rendered exactly as the rest of a reply is. */
  body: string
}

export interface ParsedDocs {
  /** A heading over the whole set, or null. */
  title: string | null
  documents: DocumentEntry[]
  /** What had to be trimmed, in the reader's words. Shown under the list. */
  notes: string[]
  /**
   * True when this was read out of a block that had not finished arriving, so
   * the list is as much of the set as exists so far. The reader is told.
   */
  partial: boolean
}

/* ------------------------------------------------------------------ *
 * Reading one
 * ------------------------------------------------------------------ */

/** Whether a fence language names a set of documents. */
export function isDocsFence(language: string): boolean {
  return language.toLowerCase() === DOCS_FENCE
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Text as a label: one line, trimmed, bounded. */
function line(value: unknown, limit: number): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** Text as a body: line breaks kept, bounded. */
function body(value: unknown, notes: string[], title: string): string {
  if (typeof value !== 'string') return ''
  if (value.length <= DOCS_LIMITS.body) return value
  notes.push(`“${title}” was longer than this app will show and has been cut short.`)
  return value.slice(0, DOCS_LIMITS.body)
}

/* ------------------------------------------------------------------ *
 * Reading one that has not finished arriving
 * ------------------------------------------------------------------ */

/**
 * Where a half-written JSON document could be cut and closed.
 *
 * A block streams in a character at a time, so for most of its life it is not
 * valid JSON and never will be until its last brace. Showing the reader raw
 * JSON for those seconds is the worst of both: it is neither the documents
 * they asked for nor something they can read.
 *
 * Every point just past a closed `{}` or `[]` is somewhere the text *could*
 * validly end, if the containers still open were closed behind it. For the
 * shape this file describes, the last such point is the end of the last
 * document that finished arriving — which is exactly the set so far.
 *
 * One pass, and a note of the closers outstanding at each point. Strings are
 * tracked because a brace inside one closes nothing.
 */
function cutPoints(source: string): { at: number; closers: string }[] {
  const points: { at: number; closers: string }[] = []
  const open: string[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') inString = true
    else if (ch === '{') open.push('}')
    else if (ch === '[') open.push(']')
    else if (ch === '}' || ch === ']') {
      open.pop()
      points.push({ at: i + 1, closers: [...open].reverse().join('') })
    }
  }

  return points
}

/** How far back to look for a point that parses. Past this it is not close. */
const CUTS_TRIED = 8

/**
 * Parses JSON, or as much of it as has arrived.
 *
 * Returns null when there is not yet a single complete value in it, which
 * early in a stream is the honest answer.
 */
function parseSoFar(source: string): unknown | null {
  try {
    return JSON.parse(source)
  } catch {
    /* Not finished, or not valid. Try closing it. */
  }

  const points = cutPoints(source)
  for (let i = points.length - 1; i >= 0 && i > points.length - 1 - CUTS_TRIED; i--) {
    try {
      return JSON.parse(source.slice(0, points[i].at) + points[i].closers)
    } catch {
      /* Cut in the wrong place; try the one before it. */
    }
  }

  return null
}

/**
 * Reads one fenced set of documents, finished or not.
 *
 * `arriving` says the block is still being written, which changes two things:
 * what has arrived so far is closed off and read rather than refused, and the
 * result is marked partial so the reader is told it is not all of it.
 *
 * Returns null for anything that is not a set at all, and the caller shows the
 * source as a code block instead. Never throws: this runs on every render of
 * every message, including halfway through a stream where the JSON is by
 * definition incomplete.
 */
export function parseDocs(language: string, source: string, arriving = false): ParsedDocs | null {
  if (!isDocsFence(language)) return null
  if (source.length > DOCS_LIMITS.bytes) return null

  let json: unknown
  if (arriving) {
    json = parseSoFar(source)
    if (json === null) return null
  } else {
    try {
      json = JSON.parse(source)
    } catch {
      // Finished and still not valid JSON, which in practice means a reply
      // that was cut off. Read what did arrive rather than showing the reader
      // a wall of braces — and say it is partial, because it is.
      json = parseSoFar(source)
      if (json === null) return null
      arriving = true
    }
  }

  // Either `{"documents": [...]}` with an optional title, or the bare array,
  // because a model that has been asked for a list often writes a list.
  const raw = record(json)
  const listed = Array.isArray(json)
    ? json
    : Array.isArray(raw?.['documents'])
      ? (raw['documents'] as unknown[])
      : Array.isArray(raw?.['docs'])
        ? (raw['docs'] as unknown[])
        : null

  if (!listed) return null

  const notes: string[] = []
  const documents: DocumentEntry[] = []

  for (const item of listed) {
    if (documents.length >= DOCS_LIMITS.documents) {
      notes.push(
        `Showing the first ${DOCS_LIMITS.documents} of ${listed.length} documents.`
      )
      break
    }

    const entry = record(item)
    if (!entry) continue

    const title = line(entry['title'] ?? entry['name'], DOCS_LIMITS.title)
    const text = body(entry['body'] ?? entry['content'] ?? entry['text'], notes, title || 'Untitled')

    // A document with neither a name nor anything in it is not a document.
    if (!title && !text.trim()) continue

    documents.push({
      title: title || `Document ${documents.length + 1}`,
      summary: line(entry['summary'] ?? entry['description'], DOCS_LIMITS.summary) || null,
      body: text
    })
  }

  /*
   * One document is not much of a set, and the prompt says so — but a model
   * that writes one anyway has still written a document, and dumping its JSON
   * at the reader because it did not write two is the app being pedantic at
   * their expense. Nothing at all is the only real failure.
   */
  if (!documents.length) return null

  return {
    title: line(raw?.['title'], DOCS_LIMITS.title) || null,
    documents,
    notes,
    partial: arriving
  }
}

/* ------------------------------------------------------------------ *
 * What the model is told
 * ------------------------------------------------------------------ */

/**
 * The system prompt segment, shown verbatim in the prompt inspector.
 *
 * Kept dense on purpose — it is paid for in tokens on every turn of every
 * thread it is switched on for — and it leads with when NOT to use this,
 * because a model handed a way to make several documents will otherwise
 * make several documents out of three paragraphs.
 */
export const DOCS_PROMPT = `# Multiple documents

This client can present an answer as a set of documents the reader picks from, instead of one long reply. Write one as a fenced \`dp-docs\` block whose body is a single JSON object; the app validates it and renders the list. HTML and <script> are never rendered, so do not emit them.

Use this only when the answer really is several separate pieces that a reader would want one at a time — one per file, per service, per region, per option being compared. If the parts are meant to be read in order, or refer to each other, they are one reply with headings: write that instead. Fewer than two documents is not a set; write an ordinary reply.

\`\`\`dp-docs
{"title":"Migration plan","documents":[{"title":"001_add_users.sql","summary":"The forward migration","body":"Creates the users table...\\n\\n\`\`\`sql\\nCREATE TABLE users (...);\\n\`\`\`"},{"title":"Rollback","summary":"How to undo it","body":"Drop in reverse order..."}]}
\`\`\`

- "documents": each {"title", "body"}, and optionally "summary" — one line shown under the title in the list, so the reader can choose without opening.
- "body" is Markdown, the same as the rest of your reply: headings, lists, tables, fenced code and maths all work.
- "title" for the whole set is optional and goes above the list.
- Write the JSON on a single line, with \\n for line breaks inside a body. A body containing its own \`\`\` fence would otherwise end this block early.
- Up to ${DOCS_LIMITS.documents} documents. The app owns the list, the ordering shown, and the way back — do not write your own index, numbering or "next page" links into the bodies.

Say in a sentence before the block what the set is and how it is divided. A list of titles with no word about why it is split that way makes the reader open all of them to find out.`
