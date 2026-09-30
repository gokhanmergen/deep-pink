const { createServer } = require('node:http')
const { createServer: createHttpsServer } = require('node:https')
const { randomUUID } = require('node:crypto')
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const {
  ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListPromptsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js')

/** A real sessionful MCP endpoint with rotatable bearer auth and paginated lists. */
async function mcpServer(tls) {
  const sessions = new Map()
  const state = { key: 'first-test-key', failTools: false, extraTool: false, requests: [], clients: [] }
  const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })
  const handle = async (req, res) => {
    state.requests.push({ method: req.method, authorization: req.headers.authorization })
    if (req.headers.authorization !== `Bearer ${state.key}`) {
      res.writeHead(401).end('A valid bearer key is required.')
      return
    }
    let body
    if (req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      body = JSON.parse(Buffer.concat(chunks).toString())
    }
    let transport = sessions.get(req.headers['mcp-session-id'])
    if (!transport) {
      if (body?.method !== 'initialize') {
        res.writeHead(404).end('No session')
        return
      }
      const client = new Server({ name: 'fixture', version: '1' }, {
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }
      })
      client.setRequestHandler(ListToolsRequestSchema, (request) => {
        if (state.failTools) throw new Error('Fixture discovery failed')
        if (request.params?.cursor) return { tools: [tool('second'), ...(state.extraTool ? [tool('new_tool')] : [])] }
        return { tools: [tool('first')], nextCursor: 'tools-page-2' }
      })
      client.setRequestHandler(ListResourcesRequestSchema, (request) => ({
        resources: [{ uri: `fixture://${request.params?.cursor ? 'second' : 'first'}`, name: 'resource' }],
        ...(!request.params?.cursor ? { nextCursor: 'resources-page-2' } : {})
      }))
      client.setRequestHandler(ListPromptsRequestSchema, (request) => ({
        prompts: [{ name: request.params?.cursor ? 'second' : 'first' }],
        ...(!request.params?.cursor ? { nextCursor: 'prompts-page-2' } : {})
      }))
      client.setRequestHandler(CallToolRequestSchema, (request) => ({
        content: [{ type: 'text', text: JSON.stringify({ tool: request.params.name }) }]
      }))
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => sessions.set(id, transport),
        enableJsonResponse: false
      })
      state.clients.push(client)
      await client.connect(transport)
    }
    await transport.handleRequest(req, res, body)
  }
  const listener = (req, res) => void handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
  const server = tls ? createHttpsServer(tls, listener) : createServer(listener)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    state,
    url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}/mcp`,
    close: async () => {
      await Promise.all(state.clients.map((client) => client.close().catch(() => undefined)))
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

module.exports = { mcpServer }
