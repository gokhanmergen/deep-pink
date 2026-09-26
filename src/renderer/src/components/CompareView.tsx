import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Maximize2, PanelLeft, X } from 'lucide-react'
import { useStore, type CompareSide } from '../store'
import { MessageItem } from './MessageItem'
import { AssistantTurn } from './AssistantTurn'
import { Composer, type ComposerTarget } from './Composer'
import { ModelIcon } from './ModelIcon'
import { groupIntoTurns } from '../turns'
import { ICON } from '../icons'
import { formatBinding } from '../keybinds'
import { formatCost, formatTokens, modelShortName } from '../format'
import {
  TranscriptActionsContext,
  branchThread,
  type TranscriptActions
} from '../transcriptActions'

/** Where the question both sides are asked is kept while it is being written. */
export const COMPARE_DRAFT = 'compare:start'

/**
 * Two models, one question, and then two conversations.
 *
 * The first message is written once, underneath both, and sent to each side at
 * the same moment. After that each side has its own composer and goes its own
 * way: a comparison is only fair on the question they share, and what either
 * is asked next depends on what it said.
 *
 * Both sides are ordinary threads in the list, linked to each other. Either
 * can be carried on alone, and either reopens the pair.
 */
export function CompareView(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  // Both threads are made together, so one having begun is both having begun.
  const started = useStore((s) => Boolean(s.compare?.[0].threadId))
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const closeCompare = useStore((s) => s.closeCompare)
  const startCompare = useStore((s) => s.startCompare)

  const keybinds = settings?.keybinds ?? {}

  const startTarget = useMemo<ComposerTarget>(
    () => ({
      threadId: null,
      draftKey: COMPARE_DRAFT,
      generating: false,
      send: (content, attachments) => {
        // Asked here, before the composer lets go of what was typed, rather
        // than only in the store, where refusing would be too late to keep it.
        const compare = useStore.getState().compare
        if (!compare?.[0].model || !compare[1].model) {
          useStore.getState().showToast('Choose a model for each side first', 'error')
          return false
        }
        void startCompare(content, attachments)
        return true
      },
      abort: () => undefined,
      chooseModel: null,
      placeholder: 'Ask both models the same thing — paste or drop images to attach',
      autoFocus: true
    }),
    [startCompare]
  )

  return (
    <div className="main compare">
      <div className="topbar">
        <button
          className="btn btn--ghost"
          onClick={toggleSidebar}
          title={`Toggle sidebar — ${formatBinding(keybinds['sidebar.toggle'] ?? 'mod+b')}`}
          type="button"
          aria-label="Toggle sidebar"
        >
          <PanelLeft {...ICON} />
        </button>
        <span className="topbar__title">Side by side</span>
        <button
          className="btn"
          onClick={() => void closeCompare(0)}
          title={`Back to one conversation — ${formatBinding(keybinds['compare.toggle'] ?? 'mod+\\')}`}
          type="button"
        >
          <X {...ICON} />
          <span className="btn__label">Close</span>
        </button>
      </div>

      <div className="compare__panes">
        <ComparePaneView side={0} />
        <ComparePaneView side={1} />
      </div>

      {!started && <Composer target={startTarget} />}
    </div>
  )
}

/**
 * One side: which model, what it has cost, and its conversation.
 *
 * A plainer transcript than the main one. That one lands on the last exchange,
 * restores where you were reading, and builds messages only as they come near
 * — all of it for threads of thousands of messages opened from a list. A side
 * of a comparison is opened by starting it, is read as it is written, and so
 * follows the end while it is at the end and otherwise stays where it is put.
 */
function ComparePaneView({ side }: { side: CompareSide }): React.JSX.Element | null {
  const settings = useStore((s) => s.settings)
  const pane = useStore((s) => s.compare?.[side] ?? null)
  const thread = useStore((s) => {
    const id = s.compare?.[side].threadId
    return id ? (s.threads.find((t) => t.id === id) ?? null) : null
  })
  const setOverlay = useStore((s) => s.setOverlay)
  const closeCompare = useStore((s) => s.closeCompare)
  const sendToPane = useStore((s) => s.sendToPane)
  const abortPane = useStore((s) => s.abortPane)
  const regenerateInPane = useStore((s) => s.regenerateInPane)
  const resendFromInPane = useStore((s) => s.resendFromInPane)
  const refreshPane = useStore((s) => s.refreshPane)
  const loadOlderInPane = useStore((s) => s.loadOlderInPane)

  const threadId = pane?.threadId ?? null
  const generating = pane?.generating ?? false
  const messages = pane?.messages ?? []
  const model = thread?.config.model ?? pane?.model ?? null

  const actions = useMemo<TranscriptActions>(
    () => ({
      regenerate: (messageId) => regenerateInPane(side, messageId),
      resendFrom: (messageId) => resendFromInPane(side, messageId),
      refresh: () => refreshPane(side),
      branch: async (messageId) => {
        const id = useStore.getState().compare?.[side].threadId
        if (id) await branchThread(id, messageId)
      },
      // The inspector describes the open thread, and neither side is that.
      inspectPrompt: null
    }),
    [side, regenerateInPane, resendFromInPane, refreshPane]
  )

  const target = useMemo<ComposerTarget | null>(
    () =>
      threadId
        ? {
            threadId,
            draftKey: threadId,
            generating,
            send: (content, attachments) => {
              void sendToPane(side, content, attachments)
              return true
            },
            abort: () => void abortPane(side),
            chooseModel: null,
            placeholder: 'Carry on with this one…',
            // Two of these appear together, and only one can have the caret.
            autoFocus: false
          }
        : null,
    [threadId, generating, side, sendToPane, abortPane]
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  /** Following the end, which is where a reply being written is. */
  const pinned = useRef(true)
  /** The message held in place while a page is read in above it. */
  const anchor = useRef<{ id: string; top: number } | null>(null)

  /** Reads in the page above, holding the first message where it is. */
  const readOlder = useCallback((): void => {
    const el = scrollRef.current
    const current = useStore.getState().compare?.[side]
    if (!el || !current?.hasOlder || current.loadingOlder) return

    const first = el.querySelector<HTMLElement>('[data-message-id]')
    const mark = first?.dataset.messageId
      ? { id: first.dataset.messageId, top: first.getBoundingClientRect().top }
      : null
    anchor.current = mark
    void loadOlderInPane(side).then((added) => {
      if (!added && anchor.current === mark) anchor.current = null
    })
  }, [side, loadOlderInPane])

  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (el.scrollTop < el.clientHeight) readOlder()
  }, [readOlder])

  // A different thread on this side is a conversation to follow from its end.
  useLayoutEffect(() => {
    pinned.current = true
    anchor.current = null
  }, [threadId])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // A page landed above: put the reader back on the message they were at.
    const mark = anchor.current
    if (mark && el.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId !== mark.id) {
      anchor.current = null
      const held = el.querySelector(`[data-message-id="${CSS.escape(mark.id)}"]`)
      if (held) {
        el.scrollTop += held.getBoundingClientRect().top - mark.top
        return
      }
    }

    if (pinned.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // Heights settle after a render — code is highlighted, pictures load — and
  // a reader at the end should still be at the end once they have.
  useEffect(() => {
    const el = scrollRef.current
    const inner = el?.firstElementChild
    if (!el || !inner) return
    const observer = new ResizeObserver(() => {
      if (pinned.current && !anchor.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  // Opening a reasoning trace or a tool result is the reader choosing where to
  // look, and following the end would scroll away from what they opened. See
  // the same listener in `ChatView`.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onToggle = (): void => {
      pinned.current = false
    }
    el.addEventListener('toggle', onToggle, true)
    return () => el.removeEventListener('toggle', onToggle, true)
  }, [])

  // A page that does not fill the column leaves nothing to scroll, and so
  // nothing to ask for the next page with.
  const hasOlder = pane?.hasOlder ?? false
  useEffect(() => {
    const el = scrollRef.current
    if (el && hasOlder && el.scrollHeight <= el.clientHeight * 1.5) readOlder()
  }, [messages, hasOlder, readOlder])

  if (!settings || !pane) return null

  const blocks = groupIntoTurns(messages)
  const chooseModel = (): void => setOverlay(side === 0 ? 'compareModelLeft' : 'compareModelRight')
  const totals = pane.totals

  return (
    <TranscriptActionsContext.Provider value={actions}>
      <section className="compare__pane" aria-label={side === 0 ? 'Left side' : 'Right side'}>
        <div className="compare__head">
          <button
            className="btn"
            data-unset={!model || undefined}
            onClick={chooseModel}
            title={model ? `${model} — choose another` : 'Choose the model for this side'}
            type="button"
          >
            <ModelIcon model={model} size={14} />
            <span className="btn__label">{model ? modelShortName(model) : 'Choose a model'}</span>
          </button>
          {generating && <span className="chip chip--accent">replying…</span>}
          <div className="topbar__spacer" />
          {totals && totals.totalTokens > 0 && (
            <span className="chip" title="What this side has cost so far">
              {formatTokens(totals.totalTokens)} · {formatCost(totals.costUsd)}
            </span>
          )}
          {threadId && (
            <button
              className="btn btn--ghost"
              onClick={() => void closeCompare(side)}
              title="Carry on with just this side"
              aria-label="Carry on with just this side"
              type="button"
            >
              <Maximize2 {...ICON} />
            </button>
          )}
        </div>

        <div className="transcript" ref={scrollRef} onScroll={onScroll}>
          <div className="transcript__inner">
            {pane.hasOlder && (
              <div className="transcript__earlier" aria-hidden="true">
                earlier messages
              </div>
            )}

            {!threadId ? (
              <div className="empty compare__empty">
                {model ? (
                  <>
                    <ModelIcon model={model} size={28} />
                    <div className="empty__title">{modelShortName(model)}</div>
                    <p>Asked the same first message as the other side, then carries on by itself.</p>
                  </>
                ) : (
                  <>
                    <div className="empty__title">Choose a model</div>
                    <p>The one this side is asked with. Both are asked the same first message.</p>
                    <button className="btn btn--primary" onClick={chooseModel} type="button">
                      Choose a model
                    </button>
                  </>
                )}
              </div>
            ) : (
              blocks.map((block, index) =>
                block.kind === 'message' ? (
                  <MessageItem key={block.id} message={block.message} ui={settings.ui} near />
                ) : (
                  <AssistantTurn
                    key={block.id}
                    messages={block.messages}
                    ui={settings.ui}
                    isLast={index === blocks.length - 1}
                    near
                  />
                )
              )
            )}
          </div>
        </div>

        {target && <Composer target={target} />}
      </section>
    </TranscriptActionsContext.Provider>
  )
}
