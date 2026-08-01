import type { Settings, SystemPromptSegment, Thread } from '@shared/types'
import type { ToolParam } from '../providers/openrouter'
import * as mcp from '../mcp/host'
import { WEB_FETCH_TOOL, WEB_PROMPT_SEGMENT, WEB_SEARCH_TOOL } from '../tools/web'
import { REPO_TOOLS, repoPromptSegment, treeSummary } from '../tools/repo'

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

export function activeServerIdsFor(thread: Thread): string[] | null {
  return thread.config.enabledMcpServers
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
      text: repoPromptSegment(repos, treeSummary(repos)),
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

  const systemText = segments
    .filter((s) => s.enabled && s.source !== 'tools')
    .map((s) => s.text.trim())
    .join('\n\n')

  const estimatedTokens = segments
    .filter((s) => s.enabled)
    .reduce((sum, s) => sum + s.tokens, 0)

  return { segments, systemText, tools, estimatedTokens }
}
