const { suite, sseResponse, writeTestApiKey } = require('./support/harness')

/**
 * What the app asks a model to answer with.
 *
 * Its own file because the mistake it guards is a 404 rather than a worse
 * answer, and because it was made twice in the same afternoon.
 *
 * A model that can draw does not draw unless `modalities` says so — the same
 * request without it comes back describing the picture it would have made.
 * That much was known. What was not is that the pair is not universal: an
 * image-*only* model refuses to be asked for text alongside.
 *
 *   microsoft/mai-image-2.6, modalities ['image','text']
 *     404 No endpoints found that support the requested output modalities
 *   microsoft/mai-image-2.6, modalities ['image']
 *     streamed, one image, $0.038952
 *
 * So the list is the model's own, passed through from the catalogue rather
 * than assembled at the call site. The catalogue is where it is known, and
 * anywhere else is a guess that fails the whole turn.
 */
suite('modalities — asking for what the model can answer with', async ({ check, section, subject }) => {
  const { streamChat } = subject
  writeTestApiKey()

  const originalFetch = global.fetch
  /** The body of the last request, so the test can read what was sent. */
  let sent = null
  global.fetch = async (_url, init) => {
    sent = JSON.parse(init.body)
    return sseResponse([
      'data: {"choices":[{"finish_reason":"stop","delta":{"content":"ok"}}]}',
      'data: [DONE]'
    ])
  }

  const send = async (modalities) => {
    sent = null
    await streamChat({ model: 'test/model', messages: [], attribution: false, modalities }, {})
    return sent
  }

  section('an ordinary model is asked for nothing special')
  check('no modalities key at all', (await send(undefined)).modalities === undefined, sent)
  // An empty list is the same statement as no list, and sending one would be
  // asking for a model that answers with nothing.
  check('nor for an empty list', (await send([])).modalities === undefined, sent)

  section('a model that draws is asked for what it draws')
  const both = await send(['image', 'text'])
  check('the pair goes through as given', JSON.stringify(both.modalities) === '["image","text"]', both.modalities)

  /*
   * The one that was wrong. Hardcoding the pair turned every image-only model
   * into a 404 — and there are 44 of them that the catalogue could not even
   * see until it learned to ask for them.
   */
  const only = await send(['image'])
  check('and an image-only model is asked for images alone', JSON.stringify(only.modalities) === '["image"]', only.modalities)
  check('with no text smuggled in beside it', !(only.modalities ?? []).includes('text'), only.modalities)

  section('and the rest of the request is unchanged by it')
  check('the model is still the model', only.model === 'test/model', only.model)
  check('it still streams', only.stream === true, only.stream)
  check('and still asks for its accounting', Boolean(only.usage?.include), only.usage)

  global.fetch = originalFetch
})
