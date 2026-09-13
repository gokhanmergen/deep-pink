const path = require('node:path')
const { suite } = require('./support/harness')

/**
 * Where a conversation opens.
 *
 * A transcript used to open at its very bottom, which is the end of the last
 * thing the model said rather than the start of the last thing you asked. What
 * it does now is one sentence: the last message you sent is at the top of the
 * window, with the answer running down from it — the view you had the moment
 * you pressed send.
 *
 * The first attempt at this took the top of the last exchange or the bottom,
 * whichever came first, and was therefore wrong in exactly the common case: a
 * document cannot be scrolled past its end, so for any exchange shorter than
 * the window — most of them — "whichever came first" was the bottom, and
 * nothing changed. Putting a message at the top means having somewhere to
 * scroll it to. That is what the tail is, and why these check it and the
 * landing together rather than apart.
 *
 * The last exchange is not put hard against the top edge, either: when there
 * is conversation above it, a line or two of that stays on screen, because the
 * end of a long thread pinned flush to the top reads exactly like the start of
 * a short one.
 */
global.window = { deepPink: { platform: 'linux' } }

suite('landing — where a conversation opens', async ({ check, section }) => {
  const { landingPoint, tailHeight } = require(path.join(__dirname, '..', '.test-build', 'store.js'))

  const VIEWPORT = 700
  /** Enough of the previous reply to read, when there is one. */
  const GLIMPSE = 88
  /** And the bare margin when the exchange is the whole conversation. */
  const EDGE = 24

  /**
   * A transcript, as the page would lay it out: `before` pixels of older
   * conversation, then an exchange, then however much tail that exchange needs.
   *
   * `question` is how tall your own message is inside that exchange, and null
   * means nothing has answered it yet — which is a different thing from a
   * question of zero height, and the difference is the whole of what the last
   * check in here is about.
   */
  const page = (before, exchange, question = 120) => {
    const moreAbove = before > 0
    const tail = tailHeight(VIEWPORT, exchange, moreAbove)
    return {
      geometry: {
        viewport: VIEWPORT,
        content: before + exchange + tail,
        askTop: before,
        answerTop: question === null ? null : before + Math.min(question, exchange),
        moreAbove
      },
      tail,
      room: moreAbove ? GLIMPSE : EDGE,
      bottom: Math.max(before + exchange + tail - VIEWPORT, 0)
    }
  }
  const land = (p, remembered = null, generating = false) =>
    landingPoint(p.geometry, remembered, generating)

  section('the promise: your last message is at the top')
  // With a line or two of whatever came before still showing above it, so the
  // end of a long conversation does not read as the start of a short one.
  // Swept rather than sampled. Exchanges from one line to fifty screenfuls, in
  // threads from nothing above them to two hundred thousand pixels of it.
  const above = [0, 500, 5000, 200000]
  const sizes = [40, 200, 676, 700, 1400, 5000, 35000]
  let atTop = 0
  let total = 0
  const wrong = []
  for (const before of above) {
    for (const exchange of sizes) {
      const p = page(before, exchange)
      const got = land(p)
      total++
      const below = before - got.scrollTop
      // At the top means the room above it and nothing else — except in a
      // thread with nothing above it, which is already as high as it goes.
      if (Math.abs(below - p.room) < 1.5 || (before === 0 && got.scrollTop === 0)) atTop++
      else wrong.push({ before, exchange, tail: p.tail, scrollTop: got.scrollTop, below, want: p.room, why: got.reason })
    }
  }
  check(`it is at the top in all ${total} shapes`, atTop === total, wrong)
  check(
    'against the very edge only when there is nothing above to show',
    landingPoint(page(0, 200).geometry, null, false).scrollTop === 0
  )

  section('the room it needs to get there')
  check('a one-line exchange is given most of a screen', tailHeight(VIEWPORT, 40, true) === VIEWPORT - GLIMPSE - 40)
  check('and a little more where nothing is being kept above it', tailHeight(VIEWPORT, 40, false) === VIEWPORT - EDGE - 40)
  check('one a screenful tall needs none', tailHeight(VIEWPORT, VIEWPORT, true) === 0)
  check('nor does one far taller', tailHeight(VIEWPORT, 35000, true) === 0)
  check('a conversation you have not spoken in gets none', tailHeight(VIEWPORT, null, true) === 0)
  check('and it is never negative', [0, 1, VIEWPORT, VIEWPORT * 3].every((e) => tailHeight(VIEWPORT, e, true) >= 0))

  // Why nothing about following a reply had to change: while there is a tail,
  // the bottom of the scroll and the question-at-the-top are the same pixel.
  // So a reply arriving grows down the page under a question that stays put,
  // and only starts scrolling once it has filled the window.
  const coincide = [40, 200, 400, 600].every((exchange) => {
    const p = page(5000, exchange)
    return Math.abs(p.bottom - (5000 - p.room)) < 1.5
  })
  check('following a reply holds the question at the top, for free', coincide)

  section('unless the question is what has eaten the screen')
  // A pasted stack trace as the question: starting there would fill the window
  // with what you already know and none of the answer.
  const stackTrace = page(10000, 4000, VIEWPORT * 0.6)
  const shifted = land(stackTrace)
  check('the answer goes to the top instead', shifted.reason === 'answer', shifted)
  check(
    'at its own first line, with the same room kept above it',
    shifted.scrollTop === 10000 + VIEWPORT * 0.6 - GLIMPSE,
    shifted
  )
  // A question taking a third of the screen is still framing the answer.
  check('a question that merely frames it is still the start', land(page(10000, 4000, VIEWPORT * 0.3)).reason === 'turn')

  section('what outranks it')
  const scrolled = { scrollTop: 4321, atBottom: false }
  const back = land(page(20000, 2000), scrolled)
  check('somewhere you scrolled to yourself wins', back.scrollTop === 4321 && back.reason === 'remembered', back)
  check(
    'but having left it at the end is not a place, so the rule still applies',
    land(page(20000, 2000), { scrollTop: 999, atBottom: true }).reason === 'turn'
  )

  const live = land(page(20000, 2000), scrolled, true)
  check('a reply still arriving pins the end over everything', live.reason === 'generating')
  check('which, with a tail under it, is the question at the top anyway', live.scrollTop === page(20000, 2000).bottom)

  section('conversations with nothing to aim at')
  check('nothing of yours in it lands at the end', landingPoint({ viewport: VIEWPORT, content: 2000, askTop: null, answerTop: null, moreAbove: false }, null, false).reason === 'end')
  /*
   * A question with nothing under it yet.
   *
   * This was written as a 300px question inside a 300px exchange, which is not
   * that at all — it is a question that fills its exchange, and at 43% of the
   * window it is over the line where the answer takes the top instead. So the
   * check failed while the rule it was checking was right: `null` is how "no
   * answer yet" is said, and a height is not a way of saying it.
   */
  const unanswered = land(page(10000, 300, null))
  check('a question still being answered still goes to the top', unanswered.reason === 'turn', unanswered)
  check(
    'and does not fall off the end looking for a reply that is not there',
    unanswered.scrollTop === 10000 - GLIMPSE,
    unanswered
  )

  section('it never lands somewhere that is not a scroll position')
  const silly = [
    [landingPoint({ viewport: VIEWPORT, content: 0, askTop: null, answerTop: null, moreAbove: false }, null, false), 0],
    [landingPoint({ viewport: VIEWPORT, content: 100, askTop: 0, answerTop: 10, moreAbove: false }, null, false), 0],
    [land(page(20000, 100), { scrollTop: -500, atBottom: false }), 0],
    [land(page(20000, 100), { scrollTop: 999999, atBottom: false }), page(20000, 100).bottom]
  ]
  check(
    'above the top and below the end are both clamped away',
    silly.every(([got, want]) => got.scrollTop === want),
    silly.map(([got]) => got.scrollTop)
  )
})
