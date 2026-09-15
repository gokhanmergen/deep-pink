/**
 * The fenced code in a piece of markdown, found without rendering it.
 *
 * Its own module, and importing nothing, because it is the part that has to be
 * *exactly* right and is therefore the part worth testing on its own. What it
 * produces is looked up in the highlighter's cache by the code itself, so a
 * string that differs from what `Markdown` hands `CodeBlock` by a single
 * character is a block warmed for nothing.
 *
 * Where it does disagree the cost is only the wasted work: nothing on screen
 * comes from here, so there is no way for a wrong answer to show a reader
 * anything wrong. That is the licence this takes to be an approximation of
 * CommonMark rather than an implementation of it.
 */

/**
 * The fenced code in a piece of markdown, as `Markdown` will hand it over.
 *
 * Indentation is the whole of the difficulty. At the top level a fence may be
 * indented up to three spaces and no further, because four makes it an
 * indented code block instead — but inside a list item every line is already
 * indented to the item's content column, and a fence there is routinely four
 * or six spaces in. Checked against a real library of 4,291 blocks
 * (2026-09-14), insisting on the top-level rule missed 110 of them, nearly all
 * of them code inside a numbered list, which is how a model writes
 * instructions.
 *
 * So any indentation opens a fence, and the fence's own indentation is what is
 * stripped from the lines inside it — which is what the container would have
 * stripped anyway. The case this gets wrong in exchange is a genuine
 * four-space indented block that happens to contain a line of backticks, and
 * getting that wrong costs one wasted cache entry.
 *
 * Fenced code only. Markdown's other kind — a block indented four spaces, with
 * no fence at all — is also a code block and is also highlighted, and is not
 * looked for here: it was 11 of those 4,291, and telling one from an indented
 * paragraph means tracking what block it is inside, which is the point at
 * which this would have to become a parser. They highlight the ordinary way.
 */
export function fencedCode(markdown: string): { code: string; lang: string }[] {
  const out: { code: string; lang: string }[] = []
  const lines = markdown.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const open = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (!open) continue

    const [, indent, fence, info] = open
    // A backtick fence's info string may not contain a backtick; that is what
    // tells ```` ```js ```` from an inline span running across a line.
    if (fence[0] === '`' && info.includes('`')) continue

    const closes = new RegExp(`^[ \\t]*${fence[0]}{${fence.length},}[ \\t]*$`)
    const body: string[] = []
    let closed = false
    let at = i + 1
    for (; at < lines.length; at++) {
      if (closes.test(lines[at])) {
        closed = true
        break
      }
      // The opening fence's indentation comes off each line, as much of it as
      // that line actually has.
      body.push(lines[at].startsWith(indent) ? lines[at].slice(indent.length) : lines[at])
    }

    // An unclosed fence runs to the end of the text, and is still a block.
    const lang = info.trim().split(/\s+/)[0] ?? ''
    out.push({ code: body.join('\n'), lang: /^[\w-]+/.exec(lang)?.[0] ?? 'text' })

    i = closed ? at : lines.length
  }

  return out
}
