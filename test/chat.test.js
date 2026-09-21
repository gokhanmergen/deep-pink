const { suite, sseResponse, writeTestApiKey, message } = require('./support/harness')

suite('chat — streaming, tool reconciliation, web guards', async ({ check, section, subject }) => {
  const { streamChat, toChatParams, htmlToText, runWebFetch } = subject
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

  section('the model naming its own key sentence')
  /*
   * An HTML comment, because `react-markdown` is never given `rehype-raw` and
   * so never renders raw HTML: the marker is invisible from the first
   * character streamed, with no moment where the reader watches the model
   * write scaffolding. It is taken out of the text all the same — invisible
   * is not the same as gone, and it would otherwise travel into an export, a
   * copy to the clipboard, and the next turn's context.
   */
  const marked = subject.takeKeyPointMarkers('The answer is 42.\n\n<!--key: The answer is 42.-->', 1)
  check('the sentence comes out', marked.keyPoints[0] === 'The answer is 42.', marked.keyPoints)
  check('and the comment comes out of the reply', marked.content === 'The answer is 42.', marked.content)

  const spaced = subject.takeKeyPointMarkers('Body.\n<!--  KEY :   A sentence.  -->', 1)
  check('however it was spaced or cased', spaced.keyPoints[0] === 'A sentence.', spaced.keyPoints)

  const bold = subject.takeKeyPointMarkers('Use **LUKS**.\n<!--key: Use **LUKS**.-->', 1)
  check(
    'a sentence keeps the markdown it was written with',
    bold.keyPoints[0] === 'Use **LUKS**.',
    bold.keyPoints
  )

  // More than one, and never more than was asked for.
  const two = subject.takeKeyPointMarkers('A. B.\n<!--key: A.-->\n<!--key: B.-->', 2)
  check('two markers give two sentences', two.keyPoints.length === 2, two.keyPoints)
  check('and both comments leave the reply', two.content === 'A. B.', two.content)
  const capped = subject.takeKeyPointMarkers('A. B.\n<!--key: A.-->\n<!--key: B.-->', 1)
  check('an eager model is held to the setting', capped.keyPoints.length === 1, capped.keyPoints)

  const none = subject.takeKeyPointMarkers('Nothing marked here.', 1)
  check('a reply with no marker names nothing', none.keyPoints.length === 0)
  check('and is handed back untouched', none.content === 'Nothing marked here.')

  const empty = subject.takeKeyPointMarkers('Body.\n<!--key: -->', 1)
  check('an empty marker names nothing', empty.keyPoints.length === 0, empty.keyPoints)
  // And still goes: a model that decides nothing stands out may keep the
  // shape and leave it blank, and a blank marker left in the text reaches the
  // export and the next turn's context.
  check('but is still taken out of the reply', empty.content === 'Body.', empty.content)

  // A reply may talk about HTML comments without meaning this one.
  const innocent = subject.takeKeyPointMarkers('Write <!-- a comment --> like so.', 1)
  check(
    'an unrelated comment is left alone',
    innocent.keyPoints.length === 0 && innocent.content === 'Write <!-- a comment --> like so.',
    innocent
  )

  check(
    'and the instruction actually asks for that shape',
    subject.keyPointPrompt(1).includes('<!--key:')
  )
  check(
    'asking for one does not ask for several',
    !subject.keyPointPrompt(1).includes('up to'),
    subject.keyPointPrompt(1).slice(0, 80)
  )
  check('asking for three says so', subject.keyPointPrompt(3).includes('up to 3'))
  /*
   * Two states, and what each of them means downstream.
   *
   * This was a typed number and is not one any more: how many sentences get
   * marked comes from the question, so a ceiling somebody typed either sat
   * above that count and changed nothing or sat below it and cut an answer
   * off. What is left is the one real choice — never more than one, or one
   * for each thing asked — and the bound behind it, which exists so that
   * "each thing asked" cannot become a fan-out of four hundred yes/no
   * questions in a single request.
   */
  check('only ever one means one', subject.keyPointCeiling(false) === 1)
  check(
    'and one per question is bounded rather than unbounded',
    subject.keyPointCeiling(true) === subject.MOST_KEY_POINTS
  )
  check(
    'the bound is far past anything a reply answers, so the question decides',
    subject.MOST_KEY_POINTS >= 10
  )

  // Still reachable from a settings file written by an older version, or by
  // hand, so it still has to hold whatever it is given.
  check('a number comes through', subject.clampKeyPoints(5) === 5)
  check('zero and below become one', subject.clampKeyPoints(0) === 1 && subject.clampKeyPoints(-3) === 1)
  check('a fraction rounds', subject.clampKeyPoints(2.6) === 3)
  check('nonsense becomes one', subject.clampKeyPoints(Number.NaN) === 1)
  check(
    'and past the ceiling is the ceiling',
    subject.clampKeyPoints(400) === subject.MOST_KEY_POINTS
  )
  check(
    'so the instruction never asks for an absurd number',
    subject.keyPointPrompt(400).includes(`up to ${subject.MOST_KEY_POINTS}`) &&
      !subject.keyPointPrompt(400).includes('400')
  )

  /*
   * The number is a ceiling and the instruction has to say which. A model
   * told "up to five" and nothing else treats five as a quota and finds five
   * in a reply that made one point, which is how the marks stopped meaning
   * anything — so the wording has to name the thing that actually decides,
   * which is the reader's question, and has to say the number is a limit.
   */
  check(
    'asking for several says the count comes from the question',
    /count the separate things they want to know/.test(subject.keyPointPrompt(5)),
    subject.keyPointPrompt(5)
  )
  // Said again at the end of the list, which is the other position a model
  // weights. Measured worth doing: it took one over-marking reply from three
  // marks to two and changed nothing else.
  check(
    'and asks for the count before anything is picked',
    /how many separate things the reader wanted to know/.test(subject.keyPointPrompt(5)),
    subject.keyPointPrompt(5)
  )
  check(
    'and says the number is a limit rather than a target',
    subject.keyPointPrompt(5).includes('5 is a limit, not a target'),
    subject.keyPointPrompt(5)
  )
  check(
    'and still insists one thing asked gets exactly one mark',
    /mark exactly one sentence/.test(subject.keyPointPrompt(5)),
    subject.keyPointPrompt(5)
  )
  // Not inherited from the several-sentence wording: asked for one, there is
  // no count to work out, and the instruction says which one rather than how
  // many.
  check(
    'asking for one names the sentence to pick, not a count',
    subject.keyPointPrompt(1).includes('answers what the reader asked') &&
      !subject.keyPointPrompt(1).includes('limit, not a target'),
    subject.keyPointPrompt(1).slice(0, 200)
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
