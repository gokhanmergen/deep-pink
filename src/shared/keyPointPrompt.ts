/**
 * Asking the model to name its own key sentence, as it writes.
 *
 * The alternative to a second request: rather than send the finished reply
 * somewhere to be read again, the model that wrote it says which sentence
 * mattered. Nothing else is asked of it and nothing about the reply changes.
 *
 * An HTML comment, for one reason that decides it: `react-markdown` is not
 * given `rehype-raw`, so raw HTML in a reply is never rendered — the marker is
 * invisible from the first character streamed, and there is no moment where
 * the reader watches the model write scaffolding. Every other shape tried had
 * one: `==like this==` shows its markers until the turn ends, and a trailing
 * line shows itself for as long as it takes to finish.
 */
export const KEY_POINT_MARKER = /<!--\s*key:\s*([\s\S]*?)-->/

export const KEY_POINT_PROMPT = `At the very end of your reply, add an HTML comment naming the single most \
important sentence of it, copied exactly as you wrote it:

<!--key: the sentence, verbatim-->

Rules:
- Copy the sentence exactly, including its punctuation. Do not shorten, \
reword or re-punctuate it.
- One sentence, from the prose of your reply. Never from a code block, a \
table or a heading.
- Leave the comment out entirely if no single sentence stands out, or if the \
reply is short enough that the whole of it is the point.
- The comment is not part of your answer. Do not mention it or refer to it.`

/**
 * The sentence the model named, and the reply with the comment taken out.
 *
 * Removed rather than left in place even though nothing renders it: it would
 * otherwise travel into an export, a copy to the clipboard and the next turn's
 * context, where it is noise at best and an instruction at worst.
 */
export function takeKeyPointMarker(content: string): {
  content: string
  keyPoint: string | null
} {
  const found = KEY_POINT_MARKER.exec(content)
  if (!found) return { content, keyPoint: null }

  const claimed = found[1].trim()
  return {
    content: content.replace(KEY_POINT_MARKER, '').trimEnd(),
    keyPoint: claimed.length > 0 ? claimed : null
  }
}
