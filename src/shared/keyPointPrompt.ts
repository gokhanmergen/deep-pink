/**
 * Asking the model to name its own key sentences, as it writes.
 *
 * The alternative to a second request: rather than send the finished reply
 * somewhere to be read again, the model that wrote it says which sentences
 * mattered. Nothing else is asked of it and nothing about the reply changes.
 *
 * An HTML comment, for one reason that decides it: `react-markdown` is not
 * given `rehype-raw`, so raw HTML in a reply is never rendered — the marker is
 * invisible from the first character streamed, and there is no moment where
 * the reader watches the model write scaffolding. Every other shape tried had
 * one: `==like this==` shows its markers until the turn ends, and a trailing
 * line shows itself for as long as it takes to finish.
 *
 * The wording is insistent because the polite version was ignored. Measured
 * across four models, three questions each: asking nicely was obeyed eight
 * times in twelve, and this wording eleven. The whole of the difference was
 * one model that went from never doing it to nearly always.
 */

/** Liberal in what it accepts: any casing, any spacing, however many. */
const MARKER = /<!--\s*key\s*:\s*([\s\S]*?)-->/gi

export function keyPointPrompt(most: number): string {
  const many = most > 1

  return `Every reply you write must end with ${
    many ? `up to ${most} HTML comments naming its most important sentences` : 'an HTML comment naming its single most important sentence'
  }, copied out exactly:

<!--key: the sentence, verbatim-->${many ? '\n<!--key: another sentence, verbatim-->' : ''}

This is required, not optional. ${
    many ? 'They go' : 'It goes'
  } last, after everything else in the reply, with nothing after ${many ? 'them' : 'it'}.

- Copy each sentence exactly as you wrote it, punctuation and all. Do not shorten it, \
reword it, or re-punctuate it.
- Take ${
    many ? 'them' : 'it'
  } from the prose of the reply. Never from a code block, a table or a heading.
- Never mention the comment${many ? 's' : ''}, refer to ${
    many ? 'them' : 'it'
  }, or explain ${many ? 'them' : 'it'}. ${many ? 'They are' : 'It is'} not part of your answer.${
    many
      ? `\n- Fewer is better. Mark a second or third sentence only where it carries something \
the first does not.`
      : ''
  }
- The only reply that may leave ${
    many ? 'them' : 'it'
  } out is one with no prose in it at all.`
}

/**
 * The sentences the model named, and the reply with the comments taken out.
 *
 * Removed rather than left in place even though nothing renders them: they
 * would otherwise travel into an export, a copy to the clipboard and the next
 * turn's context, where they are noise at best and an instruction at worst.
 */
export function takeKeyPointMarkers(
  content: string,
  most: number
): { content: string; keyPoints: string[] } {
  const keyPoints: string[] = []
  let marked = false

  for (const found of content.matchAll(MARKER)) {
    // Noted even when it holds nothing, because the comment still has to go:
    // a model that decides nothing stands out may well keep the shape and
    // leave it empty, and an empty marker left in the text is one that
    // reaches the export and the next turn's context.
    marked = true
    const claimed = found[1].trim()
    if (claimed) keyPoints.push(claimed)
  }

  if (!marked) return { content, keyPoints: [] }

  return {
    content: content.replace(MARKER, '').trimEnd(),
    // More than was asked for is the model being enthusiastic, not the reader
    // changing their mind: the setting is what decides how many are marked.
    keyPoints: keyPoints.slice(0, Math.max(most, 1))
  }
}
