import { memo, useEffect, useState } from 'react'
import { highlight, highlightedAlready } from '../highlight'

/**
 * Shiki highlights locally — the grammars and themes are bundled, so nothing is
 * fetched at runtime and the strict CSP stays intact. The work itself happens
 * on a worker; see `../highlight`.
 */

interface Props {
  code: string
  lang: string
  theme: string
}

export const CodeBlock = memo(function CodeBlock({ code, lang, theme }: Props): React.JSX.Element {
  // Seeded from the cache so a block that has been highlighted before — the
  // usual case, because a streaming reply re-renders its blocks on every chunk
  // — paints highlighted in the frame it mounts in, with no plain-text flash.
  const [html, setHtml] = useState<string | null>(() => highlightedAlready(code, lang, theme))
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const known = highlightedAlready(code, lang, theme)
    if (known) {
      setHtml(known)
      return
    }

    let cancelled = false
    void highlight(code, lang, theme).then((result) => {
      if (!cancelled) setHtml(result)
    })

    return () => {
      cancelled = true
    }
  }, [code, lang, theme])

  const copy = (): void => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="codeblock">
      <div className="codeblock__head">
        <span className="codeblock__lang">{lang === 'text' ? 'plain text' : lang}</span>
        <button className="codeblock__copy" onClick={copy} type="button">
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
})
