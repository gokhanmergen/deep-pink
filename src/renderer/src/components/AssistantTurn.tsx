import { memo, useEffect, useRef, useState } from 'react'
import { ChevronRight, Copy, FileText, GitBranch, RefreshCw } from 'lucide-react'
import { ICON } from '../icons'
import type { Message, UiSettings, Usage } from '@shared/types'
import { Markdown } from './Markdown'
import { LongText } from './LongText'
import { useStore } from '../store'
import { isEmptyAssistantMessage } from '../turns'
import { estimateTurnHeight } from '../messageHeight'
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
    <details className="reasoning" open={openByDefault} onToggle={trace.onToggle}>
      <summary className="reasoning__summary">
        {message.usage?.reasoningMs
          ? `Reasoned for ${formatDuration(message.usage.reasoningMs)}`
          : 'Reasoned'}
        <span className="reasoning__tokens">{formatTokens(Math.ceil(length / 4))} tokens</span>
        <ChevronRight className="reasoning__caret" size={13} strokeWidth={2} />
      </summary>
      <div className="reasoning__body">
        {trace.open ? <LongText text={trace.text ?? 'Loading…'} /> : <pre />}
      </div>
    </details>
  )
}

function ToolStep({ message }: { message: Message }): React.JSX.Element {
  const result = message.toolResult
  const body = useHiddenPart(message.id, message.content || null, 'content')
  return (
    <details className="disclosure tool-step" onToggle={body.onToggle}>
      <summary className="disclosure__summary">
        <span className="dot" data-state={result?.isError ? 'error' : 'connected'} />
        <strong>{result?.name ?? 'tool'}</strong>
        <span className="dim">
          {result?.isError ? 'failed' : 'returned'}
          {result ? ` · ${formatDuration(result.durationMs)}` : ''}
        </span>
      </summary>
      <div className="disclosure__content">
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

          {messages.map((message) => {
            if (message.role === 'tool') return <ToolStep key={message.id} message={message} />
            if (isEmptyAssistantMessage(message)) return null

            return (
              <div key={message.id} className="turn-part">
                <ReasoningTrace message={message} openByDefault={ui.showReasoningByDefault} />

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

                {message.content && (
                  <div className="message__body">
                    <Markdown
                      content={message.content}
                      codeTheme={ui.codeTheme}
                      streaming={message.status === 'streaming'}
                    />
                  </div>
                )}

                {message.status === 'streaming' && !message.content && <span className="caret" />}

                {message.toolCalls?.length ? (
                  <div className="row row--wrap" style={{ marginTop: 6 }}>
                    {message.toolCalls.map((call) => (
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
