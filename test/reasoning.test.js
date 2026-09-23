const { suite } = require('./support/harness')

/**
 * How hard the model is asked to think, and whether you get to read it.
 *
 * Two questions that were one switch. `streamReasoning` asked for the trace
 * back; nothing asked for more or less of it, so a reasoning model ran at
 * whatever its provider's default happened to be — and that differs by
 * provider and changes under the app without the app or the reader knowing.
 *
 * It matters because reasoning is the expensive part: the tokens are billed
 * as output, and the gap between minimal and maximum on a large model is most
 * of what a turn costs and most of how long it takes.
 *
 * What is checked here is the shape that goes on the wire, because that is
 * the whole of the feature — OpenRouter translates between effort words and
 * token budgets for the families that disagree about which they take, and
 * sending it a shape it did not expect is an error mid-conversation.
 */
suite('reasoning — what goes on the wire', async ({ check, section, subject }) => {
  const { getDb, repo, reasoning, reasoningFor, DEFAULT_SETTINGS } = subject
  getDb()

  const { EFFORTS, DEFAULT_REASONING, REASONING_LABELS, reasoningParam, resolveReasoning, shortReasoningLabel } =
    reasoning

  const at = (mode, budgetTokens = 4096) => ({ mode, budgetTokens })

  section('saying nothing')
  check('shown, it asks only to be shown', JSON.stringify(reasoningParam(at('auto'), true)) === '{"exclude":false}')
  /*
   * The half that did not work. Left unsaid, a provider returns its reasoning
   * by default — so the switch asking not to see it sent nothing and changed
   * nothing, and the trace arrived anyway.
   */
  check(
    'hidden, it actually says so',
    JSON.stringify(reasoningParam(at('auto'), false)) === '{"exclude":true}'
  )

  section('an effort')
  for (const effort of EFFORTS) {
    const body = reasoningParam(at(effort), true)
    check(`${effort} is sent as itself`, body.effort === effort, body)
    check(`${effort} carries exclude too`, body.exclude === false, body)
  }
  check('and no budget beside it', reasoningParam(at('high'), true).max_tokens === undefined)

  section('a budget')
  const budget = reasoningParam(at('budget', 3000), true)
  check('is sent as max_tokens', budget.max_tokens === 3000, budget)
  /*
   * The two are mutually exclusive at OpenRouter, which is why they are one
   * setting here rather than two fields somebody can set against each other.
   */
  check('and never beside an effort', budget.effort === undefined, budget)
  check('rounded, because tokens are whole', reasoningParam(at('budget', 2000.6), true).max_tokens === 2001)
  check(
    'a budget of nothing falls back rather than asking for none',
    reasoningParam(at('budget', 0), true).max_tokens === undefined,
    reasoningParam(at('budget', 0), true)
  )

  section('none at all')
  check(
    'is the documented switch, not an effort of zero',
    JSON.stringify(reasoningParam(at('off'), true)) === '{"enabled":false}'
  )
  check('and does not ask to be shown what there is not', reasoningParam(at('off'), false).exclude === undefined)

  section('the thread decides, or the settings do')
  check('the thread when it has an answer', resolveReasoning(at('max'), at('low')).mode === 'max')
  check('the settings when it does not', resolveReasoning(null, at('low')).mode === 'low')
  check('and the built-in default when nothing does', resolveReasoning(null, null).mode === DEFAULT_REASONING.mode)

  section('what the composer says')
  check('automatic is the word, not a level', shortReasoningLabel(at('auto')) === 'Thinking')
  check('a rung is its own name', shortReasoningLabel(at('xhigh')) === REASONING_LABELS.xhigh)
  check('a budget is the number', shortReasoningLabel(at('budget', 3000)) === '3,000 tokens')

  /* ---------------------------------------------------------------- *
   * What the engine decides to send
   * ---------------------------------------------------------------- */

  /*
   * A model the catalogue says cannot reason is not asked how hard to think.
   * It would be ignored by most and rejected by some, and either way it is
   * the app talking to itself.
   */
  section('a model with no opinion')
  repo.setCache('models', [
    { id: 'test/thinker', name: 'Thinker', supportsReasoning: true, supportsTools: true, supportedParameters: ['reasoning'], inputModalities: ['text'], outputModalities: ['text'], contextLength: 8000, pricing: {}, created: 0 },
    { id: 'test/plain', name: 'Plain', supportsReasoning: false, supportsTools: true, supportedParameters: [], inputModalities: ['text'], outputModalities: ['text'], contextLength: 8000, pricing: {}, created: 0 }
  ])

  const thread = repo.createThread('Reasoning fixture')
  const withConfig = (config) => ({ ...repo.getThread(thread.id), config: { ...repo.getThread(thread.id).config, ...config } })
  const settings = (over) => ({ ...DEFAULT_SETTINGS, ...over })

  check(
    'is sent nothing at all',
    reasoningFor(withConfig({ reasoning: at('high') }), settings(), 'test/plain') === null
  )
  check(
    'while one that can is asked',
    reasoningFor(withConfig({ reasoning: at('high') }), settings(), 'test/thinker')?.effort === 'high'
  )
  /*
   * A first launch, an offline start, an id no longer in the catalogue. Most
   * models reason; being wrong this way costs a parameter that gets ignored,
   * and being wrong the other way loses the feature without saying so.
   */
  check(
    'and one nobody has heard of is assumed to',
    reasoningFor(withConfig({ reasoning: at('low') }), settings(), 'test/never-seen')?.effort === 'low'
  )

  section('and the two settings meet')
  check(
    'the thread says how hard, the settings say whether to show it',
    JSON.stringify(
      reasoningFor(withConfig({ reasoning: at('medium') }), settings({ streamReasoning: false }), 'test/thinker')
    ) === '{"effort":"medium","exclude":true}'
  )
  check(
    'with no thread answer, the global effort is used',
    reasoningFor(withConfig({ reasoning: null }), settings({ reasoning: at('minimal') }), 'test/thinker')
      ?.effort === 'minimal'
  )
})
