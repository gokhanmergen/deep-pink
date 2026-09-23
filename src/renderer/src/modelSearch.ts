/**
 * Finding a model by the words somebody remembers about it.
 *
 * Its own module because it is the part that was wrong and is therefore the
 * part worth checking: the picker used to test the query as one substring
 * against the id or the name, and the words a reader actually types found
 * nothing. Measured against the real catalogue of 454 models (2026-09-22),
 * every one of these returned no rows while the model sat in the list:
 *
 *   "gpt image"     0 hits        (id `openai/gpt-5-image`)
 *   "openai image"  0 hits        (name "OpenAI: GPT-5 Image")
 *   "gpt 5 image"   0 hits
 *
 * None of them is a contiguous substring of either field, and neither field
 * is written the way anyone says it out loud. So the words are taken apart
 * and each has to appear somewhere in the pair — which also makes the order
 * not matter, since "image gpt" is the same request.
 *
 * Still substrings, per word, so a part of a word works: "son" finds Sonnet,
 * and an exact id still matches itself (and anything it is a prefix of,
 * which is how `openai/gpt-5-image` also returns `…-image-mini`).
 */

/** The fields a query is matched against, lowercased once per model. */
export function haystackFor(model: { id: string; name: string }): string {
  return `${model.id} ${model.name}`.toLowerCase()
}

/** The words of a query, with the spacing somebody typed thrown away. */
export function wordsOf(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** Whether every word of the query appears somewhere in the model. */
export function matchesQuery(model: { id: string; name: string }, words: string[]): boolean {
  if (!words.length) return true
  const haystack = haystackFor(model)
  return words.every((word) => haystack.includes(word))
}
