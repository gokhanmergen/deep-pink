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
 * question. So the rule is one sentence: **the last thing you said is at the
 * top of the window**, with the answer running down from it — the view you had
 * the moment you pressed send.
 *
 * This first tried to do that by taking the top of the last exchange or the
 * bottom, whichever came first, which was wrong in the ordinary case and only
 * looked right in the rare one. A document cannot be scrolled past its end, so
 * where the last exchange was shorter than the window — which is most of them
 * — "whichever came first" was always the bottom, and nothing changed for the
 * threads the change was for. Being able to put a message at the top means
 * having somewhere to scroll it to, so the transcript now keeps a tail of
 * empty space below the conversation, exactly as tall as it needs to be and no
 * taller. `tailHeight` works out how much.
 *
 * The arithmetic is here, apart from the DOM, because "where should it land"
 * is a question with right and wrong answers that can be checked — and because
 * every one of the numbers it needs can be measured off the page first.
 */

/**
 * How much empty space to leave under the conversation.
 *
 * Enough that the last exchange can be scrolled until its first line is at the
 * top of the window, and not one pixel more: a transcript that always ends in
 * a screenful of nothing is a transcript you can scroll past the end of.
 *
 * `exchange` is the height of the last exchange — your message and everything
 * answering it — so this shrinks to zero on its own as a reply grows past a
 * screenful, at which point the end of the conversation is the end of the
 * conversation again.
 *
 * There is a quiet consequence worth naming, because it is why nothing else
 * had to change: while the tail exists, the bottom of the scroll *is* the
 * message-at-the-top position. Following a reply as it arrives therefore holds
 * your question at the top and lets the answer grow down the page, and only
 * starts scrolling once the answer has filled the window — which is what you
 * wanted from following it in the first place.
 */
export function tailHeight(
  viewport: number,
  exchange: number | null,
  moreAbove: boolean
): number {
  if (exchange === null) return 0
  return Math.max(0, viewport - roomAbove(moreAbove) - exchange)
}

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
  /**
   * Whether there is any conversation above the last exchange.
   *
   * Decides how much of it to leave showing, and therefore how much room the
   * exchange needs below it — so `tailHeight` is given the same answer.
   */
  moreAbove: boolean
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
 * How much of what came before is left showing above the landing.
 *
 * A message flush against the top edge reads as the top of the conversation,
 * which for the last exchange of a long one is a lie — and a lie you only
 * catch by scrolling up to check. So when there is something above, enough of
 * it stays on screen to be read as text rather than as an edge: a line or two
 * of the previous reply, which is what says "this is the end of something"
 * without giving up the top of the window to it.
 *
 * When the exchange *is* the conversation there is nothing above to show and
 * nothing to mislead about, so it keeps the bare margin it always had.
 */
const A_GLIMPSE_OF_WHAT_CAME_BEFORE = 88
const JUST_OFF_THE_EDGE = 24

export function roomAbove(moreAbove: boolean): number {
  return moreAbove ? A_GLIMPSE_OF_WHAT_CAME_BEFORE : JUST_OFF_THE_EDGE
}

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
  const { viewport, content, askTop, answerTop, moreAbove } = geometry
  const room = roomAbove(moreAbove)
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

  // A conversation you have said nothing in has no exchange to open at.
  if (askTop === null) return settle(end, 'end')

  // The question goes to the top — unless the question has eaten the screen,
  // in which case it is no longer framing the answer but standing in front of
  // it, and the answer goes to the top instead.
  if (
    answerTop !== null &&
    answerTop - askTop > viewport * MOST_OF_THE_SCREEN_A_QUESTION_MAY_TAKE
  ) {
    return settle(answerTop - room, 'answer')
  }

  return settle(askTop - room, 'turn')
}
