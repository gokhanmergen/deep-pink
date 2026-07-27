import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, McpServerStatus, McpToolInfo } from '@shared/types'
import type { ToolParam } from '../providers/openrouter'
import { deleteMcpServer, listMcpServers, upsertMcpServer } from '../db/repo'

/**
 * Hosts MCP client connections. Servers run as the user's own processes (stdio)
 * or as remote HTTP endpoints; nothing is proxied through a third party.
 */

interface Connection {
  config: McpServerConfig
  client: Client | null
  state: McpServerStatus['state']
  error: string | null
  instructions: string | null
  tools: McpToolInfo[]
  resourceCount: number
  promptCount: number
  connectedAt: number | null
}

const connections = new Map<string, Connection>()
let onStatusChange: (() => void) | null = null

export function setStatusListener(listener: () => void): void {
  onStatusChange = listener
}

function notify(): void {
  onStatusChange?.()
}

/** Function names must match ^[a-zA-Z0-9_-]{1,64}$ for the model API. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)
}

export function qualifiedToolName(serverName: string, toolName: string): string {
  return `${sanitize(serverName)}__${sanitize(toolName).slice(0, 38)}`
}

function blankConnection(config: McpServerConfig): Connection {
  return {
    config,
    client: null,
    state: 'disconnected',
    error: null,
    instructions: null,
    tools: [],
    resourceCount: 0,
    promptCount: 0,
    connectedAt: null
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export function loadServers(): McpServerConfig[] {
  const configs = listMcpServers()
  for (const config of configs) {
    if (!connections.has(config.id)) connections.set(config.id, blankConnection(config))
  }
  return configs
}

/** Connects every enabled server. Failures are recorded, never thrown. */
export async function connectAll(): Promise<void> {
  const configs = loadServers()
  await Promise.all(
    configs.filter((c) => c.enabled).map((c) => connect(c.id).catch(() => undefined))
  )
}

export async function connect(serverId: string): Promise<McpServerStatus> {
  const existing = connections.get(serverId)
  if (!existing) throw new Error(`Unknown MCP server: ${serverId}`)

  await disconnect(serverId)

  const config = existing.config
  const conn = blankConnection(config)
  conn.state = 'connecting'
  connections.set(serverId, conn)
  notify()

  try {
    const client = new Client(
      { name: 'deep-pink', version: '0.1.0' },
      { capabilities: {} }
    )

    if (config.transport === 'stdio') {
      if (!config.command) throw new Error('No command configured for this stdio server.')
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd ?? undefined,
        env: {
          // Inherit the user's environment so servers find their own tooling,
          // then layer the per-server overrides on top.
          ...(process.env as Record<string, string>),
          ...config.env
        },
        stderr: 'pipe'
      })
      await client.connect(transport)
    } else {
      if (!config.url) throw new Error('No URL configured for this HTTP server.')
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers }
      })
      await client.connect(transport)
    }

    conn.client = client
    conn.state = 'connected'
    conn.connectedAt = Date.now()
    conn.instructions = client.getInstructions() ?? null

    await refreshInventory(conn)
    notify()
    return toStatus(conn)
  } catch (err) {
    conn.state = 'error'
    conn.error = err instanceof Error ? err.message : String(err)
    conn.client = null
    notify()
    return toStatus(conn)
  }
}

async function refreshInventory(conn: Connection): Promise<void> {
  const client = conn.client
  if (!client) return

  try {
    const { tools } = await client.listTools()
    conn.tools = tools.map((tool) => ({
      serverId: conn.config.id,
      serverName: conn.config.name,
      name: tool.name,
      qualifiedName: qualifiedToolName(conn.config.name, tool.name),
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      enabled: !conn.config.disabledTools.includes(tool.name)
    }))
  } catch {
    conn.tools = []
  }

  // Resources and prompts are counted for display only; nothing is read unless
  // the user explicitly attaches it.
  try {
    conn.resourceCount = (await client.listResources()).resources.length
  } catch {
    conn.resourceCount = 0
  }
  try {
    conn.promptCount = (await client.listPrompts()).prompts.length
  } catch {
    conn.promptCount = 0
  }
}

export async function disconnect(serverId: string): Promise<void> {
  const conn = connections.get(serverId)
  if (!conn?.client) return

  try {
    await conn.client.close()
  } catch {
    /* the process may already be gone */
  }

  conn.client = null
  conn.state = 'disconnected'
  conn.connectedAt = null
  conn.tools = []
  notify()
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...connections.keys()].map((id) => disconnect(id)))
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export function createServer(input: Partial<McpServerConfig>): McpServerConfig {
  const config: McpServerConfig = {
    id: input.id ?? randomUUID(),
    name: input.name ?? 'New server',
    transport: input.transport ?? 'stdio',
    command: input.command ?? null,
    args: input.args ?? [],
    env: input.env ?? {},
    cwd: input.cwd ?? null,
    url: input.url ?? null,
    headers: input.headers ?? {},
    enabled: input.enabled ?? false,
    // Deliberately false: an MCP server cannot put text into the system prompt
    // until the user has read it and opted in.
    injectInstructions: input.injectInstructions ?? false,
    disabledTools: input.disabledTools ?? [],
    requireApproval: input.requireApproval ?? true
  }
  upsertMcpServer(config)
  connections.set(config.id, blankConnection(config))
  notify()
  return config
}

export async function updateServer(
  serverId: string,
  patch: Partial<McpServerConfig>
): Promise<McpServerConfig> {
  const conn = connections.get(serverId)
  if (!conn) throw new Error(`Unknown MCP server: ${serverId}`)

  const next: McpServerConfig = { ...conn.config, ...patch, id: serverId }
  upsertMcpServer(next)

  const needsReconnect =
    next.transport !== conn.config.transport ||
    next.command !== conn.config.command ||
    next.url !== conn.config.url ||
    JSON.stringify(next.args) !== JSON.stringify(conn.config.args) ||
    JSON.stringify(next.env) !== JSON.stringify(conn.config.env) ||
    next.cwd !== conn.config.cwd

  conn.config = next

  // Reflect tool enable/disable immediately without a round trip.
  conn.tools = conn.tools.map((t) => ({ ...t, enabled: !next.disabledTools.includes(t.name) }))

  if (!next.enabled) {
    await disconnect(serverId)
  } else if (needsReconnect || conn.state !== 'connected') {
    await connect(serverId)
  }

  notify()
  return next
}

export async function removeServer(serverId: string): Promise<void> {
  await disconnect(serverId)
  connections.delete(serverId)
  deleteMcpServer(serverId)
  notify()
}

/* ------------------------------------------------------------------ *
 * Status & tools
 * ------------------------------------------------------------------ */

function toStatus(conn: Connection): McpServerStatus {
  return {
    id: conn.config.id,
    name: conn.config.name,
    state: conn.state,
    error: conn.error,
    instructions: conn.instructions,
    tools: conn.tools,
    resourceCount: conn.resourceCount,
    promptCount: conn.promptCount,
    connectedAt: conn.connectedAt
  }
}

export function getStatuses(): McpServerStatus[] {
  loadServers()
  return [...connections.values()].map(toStatus)
}

export function getConfigs(): McpServerConfig[] {
  loadServers()
  return [...connections.values()].map((c) => c.config)
}

/** Servers whose instructions the user has opted into injecting. */
export function getInjectableInstructions(activeServerIds: string[] | null): {
  serverId: string
  serverName: string
  instructions: string
}[] {
  return [...connections.values()]
    .filter((c) => c.state === 'connected' && c.config.injectInstructions && c.instructions)
    .filter((c) => activeServerIds === null || activeServerIds.includes(c.config.id))
    .map((c) => ({
      serverId: c.config.id,
      serverName: c.config.name,
      instructions: c.instructions as string
    }))
}

/** Enabled tools from connected servers, in OpenRouter's function format. */
export function getToolParams(activeServerIds: string[] | null): ToolParam[] {
  const params: ToolParam[] = []
  for (const conn of connections.values()) {
    if (conn.state !== 'connected') continue
    if (activeServerIds !== null && !activeServerIds.includes(conn.config.id)) continue

    for (const tool of conn.tools) {
      if (!tool.enabled) continue
      params.push({
        type: 'function',
        function: {
          name: tool.qualifiedName,
          description: tool.description,
          parameters: tool.inputSchema ?? { type: 'object', properties: {} }
        }
      })
    }
  }
  return params
}

export function findTool(qualifiedName: string): { conn: Connection; tool: McpToolInfo } | null {
  for (const conn of connections.values()) {
    const tool = conn.tools.find((t) => t.qualifiedName === qualifiedName)
    if (tool) return { conn, tool }
  }
  return null
}

export function toolRequiresApproval(qualifiedName: string): boolean {
  return findTool(qualifiedName)?.conn.config.requireApproval ?? false
}

export function serverNameForTool(qualifiedName: string): string | null {
  return findTool(qualifiedName)?.conn.config.name ?? null
}

export interface McpCallResult {
  content: string
  isError: boolean
  serverId: string
  toolName: string
}

export async function callTool(
  qualifiedName: string,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  const found = findTool(qualifiedName)
  if (!found) throw new Error(`No connected MCP server exposes ${qualifiedName}.`)
  if (!found.conn.client) throw new Error(`${found.conn.config.name} is not connected.`)
  if (!found.tool.enabled) throw new Error(`${qualifiedName} is disabled.`)

  const result = await found.conn.client.callTool({
    name: found.tool.name,
    arguments: args
  })

  const blocks = (result.content ?? []) as { type: string; text?: string; [k: string]: unknown }[]
  const text = blocks
    .map((block) => {
      if (block.type === 'text') return block.text ?? ''
      if (block.type === 'resource') {
        const resource = block.resource as { text?: string; uri?: string } | undefined
        return resource?.text ?? `[resource ${resource?.uri ?? ''}]`
      }
      return `[${block.type} content omitted]`
    })
    .filter(Boolean)
    .join('\n')

  return {
    content: text || '(the tool returned no content)',
    isError: Boolean(result.isError),
    serverId: found.conn.config.id,
    toolName: found.tool.name
  }
}
