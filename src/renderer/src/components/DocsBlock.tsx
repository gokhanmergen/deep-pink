import { Component, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Code2, Eye, FileText } from 'lucide-react'
import type { ParsedDocs } from '@shared/docs'
import { ICON } from '../icons'
import { CodeBlock } from './CodeBlock'
// Markdown imports this back: a document's body is Markdown, and Markdown may
// contain a set of documents. Both references are inside component bodies
// rather than at module scope, so neither is read before the other is defined.
import { Markdown } from './Markdown'

/**
 * A set of documents in a reply: the list, the one being read, and the way
 * back to the list from the middle of it.
 *
 * Two states and nothing else. The list is where you arrive, because a set
 * nobody has read yet has no better opening document than the first one they
 * choose. Opening one replaces the list; the way back is in the header of what
 * you are reading rather than above it, so it is still there when you have
 * scrolled into the document — which is exactly when you want it.
 *
 * Deliberately not tabs. A strip of titles across the top has to truncate them
 * to fit, which is the one thing the list must not do: titles are how the
 * reader chooses, and a set of six documents called "Migration 001 — add…"
 * is a set of six identical tabs.
 */

interface Props {
  parsed: ParsedDocs
  /** The JSON as it arrived, for the source view and the fallback. */
  source: string
  codeTheme: string
  /**
   * Whether the reply this sits in is still being written.
   *
   * Not the same question as whether the set is complete, and conflating them
   * is how a block that was cut off ends up claiming forever that more is on
   * the way. Partial says "this is not all of it"; this says "and more is
   * coming". Only both together are worth a live indicator.
   */
  streaming: boolean
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function DocsBlock({ parsed, source, codeTheme, streaming }: Props): React.JSX.Element {
  /**
   * Which document is open, or null for the list.
   *
   * Deliberately not reset as more documents arrive: somebody who opened the
   * first one while the rest were still being written should not be thrown
   * back to the list every time another lands.
   */
  const [open, setOpen] = useState<number | null>(null)
  const [showSource, setShowSource] = useState(false)

  const fallback = <CodeBlock code={source} lang="json" theme={codeTheme} />
  const documents = parsed.documents
  const reading = open === null ? null : (documents[open] ?? null)

  const head = (
    <div className="docsblock__head">
      {reading ? (
        <>
          {/* First in the header and not beside the title, so it is in the
              same place whichever document is open and whatever it is called. */}
          <button
            className="docsblock__back"
            onClick={() => setOpen(null)}
            title="Back to the list"
            type="button"
          >
            <ArrowLeft {...ICON} />
            All documents
          </button>
          <div className="docsblock__title" title={reading.title}>
            {reading.title}
          </div>
        </>
      ) : (
        <>
          <FileText className="docsblock__mark" {...ICON} />
          <div className="docsblock__title">
            {parsed.title ?? `${documents.length} document${documents.length === 1 ? '' : 's'}`}
          </div>
        </>
      )}

      <div className="docsblock__spacer" />

      {/* Said rather than left to be noticed: a list that is still growing
          looks exactly like a list that is finished and short. Only while it
          really is growing — a set that was cut off is not arriving, it has
          arrived, and saying otherwise is the app waiting for something that
          is never coming. That one is a note under the list instead. */}
      {parsed.partial && streaming && (
        <span className="docsblock__arriving">still arriving…</span>
      )}

      {reading && (
        // Stepping between documents without going back to the list, for a set
        // somebody is reading through rather than picking from.
        <div className="docsblock__step">
          <button
            className="docsblock__arrow"
            disabled={open === 0}
            onClick={() => setOpen((at) => Math.max((at ?? 0) - 1, 0))}
            title="Previous document"
            type="button"
          >
            <ChevronLeft {...ICON} />
          </button>
          <span className="docsblock__count">
            {(open ?? 0) + 1} of {documents.length}
          </span>
          <button
            className="docsblock__arrow"
            disabled={open === documents.length - 1}
            onClick={() => setOpen((at) => Math.min((at ?? 0) + 1, documents.length - 1))}
            title="Next document"
            type="button"
          >
            <ChevronRight {...ICON} />
          </button>
        </div>
      )}

      {/* What the model actually wrote is always one click away, for the same
          reason it is on a chart: this is somebody else's text, presented. */}
      <button
        className="docsblock__source"
        onClick={() => setShowSource((on) => !on)}
        title={showSource ? 'Show the documents' : 'Show what the model wrote'}
        aria-pressed={showSource}
        type="button"
      >
        {showSource ? <Eye {...ICON} /> : <Code2 {...ICON} />}
      </button>
    </div>
  )

  if (showSource) {
    return (
      <div className="docsblock">
        {head}
        {fallback}
      </div>
    )
  }

  return (
    <div className="docsblock">
      {head}

      <Boundary fallback={fallback}>
        {reading ? (
          <div className="docsblock__body">
            {/* `allowDocs={false}`: a document's body is Markdown like any
                other, but a set of documents inside a document is not a thing
                this offers, and nothing should be able to nest it. */}
            <Markdown content={reading.body} codeTheme={codeTheme} allowDocs={false} />
          </div>
        ) : (
          <div className="docsblock__list">
            {documents.map((document, at) => (
              <button
                className="docsblock__item"
                key={`${at}:${document.title}`}
                onClick={() => setOpen(at)}
                type="button"
              >
                <span className="docsblock__index">{at + 1}</span>
                <span className="docsblock__itemtext">
                  <span className="docsblock__itemtitle">{document.title}</span>
                  {document.summary && (
                    <span className="docsblock__itemsummary">{document.summary}</span>
                  )}
                </span>
                <ChevronRight className="docsblock__go" {...ICON} />
              </button>
            ))}
          </div>
        )}
      </Boundary>

      {/* Under the list rather than under whichever document happens to be
          open: what was trimmed is a fact about the set. */}
      {open === null && (
        <>
          {/* The reply ended before the set did. Worth saying plainly: a list
              of two where the model meant to write five is not something a
              reader can tell by looking at it. */}
          {parsed.partial && !streaming && (
            <div className="docsblock__note">
              This reply stopped before the set finished — {documents.length} of them arrived.
            </div>
          )}
          {parsed.notes.map((note) => (
            <div className="docsblock__note" key={note}>
              {note}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
