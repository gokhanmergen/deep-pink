import { isValidElement, memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { CHART_FENCE, isChartFence, parseChart, type ParsedChart } from '@shared/charts'
import { remarkOnlyPlausibleMath } from '../markdownMath'
import { CodeBlock } from './CodeBlock'
import { ChartBlock } from './ChartBlock'

interface Props {
  content: string
  codeTheme: string
  /**
   * Whether this text is still arriving. A chart is invalid JSON right up until
   * its last brace, so nothing is called broken while it is being typed.
   */
  streaming?: boolean
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

/**
 * GitHub-flavoured Markdown, LaTeX via KaTeX ($…$ and $$…$$), syntax
 * highlighted code blocks, and validated charts documented in `@shared/charts`.
 */
export const Markdown = memo(function Markdown({
  content,
  codeTheme,
  streaming = false
}: Props): React.JSX.Element {
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

              // The prompt switch controls whether the model is asked to make
              // charts. Any chart fence that arrives is still rendered here.
              if (isChartFence(lang)) {
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
