const { suite } = require('./support/harness')

/**
 * Documents — the reader between a remote model and the window.
 *
 * Everything in a set arrives from somewhere else, so the parser is the
 * boundary: what it lets through is presented as documents, and what it
 * refuses is shown as the code it always was. These check both halves — that a
 * well-formed set survives intact, and that a broken or hostile one comes back
 * null rather than as something a component would try to render.
 */

suite('documents — what a reply may be split into', async ({ check, section, subject }) => {
  const { docs } = subject
  const { parseDocs, isDocsFence, DOCS_FENCE, DOCS_LIMITS, DOCS_PROMPT } = docs

  const parse = (value) => parseDocs(DOCS_FENCE, JSON.stringify(value))
  const two = (extra = {}) => ({
    documents: [
      { title: 'One', body: 'first' },
      { title: 'Two', body: 'second' }
    ],
    ...extra
  })

  section('which fences are ours')
  check('the documents fence is', isDocsFence(DOCS_FENCE))
  check('however it is cased', isDocsFence('DP-DOCS'))
  check('a language is not', !isDocsFence('json') && !isDocsFence('markdown'))
  check('and neither is the chart fence', !isDocsFence('dp-chart'))
  check('a fence that is not ours parses to nothing', parseDocs('json', '{"documents":[]}') === null)

  section('a well-formed set')
  const set = parse(two({ title: 'Migration plan' }))
  check('it parses', set !== null)
  check('the set keeps its heading', set.title === 'Migration plan', set.title)
  check('and both documents', set.documents.length === 2, set.documents.length)
  check('in the order they were written',
    set.documents.map((d) => d.title).join() === 'One,Two')
  check('with their bodies untouched', set.documents[1].body === 'second')
  check('a summary is null when none was given', set.documents[0].summary === null)
  check('nothing was trimmed', set.notes.length === 0, set.notes)

  const described = parse({
    documents: [
      { title: 'A', body: 'x', summary: 'the first one' },
      { name: 'B', content: 'y', description: 'the second' }
    ]
  })
  check('a summary is kept when there is one', described.documents[0].summary === 'the first one')
  check(
    'and the names a model is likely to reach for are read too',
    described.documents[1].title === 'B' && described.documents[1].body === 'y',
    described.documents[1]
  )
  check('including for the summary', described.documents[1].summary === 'the second')

  // A model asked for a list often writes a list.
  const bare = parseDocs(
    DOCS_FENCE,
    JSON.stringify([{ title: 'One', body: 'a' }, { title: 'Two', body: 'b' }])
  )
  check('a bare array is a set too', bare !== null && bare.documents.length === 2)
  check('with no heading over it', bare.title === null)

  section('what is not a set')
  // One document is not much of a set and the prompt says so — but a model
  // that writes one anyway has still written a document, and showing its JSON
  // instead would be the app being pedantic at the reader's expense.
  const solo = parse({ documents: [{ title: 'Only', body: 'x' }] })
  check('one document is still shown', solo !== null && solo.documents.length === 1, solo)
  check('and none of them is nothing at all', parse({ documents: [] }) === null)
  check('a set that is not there', parse({ title: 'No documents here' }) === null)
  check('text that is not JSON', parseDocs(DOCS_FENCE, 'not json at all') === null)
  check('half of it, as it streams', parseDocs(DOCS_FENCE, '{"documents":[{"title":"On') === null)
  check('a number', parseDocs(DOCS_FENCE, '42') === null)
  check('null', parseDocs(DOCS_FENCE, 'null') === null)
  check(
    'entries that are not objects are skipped',
    parse({ documents: ['a string', 42, null, { title: 'Real', body: 'x' }] }).documents.length === 1
  )
  check(
    'and a document with neither a name nor anything in it is not one',
    parse({ documents: [{ title: 'Real', body: 'x' }, { title: '', body: '   ' }] }).documents
      .length === 1
  )
  check('a finished set is not marked partial', parse(two()).partial === false)

  section('limits, and saying what they cost')
  const many = parse({
    documents: Array.from({ length: DOCS_LIMITS.documents + 6 }, (_, i) => ({
      title: `Doc ${i}`,
      body: 'x'
    }))
  })
  check('a set past the limit is capped', many.documents.length === DOCS_LIMITS.documents)
  check('and says so rather than dropping them quietly',
    many.notes.some((n) => n.includes(String(DOCS_LIMITS.documents))), many.notes)

  const longBody = parse({
    documents: [
      { title: 'Huge', body: 'x'.repeat(DOCS_LIMITS.body + 500) },
      { title: 'Small', body: 'y' }
    ]
  })
  check('a body past the limit is cut', longBody.documents[0].body.length === DOCS_LIMITS.body)
  check('and named in the notes, so the reader knows it is not all there',
    longBody.notes.some((n) => n.includes('Huge')), longBody.notes)

  const longTitle = parse({
    documents: [
      { title: 'T'.repeat(DOCS_LIMITS.title + 80), body: 'a' },
      { title: 'Two', body: 'b' }
    ]
  })
  check('a title is bounded to one line’s worth',
    longTitle.documents[0].title.length === DOCS_LIMITS.title)

  check(
    'a block larger than the whole limit is refused before it is parsed',
    parseDocs(DOCS_FENCE, 'x'.repeat(DOCS_LIMITS.bytes + 1)) === null
  )

  section('titles are labels, and bodies are not')
  const shapes = parse({
    documents: [
      { title: '  spread   over \n lines  ', body: 'kept\n\nas written' },
      { title: 'Two', body: 'b' }
    ]
  })
  check('a title is flattened to one line', shapes.documents[0].title === 'spread over lines')
  check('a body keeps its shape, because it is Markdown',
    shapes.documents[0].body === 'kept\n\nas written')
  check(
    'a document with a body but no title still gets one',
    parse({ documents: [{ body: 'a' }, { body: 'b' }] }).documents[0].title === 'Document 1'
  )

  section('nothing here becomes markup')
  // Bodies go to the same Markdown renderer the rest of a reply does, which
  // never emits HTML — so the parser's job is to pass text through unchanged
  // rather than to sanitise it. What must not happen is a title carrying a
  // newline into a one-line element, which is what flattening is for.
  const hostile = parse({
    documents: [
      { title: '<script>alert(1)</script>', body: '<img src=x onerror=alert(1)>' },
      { title: 'Two', body: 'b' }
    ]
  })
  check('a title is text, whatever it says',
    hostile.documents[0].title === '<script>alert(1)</script>')
  check('and so is a body', hostile.documents[0].body === '<img src=x onerror=alert(1)>')
  check('neither became anything but a string',
    typeof hostile.documents[0].title === 'string' && typeof hostile.documents[0].body === 'string')

  section('a set that is still arriving')
  // A block streams a character at a time, so for most of its life it is not
  // valid JSON. What has finished arriving is shown as it lands rather than
  // held back as a wall of braces.
  const whole = JSON.stringify({
    title: 'Three things',
    documents: [
      { title: 'One', body: 'a' },
      { title: 'Two', body: 'b' },
      { title: 'Three', body: 'c' }
    ]
  })

  const soFar = (n) => parseDocs(DOCS_FENCE, whole.slice(0, n), true)
  const counts = []
  for (let n = 1; n <= whole.length; n++) {
    const got = soFar(n)
    counts.push(got ? got.documents.length : 0)
  }
  check('nothing is claimed before the first document lands', counts[0] === 0)
  check('the count only ever goes up', counts.every((n, i) => i === 0 || n >= counts[i - 1]), counts)
  check('and reaches the whole set', counts[counts.length - 1] === 3, counts[counts.length - 1])
  check(
    'what has arrived is marked as partial',
    soFar(whole.length - 30)?.partial === true,
    soFar(whole.length - 30)
  )
  check('and the complete thing is not', parseDocs(DOCS_FENCE, whole).partial === false)

  // The same forgiveness when a reply was cut off rather than still coming:
  // a set that never finished is still the documents that did.
  const cutOff = parseDocs(DOCS_FENCE, whole.slice(0, whole.length - 30))
  check('a set that was cut off shows what did arrive', cutOff?.documents.length === 2, cutOff)
  check('and says it is not all of it', cutOff?.partial === true)

  section('closing it back up is not fooled by what is inside a string')
  const braces = parse({
    documents: [
      { title: 'A', body: 'if (x) { y } else { z }' },
      { title: 'B', body: '}]}' }
    ]
  })
  check('braces inside a body are just text', braces.documents.length === 2, braces)
  check('and the body is unchanged', braces.documents[1].body === '}]}')

  const quoted = parse({
    documents: [
      { title: 'A', body: 'he said "hi" } and left' },
      { title: 'B', body: 'b' }
    ]
  })
  check('so are escaped quotes', quoted.documents.length === 2, quoted)

  const fenced = parse({
    documents: [
      { title: 'A', body: '```sql\nSELECT 1;\n```' },
      { title: 'B', body: 'b' }
    ]
  })
  check('and a fenced code block inside a body', fenced.documents.length === 2, fenced)

  check('nothing readable at all is still nothing', parseDocs(DOCS_FENCE, '{"documents":[{"title":"Half of a tit', true) === null)

  section('what the model is told')
  check('the prompt names the fence', DOCS_PROMPT.includes(DOCS_FENCE))
  check('and the limit it will be held to', DOCS_PROMPT.includes(String(DOCS_LIMITS.documents)))
  check('it says when not to use this at all', DOCS_PROMPT.includes('only when'))
  check('and that fewer than two is not worth it', DOCS_PROMPT.includes('Fewer than two'))
  check('it asks for one line, so a fenced body cannot end the block',
    DOCS_PROMPT.includes('single line'))
  check('it refuses HTML out loud', DOCS_PROMPT.includes('<script>'))
})
