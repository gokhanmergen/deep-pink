import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { highlight, highlightedAlready } from '../highlight'
import { rememberBlock } from '../codeblocks'

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

/** How long the button says "copied" before going back to offering. */
const SAID_FOR = 1400

export const CodeBlock = memo(function CodeBlock({ code, lang, theme }: Props): React.JSX.Element {
  // Seeded from the cache so a block that has been highlighted before — the
  // usual case, because a streaming reply re-renders its blocks on every chunk
  // — paints highlighted in the frame it mounts in, with no plain-text flash.
  const [html, setHtml] = useState<string | null>(() => highlightedAlready(code, lang, theme))
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

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

  /**
   * Saying it has been copied, wherever the asking came from.
   *
   * The timer is held rather than left to run, and cleared before it is set
   * again: copying twice in quick succession would otherwise have the first
   * one put the label back while the second is still being acknowledged.
   */
  const flash = useCallback((): void => {
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), SAID_FOR)
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = (): void => {
    void navigator.clipboard.writeText(code)
    flash()
  }

  /*
   * So the shortcut that copies whatever the pointer is over can reach both
   * halves of this: the source it was built from, which is more exact than
   * anything read back off the screen, and the way this block says it has been
   * copied — which is the button's own way of saying it, because it is the
   * same function the button calls.
   */
  useEffect(() => {
    rememberBlock(box.current, { code, flash })
  }, [code, flash])

  return (
    <div className="codeblock" ref={box}>
      <div className="codeblock__head">
        <span className="codeblock__lang">{lang === 'text' ? 'plain text' : lang}</span>
        <button
          className="codeblock__copy"
          data-copied={copied}
          onClick={copy}
          type="button"
        >
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
