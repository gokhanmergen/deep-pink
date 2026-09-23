import { CHARTS_PROMPT } from './charts'
import { DOCS_PROMPT } from './docs'

/**
 * Things the app can do that the model has to be taught how to ask for.
 *
 * Charts and documents each need several hundred tokens of syntax before a
 * model can produce one: the block name, the JSON shape, the fields, what the
 * app owns and what it does not. That text used to go into the system prompt
 * of every single turn for as long as the feature was switched on — about 700
 * tokens of chart and document grammar sitting in front of "what time is it
 * in Tokyo".
 *
 * Which is why the only working way to use them was to turn them on when you
 * wanted one and off when you did not. Left on, a model with a page of chart
 * syntax in front of it draws charts, because that is what the instructions
 * in its context are about; left off, it cannot draw one even where a chart
 * is obviously the right answer. Neither of those is the model judging the
 * question. Both are the prompt deciding in advance.
 *
 * So the instructions are not in the prompt any more. What is in the prompt
 * is a line per skill saying when it is worth having — and a tool to ask for
 * the rest. The model reads "a chart, when the shape of the numbers is the
 * point and a table would make the reader find that shape themselves",
 * decides whether that is this question, and asks if it is. The full grammar
 * arrives as the tool's result, and the answer is written with it.
 *
 * The cost of having a skill available drops from its whole instruction text
 * to one line, which is the point: it becomes something you leave on.
 */

export type SkillId = 'charts' | 'documents'

export interface Skill {
  id: SkillId
  /** What the model calls it, and what the transcript shows. */
  name: string
  /**
   * When this is worth asking for, in the model's own terms.
   *
   * The only part that is always in context, so it carries the whole
   * judgement — including, deliberately, when *not* to: a skill described
   * only by what it can do is one that gets used because it exists.
   */
  when: string
  /** Everything needed to actually produce one, handed over on request. */
  instructions: string
}

export const SKILLS: readonly Skill[] = [
  {
    id: 'charts',
    name: 'charts',
    when:
      'Draw a chart. Worth it when the shape of the numbers is the point — a trend over ordered ' +
      'points, a comparison across categories, a relationship between two measures — and a table ' +
      'would leave the reader to find that shape for themselves. Not worth it for two or three ' +
      'numbers, which are a sentence, or for a handful of labelled figures, which are a Markdown ' +
      'table and are read faster as one.',
    instructions: CHARTS_PROMPT
  },
  {
    id: 'documents',
    name: 'documents',
    when:
      'Present the answer as a set of documents the reader opens one at a time. Worth it when the ' +
      'answer really is several separate pieces — one per file, per service, per region, per ' +
      'option being compared — and the reader wants one of them. Not worth it when the parts are ' +
      'meant to be read in order or refer to each other: that is one reply with headings.',
    instructions: DOCS_PROMPT
  }
]

export function skillById(id: string): Skill | undefined {
  return SKILLS.find((skill) => skill.id === id)
}

/** The name of the tool that hands over a skill's instructions. */
export const LOAD_SKILL = 'load_skill'

/**
 * The part that is always in context: what exists, and when it earns its keep.
 *
 * Deliberately short. This is read on every turn, including the ones where no
 * skill applies, which is most of them — and a catalogue that argues for
 * itself at length is a catalogue that gets used out of proportion to how
 * often it is the right answer.
 */
export function skillCatalogue(available: readonly Skill[]): string {
  if (!available.length) return ''

  const entries = available.map((skill) => `- \`${skill.id}\` — ${skill.when}`).join('\n')

  return `# Skills

This client can do things beyond plain Markdown. Each needs instructions you do not have; call \`${LOAD_SKILL}\` with a name to get them, then write the answer using them.

${entries}

Ask only once you have decided the skill beats writing the answer out plainly — plain is the default and is usually right. A loaded skill stays available for the rest of the conversation; do not ask twice.`
}
