import { isValidElement, memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { CHART_FENCE, isChartFence, parseChart, type ParsedChart } from '@shared/charts'
import { DOCS_FENCE, isDocsFence, parseDocs, type ParsedDocs } from '@shared/docs'
import { useStore } from '../store'
import { remarkOnlyPlausibleMath } from '../markdownMath'
import { FileText } from 'lucide-react'
import { ICON } from '../icons'
import { CodeBlock } from './CodeBlock'
import { ChartBlock } from './ChartBlock'
import { DocsBlock } from './DocsBlock'

interface Props {
  content: string
  codeTheme: string
  /**
   * Whether this text is still arriving. A chart is invalid JSON right up until
   * its last brace, so nothing is called broken while it is being typed.
   */
  streaming?: boolean
  /**
   * False inside a document, so a set of documents cannot contain a set of
   * documents. This is a list, and a list of lists is the filesystem it is
   * deliberately not.
   */
  allowDocs?: boolean
}

function childText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(childText).join('')
  if (isValidElement(node)) {
    return childText((node.props as { children?: ReactNode }).children)
  }
  return ''
}

/**
 * Parsed charts, keyed by their source.
 *
 * A streaming reply re-renders on every chunk and each render re-reads every
 * block in the message, so parsing is memoised on the text itself. Bounded,
 * because a long thread would otherwise hold every version of every half-typed
 * chart that ever streamed through it.
 */
const parsed = new Map<string, ParsedChart | null>()

function readChart(source: string): ParsedChart | null {
  const hit = parsed.get(source)
  if (hit !== undefined) return hit

  const result = parseChart(CHART_FENCE, source)
  if (parsed.size > 300) parsed.clear()
  parsed.set(source, result)
  return result
}

/** The same memo for the same reason, over a much larger body of text. */
const parsedDocs = new Map<string, ParsedDocs | null>()

function readDocs(source: string, arriving: boolean): ParsedDocs | null {
  /*
   * Not memoised while the block is still being written: every chunk makes the
   * source a string nothing has ever seen, so a cache would only fill. The
   * work per chunk is a failed parse, one pass to find where it could be cut,
   * and a parse of the part before that — three passes over a block that is
   * usually a few kilobytes.
   */
  if (arriving) return parseDocs(DOCS_FENCE, source, true)

  const hit = parsedDocs.get(source)
  if (hit !== undefined) return hit

  const result = parseDocs(DOCS_FENCE, source)
  if (parsedDocs.size > 100) parsedDocs.clear()
  parsedDocs.set(source, result)
  return result
}

/** Whether this thread draws charts: its own answer, else the global one. */
function useCharts(): boolean {
  return useStore((state) => {
    const thread = state.threads.find((t) => t.id === state.activeThreadId)
    return thread?.config.chartsEnabled ?? state.settings?.chartsEnabled ?? false
  })
}

/** The same question for sets of documents. */
function useDocs(): boolean {
  return useStore((state) => {
    const thread = state.threads.find((t) => t.id === state.activeThreadId)
    return thread?.config.docsEnabled ?? state.settings?.docsEnabled ?? false
  })
}

/**
 * GitHub-flavoured Markdown, LaTeX via KaTeX ($…$ and $$…$$), syntax
 * highlighted code blocks, and — when the thread has them switched on — the
 * charts documented in `@shared/charts`.
 */
export const Markdown = memo(function Markdown({
  content,
  codeTheme,
  streaming = false,
  allowDocs = true
}: Props): React.JSX.Element {
  const chartsOn = useCharts()
  const docsOn = useDocs() && allowDocs

  return (
    <div className="md">
      <ReactMarkdown
        // `remarkOnlyPlausibleMath` runs after `remarkMath`, on what it made.
        remarkPlugins={[remarkGfm, remarkMath, remarkOnlyPlausibleMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          pre({ children }) {
            const child = Array.isArray(children) ? children[0] : children
            if (isValidElement(child)) {
              const props = child.props as { className?: string; children?: ReactNode }
              const lang = /language-([\w-]+)/.exec(props.className ?? '')?.[1] ?? 'text'
              const code = childText(props.children).replace(/\n$/, '')

              // A chart that is switched off, still streaming, or simply not
              // valid stays a code block. Nothing is ever hidden because it
              // failed to parse.
              if (chartsOn && isChartFence(lang)) {
                const chart = readChart(code)
                if (chart) {
                  return <ChartBlock parsed={chart} source={code} codeTheme={codeTheme} />
                }

                // Finished and still not valid: say so, rather than leave the
                // reader wondering why one block came out as JSON.
                if (!streaming) {
                  return (
                    <div className="chartblock chartblock--failed">
                      <CodeBlock code={code} lang="json" theme={codeTheme} />
                      <div className="chartblock__note">
                        Not drawn: this chart is not valid, so it is shown as written.
                      </div>
                    </div>
                  )
                }
              }

              /*
               * Documents, including while they are still being written.
               *
               * A chart is meaningless until its last brace, so it stays a
               * code block until it finishes. A set of documents is not: the
               * ones that have finished arriving are complete documents, and
               * showing them as they land is better than a wall of JSON that
               * turns into a list at the end.
               */
              if (docsOn && isDocsFence(lang)) {
                const docs = readDocs(code, streaming)
                if (docs) {
                  return (
                    <DocsBlock
                      parsed={docs}
                      source={code}
                      codeTheme={codeTheme}
                      streaming={streaming}
                    />
                  )
                }

                // Nothing has finished arriving yet — the opening brace and
                // half a title. There is nothing to show but the fact that
                // something is coming.
                if (streaming) {
                  return (
                    <div className="docsblock docsblock--waiting">
                      <FileText className="docsblock__mark" {...ICON} />
                      <span>Documents arriving…</span>
                    </div>
                  )
                }

                return (
                  <div className="docsblock docsblock--failed">
                    <CodeBlock code={code} lang="json" theme={codeTheme} />
                    <div className="docsblock__note">
                      Not shown as documents: nothing in this block could be read as one, so it
                      is shown as written.
                    </div>
                  </div>
                )
              }

              return <CodeBlock code={code} lang={lang} theme={codeTheme} />
            }
            return <pre>{children}</pre>
          },

          a({ href, children }) {
            return (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault()
                  if (href) void window.deepPink.shell.openExternal(href)
                }}
              >
                {children}
              </a>
            )
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
