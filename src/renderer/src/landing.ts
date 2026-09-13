/**
 * Where a conversation opens.
 *
 * It opened at the very bottom, which is the end of the last thing the model
 * said. In a quarter of the threads in a real library that reply is taller than
 * the window, so the bottom is its last paragraph with its beginning off
 * screen, and the first thing you do on arriving is scroll up to find out what
 * you are looking at. The bottom is where a conversation *ends*; it is almost
 * never where you want to start reading it.
 *
 * What you came back for is the last exchange, and an exchange starts with the
 * question. So the rule this settles on is one sentence: **your own last
 * message is on screen when a thread opens**, and as much of the answer as
 * fits follows it. When the whole exchange already fits, that is the bottom and
 * nothing changes; when it does not, the view starts at the top of the turn
 * instead of its end.
 *
 * The arithmetic is here, apart from the DOM, because "where should it land"
 * is a question with right and wrong answers that can be checked — and because
 * every one of the numbers it needs can be measured off the page first.
 */

/** What the transcript looks like, in pixels, once it has been laid out. */
export interface Geometry {
  /** Height of the scrolling element — one screenful. */
  viewport: number
  /** Total height of everything in it. */
  content: number
  /**
   * Top of the last message you sent, relative to the top of the content.
   * Null for a conversation you have not said anything in.
   */
  askTop: number | null
  /**
   * Top of the first reply to it. Null when the last thing in the thread is
   * your own message — nothing has answered it yet.
   */
  answerTop: number | null
}

/*
 * There is deliberately no "first unread" rule.
 *
 * It was the obvious fourth one — a thread that moved on while you were
 * elsewhere should open at the seam — and writing it out showed it had nothing
 * to do. A reply that arrives while you are in another thread is the answer to
 * the last thing you said, so the seam and the top of the last exchange are
 * the same pixel, and the rule below already goes there. It would have earned
 * its keep only where several messages landed unseen, which in a chat app that
 * answers one turn at a time does not happen.
 */

/** Where you were, if you have been here before in this sitting. */
export interface Remembered {
  scrollTop: number
  /** At the end is a place; "1,482 pixels down" stops being one as it grows. */
  atBottom: boolean
}

export interface Landing {
  scrollTop: number
  /** Which rule decided it. Carried so the choice can be explained and tested. */
  reason: 'generating' | 'remembered' | 'turn' | 'answer' | 'end'
}

/**
 * A little of what came before, above whatever the view starts at.
 *
 * A message flush against the top edge reads as the top of the conversation.
 * A sliver of the one before it says "there is more up here" without costing
 * anything worth having.
 */
const BREATHING_ROOM = 24

/**
 * How much of the screen the question may take before it stops being context.
 *
 * Landing on the question is meant to frame the answer. Past this, the
 * question *is* the screen — a long paste, a stack trace — and framing has
 * turned into hiding what you came to read, so the view starts at the answer.
 */
const MOST_OF_THE_SCREEN_A_QUESTION_MAY_TAKE = 0.4

export function landingPoint(
  geometry: Geometry,
  remembered: Remembered | null,
  generating: boolean
): Landing {
  const { viewport, content, askTop, answerTop } = geometry
  const end = Math.max(content - viewport, 0)
  const settle = (scrollTop: number, reason: Landing['reason']): Landing => ({
    scrollTop: Math.max(0, Math.min(scrollTop, end)),
    reason
  })

  // A reply arriving is the one thing that is genuinely happening at the
  // bottom, and following it is the whole of what you are there for.
  if (generating) return settle(end, 'generating')

  // Somewhere you actually chose beats anywhere this could work out.
  if (remembered && !remembered.atBottom) return settle(remembered.scrollTop, 'remembered')

  if (askTop === null) return settle(end, 'end')

  /*
   * The top of the last exchange, or the bottom, whichever comes first.
   *
   * `min` is what makes the common case cost nothing: when the whole turn fits
   * on screen the bottom is already above its top, so this is the bottom and
   * the view is exactly where it used to be. It only differs when the turn is
   * taller than the window — which is the case that was broken.
   */
  const fromTheQuestion = askTop - BREATHING_ROOM
  if (fromTheQuestion >= end) return settle(end, 'end')

  // Unless the question has eaten the screen, in which case it is no longer
  // framing anything.
  if (
    answerTop !== null &&
    answerTop - askTop > viewport * MOST_OF_THE_SCREEN_A_QUESTION_MAY_TAKE
  ) {
    return settle(answerTop - BREATHING_ROOM, 'answer')
  }

  return settle(fromTheQuestion, 'turn')
}
