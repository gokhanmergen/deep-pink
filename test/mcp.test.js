const path = require('node:path')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { suite, settle } = require('./support/harness')
const { mcpServer } = require('./support/mcp-http-server')

suite('MCP — authentication, discovery, lifecycle and certificate trust', async ({ check, section, subject, tmpDir }) => {
  const { mcp, mcpHttp } = subject
  const fixtures = []
  const status = (id) => mcp.getStatuses().find((entry) => entry.id === id)
  try {
    section('authenticated HTTP sessions')
    const http = await mcpServer()
    fixtures.push(http)
    const server = mcp.createServer({
      name: 'Fixture', transport: 'http', url: http.url, enabled: true,
      headers: { Authorization: 'Bearer first-test-key' }
    })
    const connected = await mcp.connect(server.id)
    check('initialization and inventory complete before showing connected', connected.state === 'connected', connected)
    check('all tool pages arrive', connected.tools.length === 2, connected.tools)
    check('resource and prompt counts also include all pages', connected.resourceCount === 2 && connected.promptCount === 2)
    const first = connected.tools.find((tool) => tool.name === 'first')
    const called = await mcp.callTool(first.qualifiedName, {})
    check('the qualified function calls the original server tool', JSON.parse(called.content).tool === 'first')
    check('auth is present on POST and the SSE listener',
      http.state.requests.every((req) => req.authorization === 'Bearer first-test-key') &&
      http.state.requests.some((req) => req.method === 'GET'), http.state.requests)

    section('changing an existing bearer key')
    http.state.key = 'second-test-key'
    await mcp.updateServer(server.id, { headers: { Authorization: 'Bearer second-test-key' } })
    check('editing headers reconnects with the new credentials', status(server.id).state === 'connected', status(server.id))
    check('tool calls also use the new credentials', !(await mcp.callTool(status(server.id).tools[0].qualifiedName, {})).isError)
    await mcp.updateServer(server.id, { headers: { Authorization: 'Bearer incorrect-key' } })
    check('an invalid key becomes an explicit auth error', status(server.id).state === 'error' && /401/.test(status(server.id).error), status(server.id))
    check('an error status has no stale tools or server instructions', status(server.id).tools.length === 0 && status(server.id).instructions === null)
    await mcp.updateServer(server.id, { headers: { Authorization: 'Bearer second-test-key' } })

    section('dynamic inventory and settings')
    http.state.extraTool = true
    await http.state.clients.at(-1).sendToolListChanged()
    for (let i = 0; i < 30 && status(server.id).tools.length !== 3; i++) await settle(50)
    check('a server notification refreshes its tool list', status(server.id).tools.length === 3, status(server.id))
    const sessionCount = http.state.clients.length
    await mcp.updateServer(server.id, { name: 'Renamed', disabledTools: ['first'] })
    check('a rename reaches both the tool labels and qualified names', status(server.id).tools.every((tool) => tool.serverName === 'Renamed'))
    check('renaming and disabling a tool does not reconnect', http.state.clients.length === sessionCount)
    check('disabled tools are absent from the model request', !mcp.getToolParams(null).some((param) => param.function.name === status(server.id).tools.find((tool) => tool.name === 'first').qualifiedName))
    const changing = mcp.updateServer(server.id, { headers: { Authorization: 'Bearer second-test-key', 'X-Fixture': 'new' } })
    const disabling = mcp.updateServer(server.id, { enabled: false })
    await Promise.all([changing, disabling])
    check('a disable after reconnect wins and clears the inventory', status(server.id).state === 'disconnected' && status(server.id).tools.length === 0)
    check('a disabled server supplies no tools to a chat', mcp.getToolParams(null).length === 0)

    section('discovery failures are not success')
    http.state.failTools = true
    await mcp.updateServer(server.id, { enabled: true })
    check('failed tool discovery is an error instead of green with zero tools', status(server.id).state === 'error' && /discovery failed/.test(status(server.id).error), status(server.id))
    await mcp.disconnect(server.id)
    check('disconnect clears an earlier error even without a live client', status(server.id).state === 'disconnected' && status(server.id).error === null)

    section('qualified names remain distinct and valid')
    const long = 'a_very_long_tool_name_that_used_to_be_truncated_'
    const names = [
      mcp.qualifiedToolName('same', long + 'one', 'server-1'),
      mcp.qualifiedToolName('same', long + 'two', 'server-1'),
      mcp.qualifiedToolName('same', long + 'one', 'server-2'),
      mcp.qualifiedToolName('same', 'punctuated.name'),
      mcp.qualifiedToolName('same', 'punctuated_name')
    ]
    check('long names, punctuation and equal server labels cannot merge tools', new Set(names).size === names.length, names)
    check('all names fit the model API function-name constraints', names.every((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name)), names)

    section('HTTPS trusts only the chosen certificate')
    const keyPath = path.join(tmpDir, 'fixture.key')
    const certPath = path.join(tmpDir, 'fixture.crt')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=MCP fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' })
    const cert = fs.readFileSync(certPath, 'utf8')
    const https = await mcpServer({ key: fs.readFileSync(keyPath), cert })
    fixtures.push(https)
    const secure = mcp.createServer({ name: 'Secure fixture', transport: 'http', url: https.url,
      enabled: true, headers: { Authorization: 'Bearer first-test-key' } })
    const untrusted = await mcp.connect(secure.id)
    check('an untrusted certificate is refused with an actionable message', untrusted.state === 'error' && /certificate.*not trusted/.test(untrusted.error), untrusted)
    await mcp.updateServer(secure.id, { caCertificate: cert })
    check('importing the certificate reconnects successfully', status(secure.id).state === 'connected', status(secure.id))
    const secureCall = await mcp.callTool(status(secure.id).tools[0].qualifiedName, {})
    check('authenticated tool calls work through the trusted HTTPS session', !secureCall.isError)
    await mcp.updateServer(secure.id, { url: https.url.replace('127.0.0.1', 'localhost') })
    check('trusting a CA still validates the hostname', status(secure.id).state === 'error', status(secure.id))
    const scopedFetch = mcpHttp.serverFetch(new URL(https.url), cert)
    let escaped = false
    try { await scopedFetch('https://example.invalid/mcp') } catch { escaped = true }
    check('the imported CA cannot be used for another origin', escaped)
    const redacted = mcpHttp.connectionError(new Error('key secret-key failed'), { Authorization: 'Bearer secret-key' })
    check('transport errors do not expose a saved bearer key', !redacted.includes('secret-key'), redacted)

    section('Obsidian-style constrained CA and a pinned server certificate')
    const caKey = path.join(tmpDir, 'constrained-ca.key')
    const caPath = path.join(tmpDir, 'constrained-ca.crt')
    const leafKey = path.join(tmpDir, 'leaf.key')
    const leafCsr = path.join(tmpDir, 'leaf.csr')
    const leafPath = path.join(tmpDir, 'leaf.crt')
    const leafExt = path.join(tmpDir, 'leaf.ext')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=Constrained local CA', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'nameConstraints=critical,permitted;IP:127.0.0.1/255.255.255.255,permitted;DNS:localhost',
      '-keyout', caKey, '-out', caPath], { stdio: 'ignore' })
    execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes',
      '-subj', '/CN=Local server', '-keyout', leafKey, '-out', leafCsr], { stdio: 'ignore' })
    fs.writeFileSync(leafExt, 'basicConstraints=critical,CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
    execFileSync('openssl', ['x509', '-req', '-in', leafCsr, '-CA', caPath, '-CAkey', caKey,
      '-CAcreateserial', '-days', '1', '-extfile', leafExt, '-out', leafPath], { stdio: 'ignore' })
    const leaf = fs.readFileSync(leafPath, 'utf8')
    const constrained = await mcpServer({ key: fs.readFileSync(leafKey), cert: leaf + fs.readFileSync(caPath, 'utf8') })
    fixtures.push(constrained)
    const pinned = mcp.createServer({ name: 'Pinned local server', transport: 'http', url: constrained.url,
      caCertificate: leaf, enabled: true, headers: { Authorization: 'Bearer first-test-key' } })
    const pinnedStatus = await mcp.connect(pinned.id)
    check('the exact server certificate works under Electron with a constrained issuer', pinnedStatus.state === 'connected', pinnedStatus)
    check('a pinned connection supports authenticated tool calls', !(await mcp.callTool(pinnedStatus.tools[0].qualifiedName, {})).isError)
    await mcp.updateServer(pinned.id, { caCertificate: cert })
    check('a different imported certificate cannot authenticate the server', status(pinned.id).state === 'error', status(pinned.id))
    const constraintError = mcpHttp.connectionError(new Error('unsupported name constraint type'), {})
    check('the runtime constraint error explains which certificate to import', /server certificate instead/.test(constraintError), constraintError)

    section('stdio remains usable')
    const local = mcp.createServer({ name: 'Process fixture', command: process.execPath,
      args: [path.join(__dirname, 'support', 'mcp-stdio-server.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' }, enabled: true })
    const localStatus = await mcp.connect(local.id)
    check('a verbose local process can initialize without blocking on stderr', localStatus.state === 'connected', localStatus)
    check('stdio tools are callable', (await mcp.callTool(localStatus.tools[0].qualifiedName, {})).content === 'stdio works')
  } finally {
    await mcp.disconnectAll()
    await Promise.all(fixtures.map((fixture) => fixture.close()))
  }
})
