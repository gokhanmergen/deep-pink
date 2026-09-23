import type { Settings, SystemPromptSegment, Thread } from '@shared/types'
import { keyPointPrompt } from '@shared/keyPointPrompt'
import { SKILLS, skillCatalogue, type SkillId } from '@shared/skills'
import { keyPointCeiling } from '@shared/defaults'
import type { ToolParam } from '../providers/openrouter'
import * as mcp from '../mcp/host'
import { WEB_FETCH_TOOL, WEB_PROMPT_SEGMENT, WEB_SEARCH_TOOL } from '../tools/web'
import { REPO_TOOLS, repoPromptSegment } from '../tools/repo'
import { cachedTree } from '../tools/repoService'
import { knownModel } from '../providers/openrouter'
import { loadSkillTool } from '../tools/skills'

/**
 * Everything that enters the model's context is assembled here, as a list of
 * labelled segments. The renderer shows this list verbatim and can switch any
 * removable segment off — including instructions injected by MCP servers.
 */

/** Rough but stable estimate; real counts come back with the response. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export interface AssembledContext {
  segments: SystemPromptSegment[]
  /** The concatenated text of every enabled text segment. */
  systemText: string
  /** Tool definitions actually sent, honouring the tools segment toggle. */
  tools: ToolParam[]
  estimatedTokens: number
}

function webEnabledFor(thread: Thread, settings: Settings): boolean {
  return thread.config.webAccessEnabled ?? settings.web.enabled
}

/** The thread's answer if it has one, otherwise the global setting. */
/*
 * Hidden means off, everywhere it is asked.
 *
 * The switch could have been made to hide the controls only, and then a
 * reader who had once turned charts on would keep getting them out of an app
 * that no longer admits charts exist. A feature you cannot see and cannot
 * turn off is worse than one you can see.
 */
export function chartsEnabledFor(thread: Thread, settings: Settings): boolean {
  if (settings.hideExperimental) return false
  return thread.config.chartsEnabled ?? settings.chartsEnabled
}

export function docsEnabledFor(thread: Thread, settings: Settings): boolean {
  if (settings.hideExperimental) return false
  return thread.config.docsEnabled ?? settings.docsEnabled
}

export function activeServerIdsFor(thread: Thread): string[] | null {
  return thread.config.enabledMcpServers
}

/**
 * Which skills this conversation may use, in the order they are catalogued.
 *
 * Each still answers to its own switch — a skill is not something the model
 * may turn on for itself, because the app only renders a `dp-chart` block
 * when charts are on and a model handed the syntax regardless would write
 * JSON into a reply that shows it as JSON.
 *
 * What changed is the cost of leaving one on: a line rather than a page. See
 * `SKILLS`.
 */
export function skillsFor(thread: Thread, settings: Settings): SkillId[] {
  const on: Record<SkillId, boolean> = {
    charts: chartsEnabledFor(thread, settings),
    documents: docsEnabledFor(thread, settings)
  }
  return SKILLS.filter((skill) => on[skill.id]).map((skill) => skill.id)
}

/**
 * Whether this conversation's model can ask for a skill at all.
 *
 * Asking is a tool call, and a model that cannot call tools does not ignore
 * the tool politely — it never sees the instructions, so charts stay
 * undrawable in a thread where charts are switched on. That is a worse
 * failure than the tokens on-demand loading exists to save, so the skills are
 * simply held open for those models and nothing is lost but the judgement,
 * which they were not going to be asked for.
 *
 * An unknown model — a first launch, an offline start, an id no longer in the
 * catalogue — is treated as capable. Most models are, and being wrong this
 * way costs a round trip the model declines to make; being wrong the other
 * way costs the whole feature.
 */
function askableBy(thread: Thread, settings: Settings): boolean {
  const info = knownModel(thread.config.model ?? settings.defaultModel)
  return info === null || info.supportsTools
}

export function assembleContext(thread: Thread, settings: Settings): AssembledContext {
  const disabled = new Set(thread.config.disabledPromptSegments)
  const segments: SystemPromptSegment[] = []

  const push = (
    segment: Omit<SystemPromptSegment, 'tokens' | 'enabled'> & { enabled?: boolean }
  ): void => {
    if (!segment.text.trim()) return
    segments.push({
      ...segment,
      tokens: estimateTokens(segment.text),
      enabled: segment.enabled ?? !disabled.has(segment.id)
    })
  }

  push({
    id: 'base',
    source: 'base',
    label: 'Base system prompt',
    origin: 'Settings',
    text: settings.baseSystemPrompt,
    removable: true
  })

  if (thread.config.systemPrompt) {
    push({
      id: 'thread',
      source: 'thread',
      label: 'Thread system prompt',
      origin: 'This thread',
      text: thread.config.systemPrompt,
      removable: true
    })
  }

  if (settings.includeDateTimeInPrompt) {
    const now = new Date()
    push({
      id: 'datetime',
      source: 'datetime',
      label: 'Current date and time',
      origin: 'Deep Pink',
      text: `The current date and time is ${now.toISOString()} (${
        Intl.DateTimeFormat().resolvedOptions().timeZone
      }).`,
      removable: true
    })
  }

  /*
   * Ahead of the tool and web segments because it shapes how an answer is
   * written, not what the model can go and do.
   *
   * On demand, this is a line per skill and the model asks for the rest when
   * it decides one applies. Held open, it is the whole instruction text for
   * every skill on every turn — which is what this used to be, and is kept
   * for anybody who would rather pay the tokens than the round trip.
   */
  const skills = skillsFor(thread, settings)
  const available = SKILLS.filter((skill) => skills.includes(skill.id))
  const onDemand = settings.skillsOnDemand && askableBy(thread, settings)

  if (available.length && onDemand) {
    push({
      id: 'skills',
      source: 'skills',
      label: `Skills (${available.length})`,
      origin: 'Deep Pink',
      text: skillCatalogue(available),
      removable: true
    })
  } else {
    for (const skill of available) {
      push({
        id: skill.id === 'charts' ? 'charts' : 'docs',
        source: skill.id === 'charts' ? 'charts' : 'docs',
        label: skill.id === 'charts' ? 'Chart syntax' : 'Multiple documents',
        origin: 'Deep Pink',
        text: skill.instructions,
        removable: true
      })
    }
  }

  const useWeb = webEnabledFor(thread, settings)
  if (useWeb && settings.web.engine !== 'openrouter') {
    push({
      id: 'web',
      source: 'web',
      label: 'Web access instructions',
      origin: 'Deep Pink',
      text: WEB_PROMPT_SEGMENT,
      removable: true
    })
  }

  // An attached repository: its layout goes in up front so the model starts
  // oriented instead of spending tool calls rediscovering the directory
  // structure, which is where the tokens go.
  const repos = thread.config.repoPaths ?? []
  if (repos.length) {
    push({
      id: 'repo',
      source: 'repo',
      label: `Attached repository (${repos.length})`,
      origin: repos.join(', '),
      // Cached; the engine reads it on the worker before each turn. Missing
      // only on the very first, where the model can still call repo_tree.
      text: repoPromptSegment(repos, cachedTree(repos)),
      removable: true
    })
  }

  // MCP-provided instructions, one segment per server, each attributed.
  const activeServers = activeServerIdsFor(thread)
  for (const injected of mcp.getInjectableInstructions(activeServers)) {
    push({
      id: `mcp:${injected.serverId}`,
      source: 'mcp-instructions',
      label: `MCP instructions — ${injected.serverName}`,
      origin: injected.serverName,
      text: injected.instructions,
      removable: true
    })
  }

  // Tool schemas travel in the request's `tools` field rather than in the
  // system text, but they occupy context all the same, so they are listed and
  // can be switched off here too.
  const candidateTools: ToolParam[] = [
    ...(available.length && onDemand ? [loadSkillTool(available)] : []),
    ...(useWeb && settings.web.engine !== 'openrouter' ? [WEB_SEARCH_TOOL, WEB_FETCH_TOOL] : []),
    ...(repos.length ? REPO_TOOLS : []),
    ...mcp.getToolParams(activeServers)
  ]

  let tools: ToolParam[] = []
  if (candidateTools.length) {
    const toolsText = candidateTools
      .map((t) => `${t.function.name}: ${t.function.description}`)
      .join('\n')
    const enabled = !disabled.has('tools')
    segments.push({
      id: 'tools',
      source: 'tools',
      label: `Tool definitions (${candidateTools.length})`,
      origin: 'Sent as the request `tools` field, not as system text',
      text: toolsText,
      tokens: estimateTokens(JSON.stringify(candidateTools)),
      enabled,
      removable: true
    })
    if (enabled) tools = candidateTools
  }

  /*
   * Last, and deliberately.
   *
   * This asks for something at the very end of every reply, and an
   * instruction buried above the tool schemas is one a smaller model has
   * forgotten by the time it gets there. Measured with it last: the polite
   * wording was obeyed eight times in twelve across four models, the
   * insistent one eleven. It sat with charts and documents at first, which
   * are also about what a reply may *be* — but those shape the whole answer,
   * and this only adds a line to the end of it.
   *
   * After the tools segment, which is not system text at all: `systemText`
   * below drops it, so this is genuinely the last thing the model reads.
   */
  if (!settings.hideExperimental && settings.keyPointEnabled && settings.keyPointSource === 'self') {
    push({
      id: 'keyPoint',
      source: 'keyPoint',
      label: 'Key sentence',
      origin: 'Deep Pink',
      text: keyPointPrompt(keyPointCeiling(settings.keyPointMany)),
      removable: true
    })
  }

  const systemText = segments
    .filter((s) => s.enabled && s.source !== 'tools')
    .map((s) => s.text.trim())
    .join('\n\n')

  const estimatedTokens = segments
    .filter((s) => s.enabled)
    .reduce((sum, s) => sum + s.tokens, 0)

  return { segments, systemText, tools, estimatedTokens }
}
