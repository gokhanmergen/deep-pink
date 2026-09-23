const { suite, sseResponse, writeTestApiKey } = require('./support/harness')

/**
 * What OpenRouter's own web search says it read.
 *
 * The `:online` plugin searches server-side, so there is no tool call to
 * watch and nothing to show: a web-enabled turn answered with no sign that a
 * search had happened, while the same question asked with the built-in
 * `web_search` left a step in the transcript with the results inside it.
 *
 * The evidence arrives as `delta.annotations`, and it arrives repeatedly —
 * five payloads for one search, measured against a real `:online` request on
 * 2026-09-22, with the same pages named more than once. So they are gathered
 * by url rather than appended, which is what these checks are mostly about.
 */
suite('citations — what the :online plugin read', async ({ check, section, subject }) => {
  const { streamChat } = subject
  writeTestApiKey()

  const originalFetch = global.fetch
  const cite = (url, title, content) =>
    JSON.stringify({ type: 'url_citation', url_citation: { url, title, content } })

  const stream = async (lines) => {
    global.fetch = async () => sseResponse([...lines, 'data: [DONE]'])
    return streamChat({ model: 'test/model:online', messages: [], attribution: false }, {})
  }

  section('an ordinary reply carries none')
  const plain = await stream(['data: {"choices":[{"delta":{"content":"hello"}}]}'])
  check('nothing cited, and nothing invented', plain.citations.length === 0, plain.citations)

  section('a reply that searched')
  const searched = await stream([
    `data: {"choices":[{"delta":{"annotations":[${cite('https://a.example/', 'Page A', 'snippet A')}]}}]}`,
    'data: {"choices":[{"delta":{"content":"The answer"}}]}',
    `data: {"choices":[{"delta":{"annotations":[${cite('https://b.example/', 'Page B', 'snippet B')}]}}]}`,
    'data: {"choices":[{"finish_reason":"stop","delta":{}}]}'
  ])
  check('both pages are kept', searched.citations.length === 2, searched.citations)
  check('in the order they arrived', searched.citations.map((c) => c.title).join(',') === 'Page A,Page B')
  check('with the url', searched.citations[0].url === 'https://a.example/')
  check('and what the model was shown of it', searched.citations[0].snippet === 'snippet A')
  check('the reply itself is untouched', searched.content === 'The answer', searched.content)

  /*
   * The behaviour this is really for. OpenRouter repeats the whole list on
   * every annotation chunk, so appending gives five copies of one page and a
   * transcript claiming the model read the same article five times.
   */
  section('the same page named twice is one page')
  const repeated = await stream([
    `data: {"choices":[{"delta":{"annotations":[${cite('https://a.example/', 'Page A', 'first')}]}}]}`,
    `data: {"choices":[{"delta":{"annotations":[${cite('https://a.example/', 'Page A', 'again')},${cite('https://c.example/', 'Page C', 'c')}]}}]}`,
    'data: {"choices":[{"finish_reason":"stop","delta":{}}]}'
  ])
  check('counted once', repeated.citations.length === 2, repeated.citations.map((c) => c.url))
  check('keeping what it said the first time', repeated.citations[0].snippet === 'first')

  section('and malformed ones are stepped over')
  const junk = await stream([
    'data: {"choices":[{"delta":{"annotations":[{"type":"url_citation"},{"type":"file","url_citation":{"url":"https://d.example/"}},{"type":"url_citation","url_citation":{"title":"no url"}}]}}]}',
    'data: {"choices":[{"finish_reason":"stop","delta":{}}]}'
  ])
  check('an annotation with no url, or of another kind, is skipped', junk.citations.length === 0, junk.citations)

  // A page that cites no title is still a page worth naming.
  const titleless = await stream([
    'data: {"choices":[{"delta":{"annotations":[{"type":"url_citation","url_citation":{"url":"https://e.example/"}}]}}]}',
    'data: {"choices":[{"finish_reason":"stop","delta":{}}]}'
  ])
  check('a citation with no title falls back to its url', titleless.citations[0]?.title === 'https://e.example/', titleless.citations)

  global.fetch = originalFetch
})
