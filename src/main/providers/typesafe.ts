import { getSecret } from '../secrets'

/**
 * Jev, TypeSafe's System One model, asked which sentence of a reply matters.
 *
 * Not a chat model and not reachable through the chat endpoint. Jev takes
 * state plus typed questions and returns typed answers with a probability for
 * every option — `"modality": "text->decisions"`, and `supported_parameters`
 * is empty, so there is no temperature, no max tokens and nothing to stream.
 * It lives at `/systemone`, which OpenRouter proxies under the same key the
 * rest of the app already uses.
 *
 * That shape happens to suit this exactly. "Which of these sentences is the
 * one to read" is a choice among options we define, and a choice comes back
 * with the whole distribution — so the case where nothing stands out is not
 * something to detect afterwards, it is visible in the numbers.
 */

/** Pinned rather than floating: a new Jev would change every answer at once. */
const MODEL = 'typesafe/jev-1.13'

const ENDPOINT = 'https://openrouter.ai/api/v1/systemone'

/**
 * How many sentences are offered.
 *
 * A Choice takes up to 255 options and the whole reply is sent twice over — as
 * the state, and again as the option descriptions — so this bounds both. The
 * longest reply in a real library of four thousand messages is 39,500
 * characters, which came to 18,042 tokens against a 32,000 limit, so 200 is
 * comfortably inside it rather than a number to worry about.
 */
const MOST_CANDIDATES = 200

/** Past this a sentence is a paragraph, and describing it in full is waste. */
const LONGEST_OPTION = 300

/**
 * How far ahead the winner has to be.
 *
 * Not `confidence`, which the API also returns: confidence measures how peaked
 * the distribution is, and a peak is harder to reach the more options there
 * are — so the same clear answer scores 0.97 among four sentences and 0.72
 * among two hundred, and any fixed threshold would mean "highlight short
 * replies only". The gap between first and second does not care how many
 * options there were.
 *
 * Measured across eight real replies: the clear picks led by 0.47 to 0.96,
 * and the one genuinely ambiguous reply — two sentences at 0.55 and 0.42 —
 * led by 0.13. Which is exactly the case where marking one of them would be
 * picking a side the model did not pick.
 */
const CLEAR_ENOUGH = 0.15

export interface KeyPoint {
  text: string
  /** The winner's own probability, kept so the reader can be told how sure. */
  probability: number
  costUsd: number
}

interface ChoiceAnswer {
  choice?: string
  probabilities?: Record<string, number>
}

/**
 * Asks which of `candidates` is the sentence to read first.
 *
 * Returns null whenever there is no answer worth acting on — no key, nothing
 * offered, a request that failed, an explicit "none of these", or a winner too
 * close to the runner-up. Every one of those means the same thing to the
 * reader, which is that the reply is shown exactly as it would have been.
 */
export async function askKeyPoint(
  reply: string,
  candidates: string[]
): Promise<KeyPoint | null> {
  const key = getSecret('openrouter')
  if (!key || candidates.length < 2) return null

  const offered = candidates.slice(0, MOST_CANDIDATES)
  const criteria: Record<string, string> = {
    // Named and described, because the model is shown both and this one has
    // to be distinguishable from two hundred sentences.
    none: 'No single sentence stands out as the one to read first'
  }
  offered.forEach((sentence, at) => {
    criteria[`s${at}`] =
      sentence.length > LONGEST_OPTION ? `${sentence.slice(0, LONGEST_OPTION)}…` : sentence
  })

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        state: reply,
        questions: {
          key_point: {
            type: 'choice',
            instructions:
              'Which single sentence is the most important one for the reader to take away?',
            criteria
          }
        }
      })
    })
    if (!response.ok) return null

    const body = (await response.json()) as {
      answers?: Record<string, ChoiceAnswer>
      usage?: { cost?: number }
    }
    const answer = body.answers?.key_point
    if (!answer?.choice || answer.choice === 'none') return null

    const at = Number(answer.choice.slice(1))
    const text = offered[at]
    if (!text) return null

    const spread = Object.values(answer.probabilities ?? {}).sort((a, b) => b - a)
    const [first = 0, second = 0] = spread
    if (first - second < CLEAR_ENOUGH) return null

    return { text, probability: first, costUsd: body.usage?.cost ?? 0 }
  } catch {
    // Offline, rate limited, or an account without the beta. The reply is
    // already on screen and complete; this was only ever going to add to it.
    return null
  }
}
