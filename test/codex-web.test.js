const { suite } = require('./support/harness')
const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough, Writable } = require('node:stream')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

suite('Codex web tool runtime', async ({ check, subject }) => {
  const { assembleContext, streamCodexChat, DEFAULT_SETTINGS, WEB_SEARCH_TOOL } = subject
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.codex.nativeWebSearch = true
  settings.web.enabled = true
  const thread = { config: { model: 'codex:test-model', webAccessEnabled: true } }
  const context = assembleContext(thread, settings, 'codex')
  check('native mode keeps the native search preference',
    context.codexNativeWebSearch && context.tools.length === 0)
  check('native instructions permit the required JavaScript wrapper',
    context.systemText.includes('code-mode JavaScript wrapper'))

  for (const config of [
    { webAccessEnabled: false },
    { disabledPromptSegments: ['web'] },
    { disabledPromptSegments: ['tools'] }
  ]) {
    const disabled = assembleContext({ config: { ...thread.config, ...config } }, settings, 'codex')
    check(`web controls disable native and client web access: ${JSON.stringify(config)}`,
      !disabled.codexNativeWebSearch && disabled.tools.length === 0)
  }

  // Use the real provider and its JSON-RPC transport with a simulated child.
  // No real Codex process, credentials or search endpoint is used by this suite.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-pink-codex-bin-'))
  const binary = path.join(binDir, process.platform === 'win32' ? 'codex.exe' : 'codex')
  fs.writeFileSync(binary, '', { mode: 0o755 })
  const originalPath = process.env.PATH
  const originalSpawn = childProcess.spawn
  process.env.PATH = binDir
  try {
    for (const scenario of [
      { native: true, namespace: null, tool: null, allowed: false },
      { native: false, namespace: 'codex_app', tool: 'web_search', allowed: true },
      { native: false, namespace: null, tool: null, allowed: false },
      { native: false, namespace: null, tool: 'web_search', allowed: true },
      { native: false, namespace: '', tool: 'web_search', allowed: true },
      { native: false, namespace: 'unrelated', tool: 'web_search', allowed: false },
      { native: false, namespace: 'codex_app', tool: 'shell', allowed: false }
    ]) {
      let threadParams
      let launchArgs
      let handled = 0
      let reply
      childProcess.spawn = (_binary, args) => {
        launchArgs = args
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        let closed = false
        const close = () => {
          if (closed) return
          closed = true
          child.emit('close', 0, null)
        }
        child.kill = close
        const emit = (message) => child.stdout.write(`${JSON.stringify(message)}\n`)
        child.stdin = new Writable({
          write(chunk, _encoding, done) {
            const message = JSON.parse(chunk.toString())
            queueMicrotask(() => {
              if (message.method === 'initialize') {
                emit({ id: message.id, result: {} })
              } else if (message.method === 'thread/start') {
                threadParams = message.params
                emit({ id: message.id, result: { thread: { id: 'test-thread' } } })
              } else if (message.method === 'turn/start') {
                emit({ id: message.id, result: {} })
                if (!scenario.tool) {
                  emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
                  return
                }
                emit({ id: 900, method: 'item/tool/call', params: {
                  threadId: 'test-thread', turnId: 'test-turn', callId: 'search-call',
                  namespace: scenario.namespace, tool: scenario.tool,
                  arguments: { query: 'current release notes' }
                } })
              } else if (message.id === 900) {
                reply = message
                emit({ method: 'item/agentMessage/delta', params: { delta: 'Search completed.' } })
                emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
              } else if (message.method === 'account/usage/read') {
                emit({ id: message.id, result: {} })
              }
            })
            done()
          }
        })
        child.stdin.on('finish', close)
        return child
      }
      const result = await streamCodexChat({
        model: 'codex:test-model', messages: [{ role: 'user', content: 'Search current release notes.' }],
        nativeWebSearch: scenario.native, tools: scenario.tool ? [WEB_SEARCH_TOOL] : [], attribution: false
      }, {
        onDynamicToolCall: async (call) => {
          handled += 1
          return { toolCallId: call.id, name: call.name, content: 'Retrieved live results.', isError: false, durationMs: 1 }
        }
      })
      check(`tool authorization: ${JSON.stringify(scenario)}`,
        scenario.allowed
          ? handled === 1 && reply.result?.success === true && result.toolCalls.length === 1
          : handled === 0 && (!scenario.tool || Boolean(reply.error)) && result.toolCalls.length === 0,
        { handled, reply })
      const enabled = (feature) => launchArgs[launchArgs.indexOf(feature) - 1] === '--enable'
      const disabled = (feature) => launchArgs[launchArgs.indexOf(feature) - 1] === '--disable'
      const webEnabled = scenario.native || Boolean(scenario.tool)
      check('web access controls the required tool runtime', webEnabled
        ? enabled('code_mode') && enabled('code_mode_host') && !launchArgs.includes('code_mode_only')
        : disabled('code_mode') && disabled('code_mode_host') && disabled('code_mode_only'))
      check('tool runtime preserves the shell, computer, plugin and MCP restrictions',
        ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'plugins', 'apps'].every(disabled) &&
        launchArgs.includes('mcp_servers={}'))
      if (scenario.native) {
        check('native option keeps standalone live search enabled',
          launchArgs.includes('web_search="live"') && enabled('standalone_web_search'))
        check('native turn allows the wrapper without registering fallback tools',
          !threadParams.dynamicTools &&
          threadParams.developerInstructions.includes('code-mode JavaScript wrapper'))
      }
    }
  } finally {
    childProcess.spawn = originalSpawn
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    fs.rmSync(binDir, { recursive: true, force: true })
  }
})
