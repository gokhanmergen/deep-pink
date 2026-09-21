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
 * How sure the model has to be that a sentence is a takeaway, to mark it.
 *
 * Only consulted when more than one is allowed, where the question put to the
 * model is a yes/no about each sentence rather than a choice between them.
 * Measured on a reply answering five questions: the five answers scored 0.84
 * to 0.91, the sentence elaborating on one of them 0.71, and an example 0.23.
 * Anywhere in the 0.7s separates the answers from the scaffolding.
 */
const WORTH_MARKING = 0.75

/**
 * How close to the last sentence taken still counts as the same answer.
 *
 * "How many things did you ask for" is honestly ambiguous by one, and the
 * count cannot be a hard cap because of it. Measured on "what is atomic mass,
 * what is the atomic number, how do I find protons, electrons and neutrons"
 * (2026-09-20): Jev scored that question 3.02 on the scale — four things,
 * reading the last clause as one — and a hard cap of four dropped a sentence
 * at 0.84 while keeping three at 0.86. Those four are one answer split up, not
 * a ranking, and cutting between them is cutting nothing.
 *
 * So the count chooses where to cut and anything level with the last sentence
 * taken comes with it. Compared against the score of that sentence rather than
 * chained from it, so a reply of near-identical sentences cannot walk the
 * whole way down. On the one-question case the top sentence scored 0.96 and
 * the next 0.34, so nothing follows it in.
 */
const NEARLY = 0.05

/**
 * How many sentences get their own question.
 *
 * Fewer than a Choice takes, because each one carries its own instructions
 * and its own pair of criteria rather than a single line in a list, and the
 * whole thing still has to fit in 32,000 tokens beside the reply itself.
 */
const MOST_ASKED_ABOUT = 120

/**
 * How much of the question is sent.
 *
 * A question is normally a line or two, but it can arrive with a pasted log or
 * a whole file in it, and the reply plus every sentence of it as its own
 * question is already most of a 32,000-token budget. What is needed from it is
 * what was asked, which is near the top of anything that long.
 */
const LONGEST_QUESTION = 4000

/**
 * The counts the model chooses between, when asked how much was asked.
 *
 * A Score rather than a Choice because these are ordered, and ordered is what
 * a Score is for — it returns a position on the scale, and will land between
 * two of them when the question is genuinely borderline. Six is where it stops
 * because "six or more" and "eleven" mean the same thing here: past any
 * ceiling anybody sets, and then the ceiling is what applies.
 */
const COUNTS = [
  'One thing',
  'Two things',
  'Three things',
  'Four things',
  'Five things',
  'Six or more things'
]

/**
 * What the model is shown: the question, and then the reply.
 *
 * Both, and this is the whole of the fix. Asked to mark the key sentences of a
 * reply on its own, a model marks what the *reply* emphasises — which is a
 * reasonable reading of an unreasonable question, because whether a sentence
 * matters depends entirely on what somebody wanted to know, and that was not
 * in the room. Measured on a reply to five questions (2026-09-20): the reply
 * alone put seven sentences over the bar, the question included put exactly
 * five, and they were the five answers. On a single question both said one —
 * but only the second could say why it was one.
 */
function stateFor(question: string, reply: string): string {
  const asked = question.trim().slice(0, LONGEST_QUESTION)
  if (!asked) return reply
  return `The reader asked:\n\n${asked}\n\n---\n\nThe reply:\n\n${reply}`
}

/** The part before the first separator and the part after it. */
function splitOnce(text: string, at: string): [string, string] {
  const found = text.indexOf(at)
  // No colon at all: the model ignored the format, and every number it wrote
  // is a sentence it picked. The ceiling is then the only bound there is.
  return found < 0 ? ['', text] : [text.slice(0, found), text.slice(found + 1)]
}

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
/**
 * Several sentences, which is not the same question as one.
 *
 * A Choice cannot answer it. Its probabilities sum to one across the options,
 * so they concentrate: put a reply that answers five questions through it and
 * the first answer takes 0.62, the sentence after it 0.36, and the other four
 * answers score 0.000 each. No threshold recovers them, because there is
 * nothing there to recover — the model was asked which *one* was best and it
 * said so.
 *
 * So when more than one may be marked, each sentence gets its own yes/no
 * instead: is this a takeaway, rather than which is the best. Jev takes many
 * questions in one call and returns a probability for each, and on the same
 * five-answer reply all five scored above 0.84 while the examples and asides
 * fell to 0.23. Same call, same cost, the right question.
 */
async function askEachSentence(
  key: string,
  question: string,
  reply: string,
  candidates: string[],
  most: number
): Promise<KeyPoint | null> {
  const offered = candidates.slice(0, MOST_ASKED_ABOUT)

  const questions: Record<string, unknown> = {}
  offered.forEach((sentence, at) => {
    questions[`k${at}`] = {
      type: 'noul',
      instructions: `This sentence is one of the reply's key takeaways: "${
        sentence.length > LONGEST_OPTION ? `${sentence.slice(0, LONGEST_OPTION)}…` : sentence
      }"`,
      criteria: {
        true: 'It directly answers one of the things the reader asked.',
        false: 'It restates, gives an example, adds an aside, or is setup for another sentence.'
      }
    }
  })

  /*
   * And how many things were asked for, which decides how many are marked.
   *
   * The setting is a ceiling, not a quantity: one question with one answer
   * should get one mark however high it is set. Nothing in the reply can
   * answer this — "how many did they ask" is a fact about the question — and
   * for as long as only the reply was sent, the number of marks could only
   * ever be a fixed number somebody had typed.
   */
  questions.how_many = {
    type: 'score',
    instructions:
      'How many separate things does the reader want to know? Count the things, ' +
      'not the question marks: "how do I find the protons, electrons and neutrons" ' +
      'is three things asked in one sentence.',
    criteria: COUNTS
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state: stateFor(question, reply), questions })
  })
  if (!response.ok) return null

  const body = (await response.json()) as {
    answers?: Record<string, { noul?: number; score?: number }>
    usage?: { cost?: number }
  }

  const asked = Math.max(Math.round((body.answers?.how_many?.score ?? 0) + 1), 1)

  const ranked = Object.entries(body.answers ?? {})
    .filter(([id]) => id.startsWith('k'))
    .map(([id, answer]) => ({ at: Number(id.slice(1)), score: answer?.noul ?? 0 }))
    .filter((scored) => scored.score >= WORTH_MARKING)
    .sort((a, b) => b.score - a.score)

  // The cut the count asks for, and then whatever is level with it.
  const cut = ranked[Math.min(asked, ranked.length) - 1]?.score ?? 1
  const texts = ranked
    .filter((scored) => scored.score >= cut - NEARLY)
    .slice(0, most)
    // Back into reading order: marks that appear down the page in the order
    // they were scored would be drawn in a sequence nobody can follow.
    .sort((a, b) => a.at - b.at)
    .map((scored) => offered[scored.at])
    .filter((text): text is string => Boolean(text))

  if (!texts.length) return null
  return { texts, costUsd: body.usage?.cost ?? 0 }
}

export async function askKeyPoint(
  question: string,
  reply: string,
  candidates: string[],
  most = 1
): Promise<KeyPoint | null> {
  const key = getSecret('openrouter')
  if (!key || candidates.length < 2) return null

  if (most > 1) {
    try {
      return await askEachSentence(key, question, reply, candidates, most)
    } catch {
      return null
    }
  }

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
        state: stateFor(question, reply),
        questions: {
          key_point: {
            type: 'choice',
            instructions:
              'Which single sentence most directly answers what the reader asked? ' +
              'If they asked one question, this is the one sentence that answers it — ' +
              'not the setup for it, not an example of it.',
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

    const spread = Object.values(answer.probabilities ?? {}).sort((a, b) => b - a)
    const [first = 0, second = 0] = spread
    if (first - second < CLEAR_ENOUGH) return null

    const only = offered[Number(answer.choice.slice(1))]
    return only ? { texts: [only], costUsd: body.usage?.cost ?? 0 } : null
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
  question: string,
  candidates: string[],
  model: string,
  most = 1
): Promise<KeyPoint | null> {
  if (candidates.length < 2) return null

  const offered = candidates.slice(0, MOST_CANDIDATES)
  const numbered = offered
    .map((sentence, at) => `${at + 1}. ${sentence.slice(0, LONGEST_OPTION)}`)
    .join('\n')

  /*
   * Counted out loud before anything is chosen.
   *
   * Jev is asked how many things were wanted as its own question; a chat model
   * has no such thing, so the count has to be made part of the answer. Simply
   * describing the rule was not enough on a small model: told "one number per
   * thing asked, at most five", gemma-3-12b answered a single question about
   * closures with five numbers — it read the ceiling as the shape of the reply
   * and filled it. Made to write the count first and then that many numbers,
   * the same model and the same reply gave one. The count is a question it
   * cannot answer by pattern-matching the format.
   *
   * The format is shown as "N: a, b, c" and never with a real count in it.
   * An earlier version illustrated the rule with a three-part question and
   * gemma-3-12b then answered three to every case it was given, including a
   * single question — a worked example in a prompt this short is a number the
   * model can copy instead of working one out.
   */
  const wanted =
    most > 1
      ? 'First how many separate things the reader wants to know, then a colon, then ' +
        'exactly that many sentence numbers separated by commas — the format is ' +
        '"N: a, b, c". Count what they want to know, not the question marks: a single ' +
        'sentence asking about several things at once is asking about several. If they ' +
        'want to know one thing and one sentence answers it, the reply is "1: n", ' +
        `however long the answer is. At most ${most} numbers`
      : 'the number of the one sentence that most directly answers what the reader asked'

  try {
    const settings = loadSettings()
    const result = await complete({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are given a question somebody asked, and the sentences of the answer ' +
            `they got, numbered. Reply with ${wanted}, and nothing else. Skip examples, ` +
            'asides, and sentences that restate another. Reply with 0 if no sentence ' +
            'stands out. Numbers only.'
        },
        {
          role: 'user',
          content: `The question:\n\n${question.trim().slice(0, LONGEST_QUESTION)}\n\nThe answer:\n\n${numbered}`
        }
      ],
      temperature: 0,
      // Room for the count, a few numbers and their commas, and no room to
      // start talking.
      maxTokens: most > 1 ? 24 : 8,
      providerRouting: settings.modelProviderRouting[model] ?? null,
      attribution: settings.sendAppAttribution
    })

    /*
     * The count is read past, not enforced.
     *
     * It earns its place by changing what comes after it and not by being
     * right: measured on four questions across three models (2026-09-20),
     * every model listed the correct sentences and several of them wrote the
     * wrong number in front — haiku-4.5 answered "3: 1, 3, 6, 7, 9", which is
     * the wrong count and the right five sentences. Truncating to the three
     * it claimed threw two real answers away. Having to write a number first
     * is what stops a model listing five sentences for a question that asked
     * one thing; what number it happens to write is not worth acting on.
     */
    const [, listed] = most > 1 ? splitOnce(result.content, ':') : ['', result.content]

    const texts: string[] = []
    for (const found of listed.matchAll(/\d+/g)) {
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
