import { CHARTS_PROMPT } from './charts'

/**
 * Things the app can do that the model has to be taught how to ask for.
 *
 * Charts need several hundred tokens of syntax before a model can produce
 * one: the block name, the JSON shape, the fields, what the app owns and what
 * it does not. That text used to go into the system prompt of every single
 * turn for as long as the feature was switched on.
 *
 * The switch controls whether the model can ask for those instructions. It no
 * longer controls rendering: a valid chart fence is drawn whether or not the
 * model was given the chart skill.
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

/** The built-in skill, backed by its chart renderer. */
export type BuiltInSkillId = 'charts'

export interface Skill {
  /** What the model calls it. Unique across built-in and written-here alike. */
  id: string
  /** What the transcript shows. */
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
  /** True for one written in Settings rather than shipped with the app. */
  custom?: boolean
}

/**
 * A skill somebody wrote themselves.
 *
 * The built-in chart skill has code behind it: a chart is drawn by a renderer
 * that has to exist. A written-here skill has nothing behind it but the text,
 * which turns out to be most of what a skill is: house style, the shape
 * of a commit message, the format a report has to arrive in, the six things
 * to check before answering a question about the rota.
 *
 * Those are the instructions people paste into a system prompt and then carry
 * on every turn forever. Here they cost a line until the model decides the
 * question is one of those.
 */
export interface CustomSkill {
  /** Stable across renames, so editing a name does not lose the row. */
  key: string
  /** What the model calls it: lowercase, no spaces. See `asSkillName`. */
  name: string
  when: string
  instructions: string
  enabled: boolean
}

/** The shape a name has to take to be callable: an enum value, not a sentence. */
export function asSkillName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
}

/**
 * Why this one cannot be offered, or null if it can.
 *
 * Shown beside the field being typed into rather than kept for a save button,
 * and used again at assembly time — a skill with no instructions is a tool
 * call that returns nothing, and a name that collides with a built-in is two
 * answers to the same question.
 */
export function whyUnusable(skill: CustomSkill, others: readonly CustomSkill[]): string | null {
  const name = asSkillName(skill.name)
  if (!name) return 'Needs a name'
  if (name === LOAD_SKILL) return `${LOAD_SKILL} is the tool that loads these`
  if (BUILT_IN.some((built) => built.id === name)) return `${name} is one of the built-in skills`
  if (others.some((other) => other.key !== skill.key && asSkillName(other.name) === name)) {
    return 'Another skill already has that name'
  }
  if (!skill.when.trim()) return 'Needs a line saying when to use it'
  if (!skill.instructions.trim()) return 'Needs instructions to hand over'
  return null
}

export function toSkill(custom: CustomSkill): Skill {
  return {
    id: asSkillName(custom.name),
    name: asSkillName(custom.name),
    when: custom.when.trim(),
    instructions: custom.instructions.trim(),
    custom: true
  }
}

export const BUILT_IN: readonly Skill[] = [
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
  }
]

/** Kept under its old name for callers that treat built-ins as a group. */
export const SKILLS = BUILT_IN

export function builtInById(id: string): Skill | undefined {
  return BUILT_IN.find((skill) => skill.id === id)
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
