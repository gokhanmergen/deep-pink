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
 * Whether anything is marked depends on the kind of answer the reader wants:
 * key points are for quick questions with short, direct answers, never for
 * detailed responses. Within those quick replies, what decides how many are
 * marked is the reader's question, not the reply and not the setting: the
 * setting is a ceiling. A model told "up to five" treats five as a quota and
 * finds five in a reply that made one point, which is the shape of the
 * complaint this went through — the marks stopped meaning anything because
 * there were always the same number of them.
 *
 * The one-thing rule is stated twice, at the top of the list and at the end of
 * it, which is not an oversight. A list this long is weighted at both ends and
 * the rule at stake is the one a reader notices being broken: asked one thing
 * and given two marks, the second is always the first said again. Measured on
 * haiku-4.5 over a reply that kept over-marking, the closing repeat took it
 * from three marks to two while leaving every other case alone.
 *
 * The wording is insistent because the polite version was ignored. Measured
 * across four models, three questions each: asking nicely was obeyed eight
 * times in twelve, and this wording eleven. The whole of the difference was
 * one model that went from never doing it to nearly always.
 */

import { clampKeyPoints } from './defaults'

/** Liberal in what it accepts: any casing, any spacing, however many. */
const MARKER = /<!--\s*key\s*:\s*([\s\S]*?)-->/gi

export function keyPointPrompt(asked: number): string {
  // Held to the same ceiling as everything else, because this one is read
  // aloud to a model: an unclamped number becomes "up to 400 of them".
  const most = clampKeyPoints(asked)
  const many = most > 1

  return `Use key-point comments only for a quick, simple question that calls for a short, direct answer. If the reader asks for detail, a thorough explanation, steps, analysis, multiple parts, or any other long response — or if a complete answer needs more than a short, direct reply — write the full answer with no key-point comments. Do not shorten or flatten a detailed answer to make it eligible. This rule takes priority over every instruction below.

For an eligible quick question, end your concise reply with ${
    many
      ? `an HTML comment for each sentence that answers something the reader asked, up to ${most} of them`
      : 'an HTML comment naming the one sentence that answers what the reader asked'
  }, copied out exactly:

<!--key: the sentence, verbatim-->${many ? '\n<!--key: another sentence, verbatim-->' : ''}

For eligible quick replies, this is required, not optional. ${
    many ? 'They go' : 'It goes'
  } last, after everything else in the reply, with nothing after ${many ? 'them' : 'it'}.
${
  many
    ? `
- If the reader wanted to know one thing, mark exactly one sentence. Not two, \
whatever else the reply covers and however long it is. A second mark on a reply \
making a single point always turns out to be the first one said again, and two \
marks saying the same thing are worse than one.
- Otherwise: count the separate things they want to know, and mark the one \
sentence that answers each. Count the things, not the question marks — a single \
sentence asking about several things at once is asking about several — and never \
mark more sentences than there were things asked.
- ${most} is a limit, not a target. Never mark more sentences than there were \
things asked; if they asked for more than ${most} things, mark the ${most} that \
matter most.
- Never two sentences that say the same thing, and never an example, an aside, \
or a sentence that only sets up the next one.`
    : `
- The one sentence that answers what they asked — not the sentence that sets it \
up, not an example of it, and not a summary of the whole reply. If they asked \
several things, mark the answer to the first.`
}
- Where you answer at the top and say it again at the end, mark the first one. \
The opening answer is the answer; the closing one is a summary of it.
- Copy each sentence exactly as you wrote it, punctuation and all. Do not shorten it, \
reword it, or re-punctuate it.
- Take ${
    many ? 'them' : 'it'
  } from the prose of the reply. Never from a code block, a table or a heading.
- Never mention the comment${many ? 's' : ''}, refer to ${
    many ? 'them' : 'it'
  }, or explain ${many ? 'them' : 'it'}. ${many ? 'They are' : 'It is'} not part of your answer.
- If the reader asks for detail or a thorough response, leave all comments out, even if the reply has a sentence that directly answers the question.${
    many
      ? `
- Before you write ${'them'}, ask yourself how many separate things the reader wanted \
to know. Write that many comments and no more. If the answer is one, write one comment.`
      : ''
  }`
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
    keyPoints: keyPoints.slice(0, clampKeyPoints(most))
  }
}
