import { isValidElement, memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { CodeBlock } from './CodeBlock'

interface Props {
  content: string
  codeTheme: string
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
 * GitHub-flavoured Markdown, LaTeX via KaTeX ($…$ and $$…$$) and syntax
 * highlighted code blocks.
 */
export const Markdown = memo(function Markdown({ content, codeTheme }: Props): React.JSX.Element {
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
              return (
                <CodeBlock
                  code={childText(props.children).replace(/\n$/, '')}
                  lang={lang}
                  theme={codeTheme}
                />
              )
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
