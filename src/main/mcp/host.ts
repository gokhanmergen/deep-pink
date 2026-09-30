import { createHash, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js'
import { connectionError, serverFetch } from './http'
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
  transport: StdioClientTransport | StreamableHTTPClientTransport | null
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

/** Keep model API names valid without merging distinct long or punctuated names. */
function sanitize(name: string, limit: number): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (clean === name && clean.length <= limit && clean) return clean
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${clean.slice(0, limit - 9)}_${hash}`
}

export function qualifiedToolName(serverName: string, toolName: string, serverId?: string): string {
  const server = serverId ? `${serverName}_${serverId}` : serverName
  return `${sanitize(server, 24)}__${sanitize(toolName, 38)}`
}

// An edited key, a reconnect, and a disable can arrive in successive IPC calls.
// Apply them in order so an old handshake cannot overwrite the newer config.
const operations = new Map<string, Promise<unknown>>()
function serial<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(serverId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  operations.set(serverId, next)
  void next.finally(() => {
    if (operations.get(serverId) === next) operations.delete(serverId)
  }).catch(() => undefined)
  return next
}

function blankConnection(config: McpServerConfig): Connection {
  return {
    config,
    client: null,
    transport: null,
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

export function connect(serverId: string): Promise<McpServerStatus> {
  return serial(serverId, () => connectNow(serverId))
}

async function connectNow(serverId: string): Promise<McpServerStatus> {
  loadServers()
  const existing = connections.get(serverId)
  if (!existing) throw new Error(`Unknown MCP server: ${serverId}`)

  await disconnectNow(serverId)
  const conn = blankConnection(existing.config)
  const config = conn.config
  conn.state = 'connecting'
  connections.set(serverId, conn)
  notify()

  const client = new Client(
    { name: 'deep-pink', version: __APP_VERSION__ },
    { capabilities: {} }
  )
  // Hold the client before awaiting initialization, so failures can close it.
  conn.client = client
  client.onclose = () => {
    if (conn.client !== client) return
    conn.client = null
    conn.transport = null
    conn.state = 'error'
    conn.error ??= 'The MCP connection closed. Start the server and reconnect.'
    clearInventory(conn)
    notify()
  }
  client.onerror = (error) => {
    if (conn.client !== client) return
    conn.error = connectionError(error, config.headers)
    notify()
  }

  try {
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error('No command configured for this stdio server.')
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd ?? undefined,
        env: { ...(process.env as Record<string, string>), ...config.env },
        // Drain stderr rather than allowing a verbose server to fill its pipe
        // and stop responding. Server logs may contain secrets, so discard it.
        stderr: 'ignore'
      })
      conn.transport = transport
      await client.connect(transport, { timeout: 15_000 })
    } else {
      if (!config.url) throw new Error('No URL configured for this HTTP server.')
      const url = new URL(config.url)
      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('MCP URLs must use HTTP or HTTPS.')
      }
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: config.headers },
        fetch: serverFetch(url, config.caCertificate)
      })
      conn.transport = transport
      await client.connect(transport, { timeout: 15_000 })
    }

    conn.instructions = client.getInstructions() ?? null
    await refreshInventory(conn)
    if (conn.client !== client) throw new Error('The MCP connection closed during discovery.')
    conn.state = 'connected'
    conn.error = null
    conn.connectedAt = Date.now()

    const refresh = async (): Promise<void> => {
      try {
        await refreshInventory(conn)
        if (conn.client !== client) return
        conn.error = null
        notify()
      } catch (error) {
        if (conn.client !== client) return
        conn.error = connectionError(error, config.headers)
        conn.state = 'error'
        conn.client = null
        clearInventory(conn)
        await closeClient(client, conn.transport)
        conn.transport = null
        notify()
      }
    }
    client.setNotificationHandler(ToolListChangedNotificationSchema, refresh)
    client.setNotificationHandler(ResourceListChangedNotificationSchema, refresh)
    client.setNotificationHandler(PromptListChangedNotificationSchema, refresh)
    notify()
    return toStatus(conn)
  } catch (error) {
    conn.state = 'error'
    conn.error = connectionError(error, config.headers)
    conn.client = null
    clearInventory(conn)
    await closeClient(client, conn.transport)
    conn.transport = null
    notify()
    return toStatus(conn)
  }
}

/** Retrieve every page, while refusing a broken server's cursor loop. */
async function pages<T>(list: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> {
  const result: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await list(cursor)
    result.push(...page.items)
    cursor = page.nextCursor
    if (cursor) {
      if (seen.has(cursor)) throw new Error('The MCP server repeated a discovery page cursor.')
      seen.add(cursor)
    }
  } while (cursor)
  return result
}

async function refreshInventory(conn: Connection): Promise<void> {
  const client = conn.client
  if (!client) return
  const capabilities = client.getServerCapabilities()
  const options = { timeout: 15_000 }
  // Unsupported methods need not be probed, and a failed advertised inventory
  // must not become a green "connected" indicator with silently missing tools.
  const [tools, resources, prompts] = await Promise.all([
    capabilities?.tools ? pages(async (cursor) => {
      const result = await client.listTools(cursor ? { cursor } : undefined, options)
      return { items: result.tools, nextCursor: result.nextCursor }
    }) : [],
    capabilities?.resources ? pages(async (cursor) => {
      const result = await client.listResources(cursor ? { cursor } : undefined, options)
      return { items: result.resources, nextCursor: result.nextCursor }
    }) : [],
    capabilities?.prompts ? pages(async (cursor) => {
      const result = await client.listPrompts(cursor ? { cursor } : undefined, options)
      return { items: result.prompts, nextCursor: result.nextCursor }
    }) : []
  ])
  if (conn.client !== client) return
  conn.tools = tools.map((tool) => ({
    serverId: conn.config.id,
    serverName: conn.config.name,
    name: tool.name,
    qualifiedName: qualifiedToolName(conn.config.name, tool.name, conn.config.id),
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    enabled: !conn.config.disabledTools.includes(tool.name)
  }))
  conn.resourceCount = resources.length
  conn.promptCount = prompts.length
}

function clearInventory(conn: Connection): void {
  conn.connectedAt = null
  conn.instructions = null
  conn.tools = []
  conn.resourceCount = 0
  conn.promptCount = 0
}

async function closeClient(client: Client, transport: Connection['transport']): Promise<void> {
  // Streamable HTTP close aborts the SSE listener; DELETE also releases the
  // session on the server. A stopped server must not hold a reconnect forever.
  if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      transport.terminateSession().catch(() => undefined),
      new Promise<void>((resolve) => { timeout = setTimeout(resolve, 3000) })
    ])
    if (timeout) clearTimeout(timeout)
  }
  await client.close().catch(() => undefined)
}

export function disconnect(serverId: string): Promise<void> {
  return serial(serverId, () => disconnectNow(serverId))
}

async function disconnectNow(serverId: string): Promise<void> {
  const conn = connections.get(serverId)
  if (!conn) return
  const client = conn.client
  const transport = conn.transport
  conn.client = null
  conn.transport = null
  conn.state = 'disconnected'
  conn.error = null
  clearInventory(conn)
  if (client) await closeClient(client, transport)
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
    caCertificate: input.caCertificate?.trim() || null,
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

export function updateServer(
  serverId: string,
  patch: Partial<McpServerConfig>
): Promise<McpServerConfig> {
  return serial(serverId, () => updateServerNow(serverId, patch))
}

async function updateServerNow(serverId: string, patch: Partial<McpServerConfig>): Promise<McpServerConfig> {
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
    next.cwd !== conn.config.cwd ||
    JSON.stringify(next.headers) !== JSON.stringify(conn.config.headers) ||
    next.caCertificate !== conn.config.caCertificate

  conn.config = next

  // Reflect tool enable/disable immediately without a round trip.
  conn.tools = conn.tools.map((t) => ({
    ...t,
    serverName: next.name,
    qualifiedName: qualifiedToolName(next.name, t.name, next.id),
    enabled: !next.disabledTools.includes(t.name)
  }))

  if (!next.enabled) {
    await disconnectNow(serverId)
  } else if (needsReconnect || conn.state !== 'connected') {
    await connectNow(serverId)
  }

  notify()
  return next
}

export function removeServer(serverId: string): Promise<void> {
  return serial(serverId, async () => {
    await disconnectNow(serverId)
    connections.delete(serverId)
    deleteMcpServer(serverId)
    notify()
  })
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
    .filter((c) => c.state === 'connected' && c.config.enabled && c.config.injectInstructions && c.instructions)
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
    if (conn.state !== 'connected' || !conn.config.enabled) continue
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
    if (conn.state !== 'connected' || !conn.config.enabled) continue
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
  }).catch((error) => {
    throw new Error(connectionError(error, found.conn.config.headers))
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
    content: text || (result.structuredContent ? JSON.stringify(result.structuredContent) : '(the tool returned no content)'),
    isError: Boolean(result.isError),
    serverId: found.conn.config.id,
    toolName: found.tool.name
  }
}
