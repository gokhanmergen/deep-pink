import { useEffect, useRef, useState } from 'react'
import { codeToHtml } from 'shiki'

/**
 * Shiki highlights locally — the grammars and themes are bundled, so nothing is
 * fetched at runtime and the strict CSP stays intact.
 */

const cache = new Map<string, string>()

interface Props {
  code: string
  lang: string
  theme: string
}

export function CodeBlock({ code, lang, theme }: Props): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(() => cache.get(`${theme}:${lang}:${code}`) ?? null)
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const key = `${theme}:${lang}:${code}`
    const hit = cache.get(key)
    if (hit) {
      setHtml(hit)
      return
    }

    let cancelled = false
    codeToHtml(code, { lang, theme })
      .catch(() =>
        // Unknown language — still render, just without highlighting.
        codeToHtml(code, { lang: 'text', theme })
      )
      .then((result) => {
        if (cancelled || !alive.current) return
        // Bound the cache so a long session cannot grow it without limit.
        if (cache.size > 300) cache.clear()
        cache.set(key, result)
        setHtml(result)
      })
      .catch(() => undefined)

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
}
