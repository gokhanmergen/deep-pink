// Launched with ELECTRON_RUN_AS_NODE by the MCP suite, never by the app itself.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js')

const server = new Server({ name: 'stdio-fixture', version: '1' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }]
}))
server.setRequestHandler(CallToolRequestSchema, () => ({
  content: [{ type: 'text', text: 'stdio works' }]
}))
// A pipe nobody drains would block this server before it initializes.
process.stderr.write('fixture log\n'.repeat(100_000))
void server.connect(new StdioServerTransport())
