/**
 * Syntax highlighting, off the thread that has to stay responsive.
 *
 * Shiki is a real parser running a real TextMate grammar — a long file in a
 * language with an intricate one is tens of milliseconds, which on the main
 * thread is several dropped frames in the middle of whatever the reader was
 * doing. A conversation full of code blocks meant a lot of them at once.
 *
 * Nothing is fetched here: the grammars and themes are bundled, which is what
 * lets the app keep its strict content-security policy.
 */
import { codeToHtml } from 'shiki'

export interface HighlightRequest {
  id: number
  code: string
  lang: string
  theme: string
}

export interface HighlightResponse {
  id: number
  /** Null when even plain text would not render, which the caller draws raw. */
  html: string | null
}

const post = (message: HighlightResponse): void =>
  (self as unknown as Worker).postMessage(message)

self.onmessage = async (event: MessageEvent<HighlightRequest>): Promise<void> => {
  const { id, code, lang, theme } = event.data
  try {
    post({ id, html: await codeToHtml(code, { lang, theme }) })
  } catch {
    try {
      // Unknown language — still render, just without highlighting.
      post({ id, html: await codeToHtml(code, { lang: 'text', theme }) })
    } catch {
      post({ id, html: null })
    }
  }
}
