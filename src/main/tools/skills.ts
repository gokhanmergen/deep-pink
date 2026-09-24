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
 * that is switched off is refused rather than quietly returned. The renderer
 * can still draw valid chart fences; the switch controls which instructions
 * the model receives.
 */
export function runLoadSkill(args: Record<string, unknown>, available: readonly Skill[]): string {
  const asked = typeof args['skill'] === 'string' ? args['skill'] : ''
  const found = available.find((skill) => skill.id === asked)
  if (found) return found.instructions

  // Known, but not here. Worth saying differently from a name that is simply
  // wrong: one is a switch, the other is a mistake.
  if (builtInById(asked)) {
    return `The ${asked} skill is switched off for this conversation, so its instructions are not available. Answer without loading them.`
  }

  const known = available.length
    ? available.map((skill) => skill.id).join(', ')
    : BUILT_IN.map((skill) => skill.id).join(', ')
  return `There is no skill called ${JSON.stringify(asked)}. The ones you can ask for are: ${known}.`
}
