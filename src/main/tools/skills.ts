import { LOAD_SKILL, SKILLS, skillById, type Skill, type SkillId } from '@shared/skills'
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
 * A skill that is switched off must be refused rather than quietly returned:
 * the app will not render a `dp-chart` block when charts are off, so handing
 * over the syntax would produce an answer that looks right to the model and
 * arrives as a wall of JSON in front of the reader.
 */
export function runLoadSkill(args: Record<string, unknown>, available: readonly SkillId[]): string {
  const asked = typeof args['skill'] === 'string' ? args['skill'] : ''
  const skill = skillById(asked)

  if (!skill) {
    const known = SKILLS.map((s) => s.id).join(', ')
    return `There is no skill called ${JSON.stringify(asked)}. The ones that exist are: ${known}.`
  }
  if (!available.includes(skill.id)) {
    return `The ${skill.name} skill is switched off for this conversation, so the app will not render one. Answer without it.`
  }

  return skill.instructions
}
