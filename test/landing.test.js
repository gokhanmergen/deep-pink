const path = require('node:path')
const { suite } = require('./support/harness')

/**
 * Where a conversation opens.
 *
 * A transcript used to open at its very bottom, which is the end of the last
 * thing the model said rather than the start of the last exchange. Measured
 * against a real library of 772 conversations, the last exchange is taller
 * than a 700px window in about three quarters of them — so the bottom showed
 * the final paragraph of an answer whose question was off screen.
 *
 * The rule that replaced it is one sentence, and these check that sentence
 * holds: your own last message is on screen when a thread opens. Pixels rather
 * than a rendered window, because the arithmetic is where the decisions are
 * and it can be asked directly.
 */
global.window = { deepPink: { platform: 'linux' } }

suite('landing — where a conversation opens', async ({ check, section }) => {
  const { landingPoint } = require(path.join(__dirname, '..', '.test-build', 'store.js'))

  const VIEWPORT = 700
  /** A thread `content` tall whose last exchange begins at `askTop`. */
  const thread = (content, askTop, answerTop = null) => ({
    viewport: VIEWPORT,
    content,
    askTop,
    answerTop
  })
  const land = (geometry, remembered = null, generating = false) =>
    landingPoint(geometry, remembered, generating)
  const bottomOf = (content) => Math.max(content - VIEWPORT, 0)

  section('the promise: your last message is on screen')
  // Across exchanges from a line to fifty screenfuls, on threads from short to
  // very long. What must hold in every one of them is that the question is
  // somewhere in the window once it has landed.
  const sizes = [40, 200, 690, 700, 710, 1400, 5000, 35000]
  const lengths = [800, 2000, 20000, 200000]
  let visible = 0
  let total = 0
  const missed = []
  for (const content of lengths) {
    for (const turn of sizes) {
      if (turn > content) continue
      const askTop = content - turn
      const got = land(thread(content, askTop, askTop + Math.min(120, turn / 2)))
      total++
      // On screen means: at or below the top of the view, and above its foot.
      const relative = askTop - got.scrollTop
      if (relative >= -1 && relative < VIEWPORT) visible++
      else missed.push({ content, turn, scrollTop: got.scrollTop, relative, why: got.reason })
    }
  }
  check(`the question is in view in all ${total} of them`, visible === total, missed)

  section('a last exchange that already fits changes nothing')
  // The whole point of the `min`: where the bottom already showed the turn,
  // the bottom is still the answer and nobody sees a difference.
  const fits = land(thread(10000, 9500))
  check('it lands at the bottom', fits.scrollTop === bottomOf(10000), fits)
  check('and says that is why', fits.reason === 'end', fits)

  const justFits = land(thread(10000, 10000 - VIEWPORT + 30))
  check('and a turn that only just fits, too', justFits.scrollTop === bottomOf(10000), justFits)

  section('a last exchange taller than the window starts at its top')
  const tall = land(thread(10000, 8000, 8200))
  check('it lands above the bottom', tall.scrollTop < bottomOf(10000), tall)
  check('at the question, less a little context', tall.scrollTop === 8000 - 24, tall)
  check('and says that is why', tall.reason === 'turn', tall)

  section('unless the question is what has eaten the screen')
  // A pasted stack trace as the question: starting there would fill the window
  // with the thing you already know and none of the answer.
  const huge = land(thread(20000, 10000, 10000 + VIEWPORT * 0.6))
  check('it starts at the answer instead', huge.reason === 'answer', huge)
  check('at its top, less the same context', huge.scrollTop === 10000 + VIEWPORT * 0.6 - 24, huge)

  // And the line is held where it is: a question taking a third of the screen
  // is still context, not an obstruction.
  const roomy = land(thread(20000, 10000, 10000 + VIEWPORT * 0.3))
  check('a question that merely frames the answer is still the start', roomy.reason === 'turn')

  section('what outranks it')
  const place = { scrollTop: 4321, atBottom: false }
  const remembered = land(thread(20000, 18000), place)
  check('somewhere you scrolled to yourself wins', remembered.scrollTop === 4321, remembered)
  check('and says so', remembered.reason === 'remembered')

  const atEnd = land(thread(20000, 18000), { scrollTop: 999, atBottom: true })
  check(
    'but having left it at the end is not a place, so the rule still applies',
    atEnd.reason === 'turn',
    atEnd
  )

  const live = land(thread(20000, 18000), place, true)
  check('a reply still arriving pins the end, whatever else was true', live.reason === 'generating')
  check('at the bottom', live.scrollTop === bottomOf(20000), live)

  section('conversations with nothing to aim at')
  const nothingSaid = land(thread(2000, null))
  check('nothing of yours in it lands at the end', nothingSaid.reason === 'end')

  const shorterThanTheWindow = land(thread(300, 100, 160))
  check('a thread that does not fill the window lands at the top', shorterThanTheWindow.scrollTop === 0)

  const unanswered = land(thread(10000, 8000, null))
  check('a question still being answered starts at the question', unanswered.reason === 'turn')
  check('and does not fall off the end looking for a reply', unanswered.scrollTop === 8000 - 24)

  section('it never lands somewhere that is not a scroll position')
  const cases = [
    land(thread(0, null)),
    land(thread(100, 0, 10)),
    land(thread(50000, 10, 20)),
    land(thread(20000, 19999), { scrollTop: -500, atBottom: false }),
    land(thread(20000, 19999), { scrollTop: 999999, atBottom: false })
  ]
  check(
    'never above the top or below the end',
    cases.every((c, i) => c.scrollTop >= 0 && c.scrollTop <= bottomOf([0, 100, 50000, 20000, 20000][i])),
    cases
  )
})
