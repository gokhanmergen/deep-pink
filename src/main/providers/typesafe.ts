import { getSecret } from '../secrets'
import { complete } from './openrouter'
import { loadSettings } from '../settings'

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

/**
 * The least a sentence can score and still be worth marking alongside another.
 *
 * Only consulted when more than one is allowed. Two hundred candidates
 * sharing a flat distribution score half a percent each, so this is the line
 * between "several sentences stood out" and "nothing did, take the top few
 * anyway".
 */
const WORTH_MARKING = 0.15

export interface KeyPoint {
  /** In the order they were ranked, most important first. */
  texts: string[]
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
  candidates: string[],
  most = 1
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
    const probabilities = answer?.probabilities ?? {}

    const ranked = Object.entries(probabilities)
      .filter(([option]) => option !== 'none')
      .sort((a, b) => b[1] - a[1])
    if (!ranked.length || answer?.choice === 'none') return null

    /*
     * One, or several, and the difference is not only how many are kept.
     *
     * Asked for one, a near-tie is a reason to mark nothing: choosing between
     * two sentences the model could not choose between is the app inventing
     * an answer. Asked for several, the same near-tie is the answer — both
     * are worth reading — so the gap test applies only when a single sentence
     * has to win outright.
     *
     * The floor is what stops that becoming "mark the top three of two
     * hundred whatever they scored". Spread evenly over that many options
     * nothing reaches 0.15, so a flat distribution still marks nothing.
     */
    const [first, second = 0] = ranked.map(([, p]) => p)
    if (most <= 1) {
      if (first - second < CLEAR_ENOUGH) return null
      const only = offered[Number(ranked[0][0].slice(1))]
      return only ? { texts: [only], costUsd: body.usage?.cost ?? 0 } : null
    }

    const texts = ranked
      .filter(([, p]) => p >= WORTH_MARKING)
      .slice(0, most)
      .map(([option]) => offered[Number(option.slice(1))])
      .filter((text): text is string => Boolean(text))

    if (!texts.length) return null
    return { texts, costUsd: body.usage?.cost ?? 0 }
  } catch {
    // Offline, rate limited, or an account without the beta. The reply is
    // already on screen and complete; this was only ever going to add to it.
    return null
  }
}


/**
 * The same question, put to an ordinary chat model.
 *
 * Offered because not everybody wants a second vendor in the loop for this,
 * and because somebody may simply prefer a model they already trust. It is a
 * worse instrument and the difference is worth being clear about: a chat model
 * returns a number and nothing else, so there is no distribution to read and
 * no way to tell a confident answer from a shrug. Jev's gate — the winner has
 * to be clearly ahead of the runner-up — has no equivalent here. What stands
 * in for it is the model's own option to answer 0.
 *
 * Numbered rather than quoted back, because a model asked to repeat a
 * sentence verbatim will tidy it, and a sentence that has been tidied cannot
 * be found again on the page.
 */
export async function askKeyPointViaModel(
  candidates: string[],
  model: string,
  most = 1
): Promise<KeyPoint | null> {
  if (candidates.length < 2) return null

  const offered = candidates.slice(0, MOST_CANDIDATES)
  const numbered = offered
    .map((sentence, at) => `${at + 1}. ${sentence.slice(0, LONGEST_OPTION)}`)
    .join('\n')

  const wanted =
    most > 1
      ? `the numbers of up to ${most} sentences that matter most, most important first, ` +
        'separated by commas'
      : 'the number of the single most important sentence for the reader to take away'

  try {
    const settings = loadSettings()
    const result = await complete({
      model,
      messages: [
        {
          role: 'system',
          content:
            `You are given the sentences of an answer, numbered. Reply with ${wanted}, ` +
            'and nothing else. Reply with 0 if no sentence stands out. Numbers only.'
        },
        { role: 'user', content: numbered }
      ],
      temperature: 0,
      // Room for a few numbers and their commas, and no room to start talking.
      maxTokens: most > 1 ? 16 : 8,
      providerRouting: settings.modelProviderRouting[model] ?? null,
      attribution: settings.sendAppAttribution
    })

    const texts: string[] = []
    for (const found of result.content.matchAll(/\d+/g)) {
      const at = Number(found[0])
      if (at < 1 || at > offered.length) continue
      const text = offered[at - 1]
      // A model asked for three sometimes says "2, 2, 5".
      if (text && !texts.includes(text)) texts.push(text)
      if (texts.length >= Math.max(most, 1)) break
    }
    if (!texts.length) return null

    return { texts, costUsd: result.usage.costUsd }
  } catch {
    /*
     * No mark, and no second attempt.
     *
     * Every failure seen in testing was a 429 from the cheap model this
     * defaults to — asking four times in under two seconds got three of
     * them. A retry was the obvious answer and made it worse: it doubles the
     * rate at exactly the moment the service is saying there is too much of
     * it, and the same burst then failed four times out of four instead of
     * two. One reply at a time is nothing like that load.
     *
     * The failure is benign either way. A reply with no mark is the reply.
     */
    return null
  }
}
