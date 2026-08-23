import { isValidElement, memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { parseRichBlock, richKindOf, type ParsedRichBlock } from '@shared/richBlocks'
import { useStore } from '../store'
import { CodeBlock } from './CodeBlock'
import { RichBlock } from './rich/RichBlock'

interface Props {
  content: string
  codeTheme: string
  /**
   * How far inside a rich block this is. A block may contain Markdown and that
   * Markdown may contain one more block — a table inside a tab is useful — but
   * the recursion stops there, so no reply can nest itself into a hang.
   */
  depth?: number
  /**
   * Whether this text is still arriving. A rich block is invalid JSON right up
   * until its last brace, so nothing is called broken while it is being typed.
   */
  streaming?: boolean
}

const MAX_RICH_DEPTH = 2

function childText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(childText).join('')
  if (isValidElement(node)) {
    return childText((node.props as { children?: ReactNode }).children)
  }
  return ''
}

/**
 * Parsed blocks, keyed by their source.
 *
 * A streaming reply re-renders on every chunk and each render re-reads every
 * block in the message, so parsing is memoised on the text itself. Bounded,
 * because a long thread would otherwise hold every version of every half-typed
 * block that ever streamed through it.
 */
const parsed = new Map<string, ParsedRichBlock | null>()

function readBlock(language: string, source: string): ParsedRichBlock | null {
  // A separator neither a language nor JSON can contain.
  const key = `${language}\u0000${source}`
  const hit = parsed.get(key)
  if (hit !== undefined) return hit

  const result = parseRichBlock(language, source)
  if (parsed.size > 300) parsed.clear()
  parsed.set(key, result)
  return result
}

/** Whether this thread draws rich blocks: its own answer, else the global one. */
function useRichBlocks(): boolean {
  return useStore((state) => {
    const thread = state.threads.find((t) => t.id === state.activeThreadId)
    return thread?.config.richBlocksEnabled ?? state.settings?.richBlocksEnabled ?? false
  })
}

/**
 * GitHub-flavoured Markdown, LaTeX via KaTeX ($…$ and $$…$$), syntax
 * highlighted code blocks, and — when the thread has them switched on — the
 * rich blocks documented in `@shared/richBlocks`.
 */
export const Markdown = memo(function Markdown({
  content,
  codeTheme,
  depth = 0,
  streaming = false
}: Props): React.JSX.Element {
  const richOn = useRichBlocks()

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={{
          pre({ children }) {
            const child = Array.isArray(children) ? children[0] : children
            if (isValidElement(child)) {
              const props = child.props as { className?: string; children?: ReactNode }
              const lang = /language-([\w-]+)/.exec(props.className ?? '')?.[1] ?? 'text'
              const code = childText(props.children).replace(/\n$/, '')

              // A rich fence that is switched off, still streaming, or simply
              // not valid stays a code block. Nothing is ever hidden because it
              // failed to parse.
              if (richOn && depth < MAX_RICH_DEPTH && richKindOf(lang)) {
                const block = readBlock(lang, code)
                if (block) {
                  return (
                    <RichBlock
                      parsed={block}
                      source={code}
                      language={lang}
                      codeTheme={codeTheme}
                      body={(markdown) => (
                        <Markdown
                          content={markdown}
                          codeTheme={codeTheme}
                          depth={depth + 1}
                          streaming={streaming}
                        />
                      )}
                    />
                  )
                }

                // Finished and still not valid: say so, rather than leave the
                // reader wondering why one block came out as JSON.
                if (!streaming) {
                  return (
                    <div className="rb-failed">
                      <CodeBlock code={code} lang="json" theme={codeTheme} />
                      <div className="rb-note">
                        Not drawn: this <span className="mono">{lang}</span> block is not valid for
                        its kind, so it is shown as written.
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
