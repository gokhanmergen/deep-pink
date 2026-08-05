const { suite, sseResponse, writeTestApiKey, message } = require('./support/harness')

suite('chat — streaming, tool reconciliation, web guards', async ({ check, section, subject }) => {
  const { streamChat, toChatParams, htmlToText, runWebFetch, parseTagEdit } = subject
  writeTestApiKey()

  section('server-sent event parsing')
  const originalFetch = global.fetch
  global.fetch = async () =>
    sseResponse([
      ': OPENROUTER PROCESSING',
      '',
      'data: {"id":"gen-abc","provider":"Anthropic","choices":[{"delta":{"reasoning":"thinking "}}]}',
      'data: {"id":"gen-abc","choices":[{"delta":{"reasoning":"hard"}}]}',
      'data: {"id":"gen-abc","choices":[{"delta":{"content":"Hello, "}}]}',
      'data: {"id":"gen-abc","choices":[{"delta":{"content":"world"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_search","arguments":"{\\"que"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ry\\":\\"cats\\"}"}}]}}]}',
      'data: {"choices":[{"finish_reason":"tool_calls","delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cost":0.0009,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":3}}}',
      'data: [DONE]'
    ])

  const deltas = []
  const result = await streamChat(
    { model: 'test/model', messages: [], attribution: false },
    { onContent: (delta) => deltas.push(delta) }
  )

  check('content is assembled across chunks', result.content === 'Hello, world', result.content)
  check('deltas reach the caller in order', deltas.join('') === 'Hello, world', deltas)
  check('reasoning is assembled separately', result.reasoning === 'thinking hard', result.reasoning)
  check('the serving provider is captured', result.provider === 'Anthropic', result.provider)
  check('the generation id is captured', result.usage.generationId === 'gen-abc')
  check('the finish reason is captured', result.finishReason === 'tool_calls')
  check(
    'fragmented tool-call arguments are stitched back together',
    result.toolCalls.length === 1 &&
      result.toolCalls[0].id === 'call_1' &&
      result.toolCalls[0].name === 'web_search' &&
      result.toolCalls[0].arguments === '{"query":"cats"}',
    result.toolCalls
  )
  check('token counts are read from the final chunk', result.usage.promptTokens === 10)
  check('cost is read from the final chunk', result.usage.costUsd === 0.0009, result.usage.costUsd)
  check('cached prompt tokens are recorded', result.usage.cachedTokens === 4)
  check('reasoning tokens are recorded', result.usage.reasoningTokens === 3)
  check('time to first token is measured', result.usage.timeToFirstTokenMs !== null)

  section('error reporting')
  global.fetch = async () => ({
    ok: false,
    status: 402,
    body: null,
    json: async () => ({ error: { message: 'Insufficient credits', code: 402 } })
  })

  let reported = null
  try {
    await streamChat({ model: 'm', messages: [], attribution: false })
  } catch (err) {
    reported = err.message
  }
  check("the provider's own message is surfaced", reported === 'Insufficient credits', reported)
  global.fetch = originalFetch

  section('tool-call reconciliation')
  const healthy = toChatParams([
    message({ id: '1', role: 'user', content: 'hi' }),
    message({
      id: '2',
      role: 'assistant',
      toolCalls: [{ id: 'c1', name: 'f', arguments: '{}' }]
    }),
    message({
      id: '3',
      role: 'tool',
      content: 'res',
      toolResult: { toolCallId: 'c1', name: 'f', content: 'res', isError: false, durationMs: 5 }
    }),
    message({ id: '4', role: 'assistant', content: 'done' })
  ])
  check(
    'a complete tool round trip passes through untouched',
    healthy.length === 4 && healthy[1].tool_calls.length === 1 && healthy[2].role === 'tool',
    healthy
  )

  const unanswered = toChatParams([
    message({ id: '1', role: 'user', content: 'hi' }),
    message({
      id: '2',
      role: 'assistant',
      content: 'text',
      toolCalls: [{ id: 'missing', name: 'f', arguments: '{}' }]
    })
  ])
  check(
    'a tool call with no result is stripped rather than sent',
    unanswered.length === 2 && unanswered[1].tool_calls === undefined,
    unanswered
  )

  const orphaned = toChatParams([
    message({ id: '1', role: 'user', content: 'hi' }),
    message({
      id: '2',
      role: 'tool',
      content: 'res',
      toolResult: { toolCallId: 'ghost', name: 'f', content: 'res', isError: false, durationMs: 1 }
    })
  ])
  check('a tool result with no call is dropped', orphaned.length === 1, orphaned)

  check(
    'an empty assistant turn is dropped',
    toChatParams([message({ role: 'assistant', content: '' })]).length === 0
  )

  check(
    'a compaction summary is sent as a system message',
    toChatParams([
      message({ id: '1', role: 'system', content: 'SUMMARY', isCompactionSummary: true })
    ])[0].role === 'system'
  )

  section('reading a tagging reply')
  check(
    'plain JSON is read',
    JSON.stringify(parseTagEdit('{"add": ["rust"], "remove": ["python"]}')) ===
      '{"add":["rust"],"remove":["python"]}'
  )
  check(
    'a fenced block is read',
    parseTagEdit('```json\n{"add": ["rust"], "remove": []}\n```').add[0] === 'rust'
  )
  check(
    'prose around the JSON is ignored',
    parseTagEdit('Sure! Here you go:\n{"add":["sql"],"remove":[]}\nHope that helps.').add[0] ===
      'sql'
  )
  const nothing = (raw) => {
    const edit = parseTagEdit(raw)
    return edit.add.length === 0 && edit.remove.length === 0
  }
  check('an unparseable reply changes nothing', nothing('I am not sure what you want.'))
  check('broken JSON changes nothing', nothing('{"add": ["rust",}'))
  check('a JSON array changes nothing', nothing('["rust"]'))
  check(
    'entries that are not strings are dropped',
    parseTagEdit('{"add": ["ok", 3, null, {"x": 1}], "remove": "python"}').add.join(',') === 'ok'
  )
  check(
    'a missing key is an empty list rather than a crash',
    parseTagEdit('{"add": ["rust"]}').remove.length === 0
  )

  section('HTML extraction')
  const text = htmlToText(
    '<html><head><style>a{}</style></head><body><nav>skip</nav><h2>Title</h2>' +
      '<p>Hello &amp; welcome</p><script>bad()</script><ul><li>one</li><li>two</li></ul></body></html>'
  )
  check('scripts and styles are removed', !text.includes('bad()') && !text.includes('a{}'), text)
  check('chrome such as nav is removed', !text.includes('skip'), text)
  check('entities are decoded', text.includes('Hello & welcome'), text)
  check('headings survive as Markdown', text.includes('## Title'), text)
  check('list items survive as Markdown', text.includes('- one') && text.includes('- two'), text)

  section('web fetch refuses what it should')
  const webSettings = {
    enabled: true,
    engine: 'duckduckgo',
    searxngUrl: '',
    maxResults: 5,
    fetchCharLimit: 1000,
    blockedDomains: ['evil.test']
  }
  const refuses = async (url) => {
    try {
      await runWebFetch({ url }, webSettings)
      return false
    } catch {
      return true
    }
  }

  check('file:// URLs', await refuses('file:///etc/passwd'))
  check('localhost', await refuses('http://localhost:8080/'))
  check('the loopback address', await refuses('http://127.0.0.1/'))
  check('private 192.168 addresses', await refuses('http://192.168.1.1/'))
  check('cloud metadata at 169.254.169.254', await refuses('http://169.254.169.254/latest/meta-data/'))
  check('private 10.x addresses', await refuses('http://10.0.0.5/'))
  check('mDNS .local names', await refuses('http://printer.local/'))
  check('domains on the block list', await refuses('https://evil.test/page'))
  check('malformed URLs', await refuses('not a url'))
})
