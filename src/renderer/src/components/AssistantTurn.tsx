import { memo, useEffect, useRef, useState } from 'react'
import { ChevronRight, Copy, FileText, GitBranch, RefreshCw } from 'lucide-react'
import { ICON } from '../icons'
import type { Message, UiSettings, Usage } from '@shared/types'
import { Markdown } from './Markdown'
import { ImageAttachments } from './ImageAttachments'
import { LongText } from './LongText'
import { useStore } from '../store'
import { isEmptyAssistantMessage } from '../turns'
import { estimateTurnHeight } from '../messageHeight'
import { sentencesIn, strokesFor, takeKeyPointWish, type Stroke } from '../keyPoint'
import { formatCost, formatDuration, formatTokens, modelShortName } from '../format'

/**
 * One answer, including any tool work it did along the way. The rows are still
 * separate messages underneath — this only presents them as the single turn
 * they are.
 */

function sumUsage(messages: Message[]): Usage | null {
  const parts = messages.map((m) => m.usage).filter((u): u is Usage => u != null)
  if (!parts.length) return null

  // Every round re-sends the conversation, so these really are the totals that
  // were billed for this turn — not a double count.
  return {
    promptTokens: parts.reduce((n, u) => n + u.promptTokens, 0),
    completionTokens: parts.reduce((n, u) => n + u.completionTokens, 0),
    reasoningTokens: parts.reduce((n, u) => n + u.reasoningTokens, 0),
    cachedTokens: parts.reduce((n, u) => n + u.cachedTokens, 0),
    totalTokens: parts.reduce((n, u) => n + u.totalTokens, 0),
    costUsd: parts.reduce((n, u) => n + u.costUsd, 0),
    latencyMs: parts.reduce((n, u) => n + u.latencyMs, 0),
    timeToFirstTokenMs: parts[0].timeToFirstTokenMs,
    // Summed like the tokens: a turn that reasoned in three rounds spent all
    // of it thinking, and what you waited for is the total.
    reasoningMs: parts.some((u) => u.reasoningMs != null)
      ? parts.reduce((n, u) => n + (u.reasoningMs ?? 0), 0)
      : null,
    tokensPerSecond: parts[parts.length - 1].tokensPerSecond,
    generationId: parts[0].generationId
  }
}

/**
 * What a disclosure holds, fetched the first time it is opened.
 *
 * A transcript page leaves reasoning traces and tool bodies behind — they are
 * a third of the text in a real library and none of it is on screen — so the
 * text arrives when somebody asks to see it, which for most messages is never.
 *
 * `message` is preferred where it has the text already: a reply still arriving
 * carries its own trace, and there is nothing to fetch for something that has
 * not been written down yet.
 */
function useHiddenPart(
  messageId: string,
  present: string | null,
  wanted: 'reasoning' | 'content',
  initiallyOpen = false
): { open: boolean; onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => void; text: string | null } {
  const [open, setOpen] = useState(initiallyOpen)
  const [fetched, setFetched] = useState<string | null>(null)

  /*
   * A `<details open>` does not fire a toggle for being born open.
   *
   * Which is the whole of "expand reasoning traces by default": the element
   * arrives open, nothing is toggled, and without this the trace would sit
   * there empty for the one reader who asked to always see it.
   */
  useEffect(() => {
    if (!initiallyOpen || present || fetched !== null) return
    void window.deepPink.messages.hidden(messageId).then((parts) => setFetched(parts[wanted] ?? ''))
    // On mount alone: after that, opening it is what asks.
  }, [])

  const onToggle = (event: React.SyntheticEvent<HTMLDetailsElement>): void => {
    const nowOpen = event.currentTarget.open
    setOpen(nowOpen)
    if (!nowOpen || present || fetched !== null) return
    void window.deepPink.messages.hidden(messageId).then((parts) => setFetched(parts[wanted] ?? ''))
  }

  return { open, onToggle, text: present ?? fetched }
}

/** How much thinking there is, whether or not the text came with the message. */
function reasoningLength(message: Message): number {
  return message.reasoning?.length ?? message.reasoningChars
}

/**
 * "Reasoned for 1m 54s ›", and nothing else.
 *
 * This was a bordered box with a chip in it saying "reasoning", which is a lot
 * of furniture around a sentence — and the box claimed the trace was a thing
 * to look at rather than a thing you could look at. It is a line of dim text
 * with a caret: an aside about what just happened, at the weight an aside
 * deserves, which is where the eye can pass over it.
 *
 * Its own component because it needs state — what it holds is fetched when it
 * is opened — and the turn renders one of these per message in a loop, which
 * is the one place a hook cannot go.
 *
 * The time is the part you actually noticed, because you sat and watched it,
 * and it is measured rather than inferred. Where it was not — every turn from
 * before it was, and every model that does not reason aloud — the tokens stand
 * on their own.
 */
function ReasoningTrace({
  message,
  openByDefault
}: {
  message: Message
  openByDefault: boolean
}): React.JSX.Element | null {
  const trace = useHiddenPart(message.id, message.reasoning, 'reasoning', openByDefault)
  const length = reasoningLength(message)
  if (length === 0) return null

  return (
    <details className="aside reasoning" open={openByDefault} onToggle={trace.onToggle}>
      <summary className="aside__summary">
        {message.usage?.reasoningMs
          ? `Reasoned for ${formatDuration(message.usage.reasoningMs)}`
          : 'Reasoned'}
        <span className="aside__note">{formatTokens(Math.ceil(length / 4))} tokens</span>
        <ChevronRight className="aside__caret" size={13} strokeWidth={2} />
      </summary>
      <div className="aside__body">
        {trace.open ? <LongText text={trace.text ?? 'Loading…'} /> : <pre />}
      </div>
    </details>
  )
}

/**
 * A reply's text, and the mark on the sentence worth reading first.
 *
 * Both halves need the rendered element, which is why they live here rather
 * than in the turn above: the sentences are read off the page, and the one
 * that comes back is found again on the same page. See `../keyPoint`.
 *
 * Nothing is marked while the text is still arriving. A sentence chosen from
 * half a reply is a sentence chosen from a different reply, and the range
 * would be rebuilt on every delta for as long as it kept coming.
 */
function ReplyBody({ message, ui }: { message: Message; ui: UiSettings }): React.JSX.Element {
  const body = useRef<HTMLDivElement>(null)
  const streaming = message.status === 'streaming'

  // Asked once, by whoever draws the finished reply first.
  useEffect(() => {
    const element = body.current
    if (!element || streaming) return
    if (!takeKeyPointWish(message.id)) return

    const candidates = sentencesIn(element).map((candidate) => candidate.text)
    if (candidates.length < 2) return
    void useStore.getState().findKeyPoint(message.id, message.content, candidates)
  }, [message.id, message.content, streaming])

  /*
   * Where to draw, worked out from the page and redrawn when the page moves.
   *
   * The strokes are positions, so they are wrong the moment the text reflows
   * — the window resized, the measure changed, a code block finished
   * highlighting and pushed a paragraph down. The observer is on the body
   * itself, which is the thing whose shape decides all of that.
   */
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const wanted = streaming ? [] : message.keyPoints

  /*
   * Off, then on a beat later, which is what makes the transition happen.
   *
   * Keyed on the sentence rather than on the strokes: the strokes are worked
   * out again whenever the text reflows, and a window being resized is not a
   * reason to draw the highlighter across the line a second time.
   *
   * A timer rather than an animation frame, for the reason the transcript
   * gives: a window that is not being painted never runs one, and the mark
   * would then never be asked to appear at all.
   */
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    setDrawn(false)
    if (!wanted.length) return
    const timer = setTimeout(() => setDrawn(true), 0)
    return () => clearTimeout(timer)
  }, [wanted.join('\u0000')])

  useEffect(() => {
    const element = body.current
    if (!element) return

    if (!wanted.length) {
      setStrokes([])
      return
    }

    const redraw = (): void => setStrokes(strokesFor(element, wanted))
    redraw()

    const observer = new ResizeObserver(redraw)
    observer.observe(element)
    return () => observer.disconnect()
    // A fresh array every render, so the sentences themselves are the key.
  }, [wanted.join('\u0000'), message.content])

  return (
    <div className="message__body" ref={body}>
      <Markdown content={message.content} codeTheme={ui.codeTheme} streaming={streaming} />
      {strokes.length > 0 && (
        <div className="ink" data-drawn={drawn} aria-hidden="true">
          {strokes.map((stroke, at) => (
            <span
              key={at}
              className="ink__stroke"
              style={{
                left: stroke.left,
                top: stroke.top,
                width: stroke.width,
                height: stroke.height,
                transitionDelay: `${stroke.delay}ms`
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One tool call, in the same shape as the trace above it.
 *
 * This was the bordered box, with a status dot in it and the tool's name in
 * bold — an object on the page, sitting between two halves of a reply that are
 * not objects. But a tool call is the same kind of thing as the thinking: it
 * is something that happened on the way to the answer, which you may look
 * inside if you want to. So it is the same line, and a run of them reads as a
 * list of things that happened rather than as a stack of boxes.
 *
 * "Ran x" or "x failed", because both are how it would be said aloud, and the
 * failing one puts the word that matters where the eye already is.
 */
/** The prefix `keepCitations` gives a search that had no call of its own. */
const PLUGIN_SEARCH = 'openrouter-search-'

/**
 * A search OpenRouter ran, put where a search belongs.
 *
 * The `:online` plugin searches before it answers, but says what it read
 * while the answer is already streaming — so the record of it is written
 * after the reply it informed, and the transcript showed the answer first
 * and the sources at the bottom. Read in that order it looks like an
 * afterthought rather than the thing the answer came from.
 *
 * Moving it to the front of the turn traded one wrong place for another: the
 * thinking lives *inside* the assistant message, not as a sibling of it, so
 * anything hoisted ahead of that message lands above the reasoning too — and
 * a search drawn before the thought that prompted it is no more honest than
 * one drawn after the answer it produced.
 *
 * So it is not reordered at all. It is taken out of the sequence and handed
 * to the message it belongs to — the id is in its own `toolCallId` — to be
 * drawn inside that turn, after the thinking and before the reply, exactly
 * where a real tool round would have gone. The stored order is untouched:
 * this is about reading, and the database is right that it learned about the
 * search last.
 */
function liftPluginSearches(messages: Message[]): {
  sequence: Message[]
  byOwner: Map<string, Message[]>
} {
  const byOwner = new Map<string, Message[]>()
  const present = new Set(messages.map((m) => m.id))

  const owner = (m: Message): string | null => {
    const id = m.toolResult?.toolCallId
    if (m.role !== 'tool' || !id?.startsWith(PLUGIN_SEARCH)) return null
    // Only if the reply it belongs to is on screen. A window that starts
    // mid-turn would otherwise drop the search out of the transcript
    // altogether rather than merely drawing it in the old place.
    const assistantId = id.slice(PLUGIN_SEARCH.length)
    return present.has(assistantId) ? assistantId : null
  }

  const sequence = messages.filter((m) => {
    const id = owner(m)
    if (!id) return true
    byOwner.set(id, [...(byOwner.get(id) ?? []), m])
    return false
  })

  return { sequence, byOwner }
}

function ToolStep({
  message,
  args
}: {
  message: Message
  /** What it was called with, which lives on the message that called it. */
  args?: string
}): React.JSX.Element {
  const result = message.toolResult
  const body = useHiddenPart(message.id, message.content || null, 'content')
  const name = result?.name ?? 'tool'
  return (
    <details
      className="aside tool-step"
      data-failed={result?.isError || undefined}
      onToggle={body.onToggle}
    >
      <summary className="aside__summary" title={args}>
        {result?.isError ? `${name} failed` : `Ran ${name}`}
        {/* Zero is "not timed", not "instant". A search OpenRouter ran inside
            the turn has no duration of its own to report, and "0ms" claims
            one — that it happened in no time at all. */}
        {result?.durationMs ? (
          <span className="aside__note">{formatDuration(result.durationMs)}</span>
        ) : null}
        <ChevronRight className="aside__caret" size={13} strokeWidth={2} />
      </summary>
      <div className="aside__body">
        {/* Nothing until it is opened: the body is not in the transcript, and
            building a `<pre>` for a result nobody looked at was the other half
            of the same cost. */}
        {body.open ? <LongText text={body.text ?? 'Loading…'} /> : <pre />}
      </div>
    </details>
  )
}

interface Props {
  messages: Message[]
  ui: UiSettings
  isLast: boolean
  /** Close enough to the window that its contents are worth building. */
  near: boolean
}

/**
 * Memoised for the same reason as `MessageItem`: a long conversation is a lot
 * of these, and a streamed delta or a highlight elsewhere must not wake them
 * all. `messages` is a fresh array on every group, so the comparison below is
 * on what a turn is actually made of.
 */
export const AssistantTurn = memo(function AssistantTurn({
  messages,
  ui,
  isLast,
  near
}: Props): React.JSX.Element {
  const regenerate = useStore((s) => s.regenerate)
  const showToast = useStore((s) => s.showToast)
  const setOverlay = useStore((s) => s.setOverlay)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const setHighlight = useStore((s) => s.setHighlight)
  // The answer rather than the id, so only the turn that holds the highlighted
  // message hears about it.
  const highlighted = useStore((s) =>
    messages.some((m) => m.id === s.highlightMessageId)
  )

  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!highlighted) return
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = setTimeout(() => setHighlight(null), 2000)
    return () => clearTimeout(timer)
  }, [highlighted, setHighlight])

  const first = messages[0]
  const attributed = messages.find((m) => m.model) ?? first
  const usage = sumUsage(messages)
  const chipSettings = ui.replyChips
  const streaming = messages.some((m) => m.status === 'streaming')

  /*
   * What goes inside waits until the turn comes near — the transcript decides
   * which those are, and the frame itself always renders because that is what
   * it measures to decide. See `ChatView`.
   *
   * A reply still arriving is built wherever it is: the text is changing, and
   * deferring something that is being written is deferring the one thing on
   * the page that is actually happening.
   */
  const built = near || streaming || highlighted
  const height = estimateTurnHeight(messages, ui.chatWidth)
  const text = messages
    .filter((m) => m.role === 'assistant' && m.content)
    .map((m) => m.content)
    .join('\n\n')

  const copy = (): void => {
    void navigator.clipboard.writeText(text)
    showToast('Copied the reply')
  }

  const branch = async (): Promise<void> => {
    if (!activeThreadId) return
    const thread = await window.deepPink.threads.branch(
      activeThreadId,
      messages[messages.length - 1].id
    )
    if (!thread) return
    await useStore.getState().refreshThreads()
    await useStore.getState().selectThread(thread.id)
    showToast('Branched into a new thread')
  }

  const toolCount = messages.filter((m) => m.role === 'tool').length

  /**
   * The calls that have a result row of their own, and what each was asked.
   *
   * A chip reading "called repo_read" directly above a line reading "Ran
   * repo_read" is the same fact twice in two different voices, and since the
   * line replaced the box it used to sit above, the pair now reads as one list
   * with every entry duplicated. So a call is announced only until it is
   * answered — which leaves the chip doing the one thing the line cannot,
   * which is to say that something is happening right now, or that something
   * was asked for and never came back.
   */
  const answered = new Set(
    messages.map((m) => m.toolResult?.toolCallId).filter((id): id is string => Boolean(id))
  )
  const argumentsOf = new Map<string, string>()
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) argumentsOf.set(call.id, call.arguments)
  }

  // The rows to draw in order, and the searches that belong inside one of them.
  const { sequence, byOwner: searchesFor } = liftPluginSearches(messages)

  /**
   * The figures under a finished reply, in the order they read in.
   *
   * Built as a list rather than written out as markup because which of them
   * appear is a setting now, and seven `&&` chains is a footer nobody can see
   * the shape of. Each still drops itself when there is nothing to say — a
   * model that did not reason has no thinking time, and a turn with no cache
   * hit has no cached tokens — so switching one on is permission rather than a
   * promise.
   */
  const chips = usage
    ? [
        {
          id: 'sent',
          show: chipSettings.sent,
          text: `${formatTokens(usage.promptTokens)} sent`,
          title: 'Tokens sent: this message and everything before it'
        },
        {
          id: 'back',
          show: chipSettings.back,
          text: `${formatTokens(usage.completionTokens)} back`,
          title: 'Tokens in the reply'
        },
        {
          id: 'thinking',
          show: chipSettings.thinking && usage.reasoningTokens > 0,
          text: `${formatTokens(usage.reasoningTokens)} thinking`,
          title: 'Tokens spent thinking before answering'
        },
        {
          id: 'cached',
          show: chipSettings.cached && usage.cachedTokens > 0,
          text: `${formatTokens(usage.cachedTokens)} cached`,
          title: 'Tokens that were already cached, and cost less'
        },
        {
          id: 'cost',
          show: chipSettings.cost,
          text: formatCost(usage.costUsd),
          title: 'Cost of this turn, including any tool rounds'
        },
        {
          id: 'speed',
          show: chipSettings.speed && Boolean(usage.tokensPerSecond),
          text: `${(usage.tokensPerSecond ?? 0).toFixed(1)} tok/s`,
          title: 'How fast it wrote'
        },
        {
          id: 'start',
          show: chipSettings.start && usage.timeToFirstTokenMs != null,
          text: `${formatDuration(usage.timeToFirstTokenMs ?? 0)} to start`,
          title: 'How long before the first token arrived'
        },
        {
          id: 'took',
          show: chipSettings.took && usage.latencyMs > 0,
          text: `${formatDuration(usage.latencyMs)} total`,
          title: 'How long the whole turn took, asking to answered'
        }
      ].filter((chip) => chip.show)
    : []

  return (
    <div
      className="message"
      data-role="assistant"
      data-density={ui.messageDensity}
      data-message-id={first.id}
      ref={ref}
      // The same, summed over the messages this turn is drawn from.
      style={{
        containIntrinsicSize: `auto ${height}px`,
        ...(highlighted ? { outline: '1px solid var(--accent-line)', borderRadius: 8 } : {})
      }}
    >
      {built ? (
        <>
          <div className="message__head">
            {/*
              * The model's name where the word "Assistant" was.
              *
              * It said "ASSISTANT" and then, in a chip beside it, which model —
              * a label followed by the only part of the pair anybody reads. The
              * name identifies the turn perfectly well on its own, so it is what
              * stands at the head of it, and "Assistant" is left for replies that
              * have no attribution to show.
              */}
            <span className="message__role" title={attributed.model ?? undefined}>
              {attributed.model ? modelShortName(attributed.model) : 'Assistant'}
            </span>
            {attributed.provider && <span className="chip">{attributed.provider}</span>}
            {toolCount > 0 && (
              <span className="chip" title="Tool calls made while answering">
                {toolCount} tool {toolCount === 1 ? 'call' : 'calls'}
              </span>
            )}

            <div className="message__actions">
              <button className="btn btn--ghost" onClick={copy} title="Copy" type="button">
                <Copy {...ICON} />
                Copy
              </button>
              <button
                className="btn btn--ghost"
                onClick={() => void regenerate(first.id)}
                title="Regenerate"
                type="button"
              >
                <RefreshCw {...ICON} />
                Retry
              </button>
              <button className="btn btn--ghost" onClick={() => void branch()} title="Branch" type="button">
                <GitBranch {...ICON} />
                Branch
              </button>
              {attributed.hasPromptSnapshot && (
                <button
                  className="btn btn--ghost"
                  onClick={() => setOverlay('prompt')}
                  title="What went into the context for this turn"
                  type="button"
                >
                  <FileText {...ICON} />
                  Context
                </button>
              )}
            </div>
          </div>

          {sequence.map((message) => {
            if (message.role === 'tool') {
              return (
                <ToolStep
                  key={message.id}
                  message={message}
                  args={argumentsOf.get(message.toolResult?.toolCallId ?? '')}
                />
              )
            }
            if (isEmptyAssistantMessage(message)) return null

            return (
              <div key={message.id} className="turn-part">
                <ReasoningTrace message={message} openByDefault={ui.showReasoningByDefault} />

                {/* What OpenRouter's own search read, in the place a tool
                    round would have gone: after the thinking, before the
                    reply it informed. See `liftPluginSearches`. */}
                {searchesFor.get(message.id)?.map((search) => (
                  <ToolStep key={search.id} message={search} />
                ))}

                {/*
                  * A rule between the thinking and the answer.
                  *
                  * Its own element rather than an edge on the line above it,
                  * because it is not part of the aside — it is the boundary
                  * between two different things the model produced, and an `<hr>`
                  * is exactly that: a thematic break.
                  *
                  * Only where there is something on both sides of it. A turn that
                  * reasoned its way to a tool call and wrote nothing has no
                  * boundary to draw, and a rule under the last thing on screen is
                  * a line with nothing to separate.
                  */}
                {reasoningLength(message) > 0 && message.content && <hr className="turn-rule" />}

                {message.content && <ReplyBody message={message} ui={ui} />}

                {/*
                  * What the model drew, shown the way what the reader attached
                  * is shown. Above the caret rather than below the text: for a
                  * model that draws, the picture is the answer and the words
                  * around it are the caption.
                  */}
                <ImageAttachments attachments={message.attachments} />

                {message.status === 'streaming' &&
                  !message.content &&
                  !message.attachments.some((a) => a.kind === 'image') && <span className="caret" />}

                {message.toolCalls?.some((call) => !answered.has(call.id)) ? (
                  <div className="row row--wrap" style={{ marginTop: 6 }}>
                    {message.toolCalls
                      .filter((call) => !answered.has(call.id))
                      .map((call) => (
                        <span key={call.id} className="chip chip--accent" title={call.arguments}>
                          {message.status === 'streaming' ? 'calling' : 'called'} {call.name}
                        </span>
                      ))}
                  </div>
                ) : null}

                {message.error && <div className="message__error">{message.error}</div>}

                {message.status === 'aborted' && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <span className="chip">stopped</span>
                  </div>
                )}
              </div>
            )
          })}

          {usage && chips.length > 0 && (
            <div className="message__footer">
              {chips.map((chip) => (
                <span
                  key={chip.id}
                  className={chip.id === 'cost' ? 'chip chip--accent' : 'chip'}
                  title={chip.title}
                >
                  {chip.text}
                </span>
              ))}
            </div>
          )}

          {isLast && streaming && text && <span className="caret" />}
        </>
      ) : (
        /*
         * Standing at the height the frame already claims — see the same
         * placeholder in `MessageItem`.
         */
        <div style={{ height }} aria-hidden="true" />
      )}
    </div>
  )
},
/**
 * `groupIntoTurns` rebuilds its arrays on every render, so the default
 * comparison — which is by identity — would find every turn changed every time
 * and the memo would do nothing at all. What a turn is made of is its rows, and
 * a row only becomes a new object when it actually changed.
 */
function same(before: Props, after: Props): boolean {
  if (before.ui !== after.ui || before.isLast !== after.isLast) return false
  if (before.near !== after.near) return false
  if (before.messages.length !== after.messages.length) return false
  return before.messages.every((message, at) => message === after.messages[at])
})
