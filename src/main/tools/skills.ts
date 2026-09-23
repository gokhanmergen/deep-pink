import { BUILT_IN, LOAD_SKILL, builtInById, type Skill } from '@shared/skills'
import type { ToolParam } from '../providers/openrouter'

/**
 * Asking for a skill's instructions.
 *
 * One tool rather than one per skill: the names are an enum in a single
 * schema, which costs a fraction of what several function definitions do and
 * keeps the list of what exists in one place — the catalogue in the system
 * prompt and the enum here are built from the same array, so a skill cannot
 * be advertised and then refused.
 */
export function loadSkillTool(available: readonly Skill[]): ToolParam {
  return {
    type: 'function',
    function: {
      name: LOAD_SKILL,
      description:
        'Get the instructions for one of this client\'s skills. Call this only after deciding the ' +
        'skill is a better answer than plain Markdown; the instructions arrive as the result and ' +
        'you then write the answer using them.',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'Which skill to load.',
            enum: available.map((skill) => skill.id)
          }
        },
        required: ['skill'],
        additionalProperties: false
      }
    }
  }
}

/**
 * The instructions, or an explanation of why not.
 *
 * Answered from the list this conversation was actually offered, so a skill
 * that is switched off is refused rather than quietly returned: the app will
 * not render a `dp-chart` block when charts are off, and handing over the
 * syntax anyway produces an answer that looks right to the model and arrives
 * as a wall of JSON in front of the reader.
 */
export function runLoadSkill(args: Record<string, unknown>, available: readonly Skill[]): string {
  const asked = typeof args['skill'] === 'string' ? args['skill'] : ''
  const found = available.find((skill) => skill.id === asked)
  if (found) return found.instructions

  // Known, but not here. Worth saying differently from a name that is simply
  // wrong: one is a switch, the other is a mistake, and a model told "there
  // is no such skill" about a real one will try to work around the absence.
  if (builtInById(asked)) {
    return `The ${asked} skill is switched off for this conversation, so the app will not render one. Answer without it.`
  }

  const known = available.length
    ? available.map((skill) => skill.id).join(', ')
    : BUILT_IN.map((skill) => skill.id).join(', ')
  return `There is no skill called ${JSON.stringify(asked)}. The ones you can ask for are: ${known}.`
}
