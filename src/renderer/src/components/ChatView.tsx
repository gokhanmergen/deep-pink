import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CompactionStatus } from '@shared/types'
import { canBecomeTemporary, placeOf, rememberPlace, useStore } from '../store'
import { MessageItem } from './MessageItem'
import { AssistantTurn } from './AssistantTurn'
import { groupIntoTurns } from '../turns'
import { Composer } from './Composer'
import { BarChart3, Cpu, FileText, Ghost, PanelLeft, Plus, Route } from 'lucide-react'
import { ICON } from '../icons'
import { formatBinding } from '../keybinds'
import { formatCost, formatTokens, modelShortName, threadLabel } from '../format'

export function ChatView(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const threads = useStore((s) => s.threads)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const messages = useStore((s) => s.messages)
  const generating = useStore((s) => s.generating)
  const compacting = useStore((s) => s.compacting)
  const setOverlay = useStore((s) => s.setOverlay)
  const updateThread = useStore((s) => s.updateThread)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const createThread = useStore((s) => s.createThread)
  const keepThread = useStore((s) => s.keepThread)
  const makeThreadTemporary = useStore((s) => s.makeThreadTemporary)
  const showToast = useStore((s) => s.showToast)
  const compact = useStore((s) => s.compact)
  // Subscribed to so the top-up below re-runs when either changes; the values
  // it acts on are read from the store, which is never a frame behind.
  const hasOlderMessages = useStore((s) => s.hasOlderMessages)
  const loadingOlder = useStore((s) => s.loadingOlder)
  const threadTotals = useStore((s) => s.threadTotals)

  const thread = threads.find((t) => t.id === activeThreadId) ?? null

  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [context, setContext] = useState<CompactionStatus | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)

  /**
   * The message the reader is looking at, held across a page arriving above it.
   *
   * Messages inserted above the viewport push everything below them down by
   * their own height, which would throw the reader down the page. So one
   * element is remembered by id along with where it was on screen, and after
   * the render the view is moved by however far it went — in a layout effect,
   * before the browser paints, so there is no frame in which anything is in
   * the wrong place.
   *
   * Deliberately an element rather than a distance from either end. A reply
   * still arriving grows the transcript at the bottom, and any measure taken
   * from an end would read that growth as the prepend and move the page by it.
   * Nothing that happens below the anchor can move the anchor.
   */
  const anchor = useRef<{ id: string; top: number } | null>(null)

  /**
   * The thread that has been opened but not yet put back in its place.
   *
   * Set the moment the thread changes, and consumed by the layout effect when
   * that thread's messages actually arrive — which is a separate render, a
   * round trip later.
   */
  const restoring = useRef<string | null>(null)

  /**
   * Reads in the page above, holding the reader's place across it.
   *
   * Both callers guard on the store rather than on what they last rendered.
   * A render-time `loadingOlder` can be a frame behind the store's, and the
   * cost of being wrong is not a duplicate request — the store refuses that —
   * but a refusal arriving as `false` and clearing an anchor that the request
   * actually in flight is going to need.
   */
  const readOlder = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return

    const store = useStore.getState()
    if (!store.hasOlderMessages || store.loadingOlder) return

    const held = el.querySelector<HTMLElement>('[data-message-id]')
    const mark = held?.dataset.messageId
      ? { id: held.dataset.messageId, top: held.getBoundingClientRect().top }
      : null
    anchor.current = mark

    void store.loadOlderMessages().then((added) => {
      // Nothing came, so nothing needs putting back — and an anchor left set
      // would move the view the next time anything at all re-rendered. Only
      // ours is cleared, never one a later request is waiting on.
      if (!added && anchor.current === mark) anchor.current = null
    })
  }, [])

  /**
   * Asks for the page above while it is still two screens away.
   *
   * The point is that the reader never arrives at an edge: by the time the
   * older messages would be needed they have been rendered for a while.
   */
  const fetchAhead = useCallback((): void => {
    const el = scrollRef.current
    if (!el || el.scrollTop > el.clientHeight * 2) return
    readOlder()
  }, [readOlder])

  /**
   * Measured in the event rather than on the next frame.
   *
   * Deferring to `requestAnimationFrame` is the usual advice for scroll
   * handlers, and it was wrong here: rAF does not run in a window that is not
   * being painted, and this handler is not doing cosmetic work — it is what
   * decides that more of the conversation should be read in. Making that
   * conditional on the compositor is how a transcript ends up stuck.
   *
   * The reads themselves are cheap: during a scroll nothing has dirtied the
   * DOM, so `scrollHeight` is a cached value rather than a forced layout. The
   * one exception is the frame just after a page was prepended, which is one
   * layout, once per page.
   */
  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80

    // Where this conversation is being read, kept current as it is read. No
    // "before you leave" hook is needed this way, and there is no such hook
    // worth trusting: the thread changes under this component rather than
    // unmounting it.
    const store = useStore.getState()
    if (store.activeThreadId) {
      rememberPlace(store.activeThreadId, {
        startSeq: store.messageWindowStart,
        scrollTop: el.scrollTop,
        atBottom: pinnedToBottom.current
      })
    }

    fetchAhead()
  }, [fetchAhead])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // A thread has just been opened. Wait for its own messages — the ones on
    // screen are still the last thread's until the round trip returns — and
    // then put the reader where they were, or at the end if they have not
    // been here before.
    const opening = restoring.current
    if (opening !== null) {
      if (messages.length && messages[0].threadId !== opening) return
      restoring.current = null

      const place = placeOf(opening)
      if (place && !place.atBottom) {
        el.scrollTop = place.scrollTop
        pinnedToBottom.current = false
      } else {
        el.scrollTop = el.scrollHeight
        pinnedToBottom.current = true
      }
      return
    }

    const mark = anchor.current
    // Something is now above what used to be first: a page has landed. Put the
    // reader back on the message they were reading. A render that changed only
    // the bottom of the transcript leaves the mark alone, to be used by the
    // page that is still on its way.
    if (mark && el.querySelector<HTMLElement>('[data-message-id]')?.dataset.messageId !== mark.id) {
      const held = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(mark.id)}"]`)
      anchor.current = null
      if (held) {
        el.scrollTop += held.getBoundingClientRect().top - mark.top
        return
      }
    }

    if (pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    pinnedToBottom.current = true
    anchor.current = null
    restoring.current = activeThreadId
  }, [activeThreadId])

  /**
   * Holds the end of the conversation while it settles.
   *
   * A transcript is not its final height when it is first laid out: code
   * blocks arrive as plain text and become highlighted, pictures load, and
   * messages scrolled past report an estimated height until they have been
   * seen once. Every one of those changes the height *after* the view was put
   * at the bottom, which is why opening a thread landed somewhere slightly
   * different each time depending on what finished first.
   *
   * So the bottom is held rather than set: while the reader is at the end,
   * anything that changes the height puts them back at the end.
   */
  useEffect(() => {
    const el = scrollRef.current
    const inner = el?.firstElementChild
    if (!el || !inner) return

    const observer = new ResizeObserver(() => {
      // Not while a page is landing above: that has its own anchor, and this
      // would fight it.
      if (anchor.current || restoring.current) return
      if (pinnedToBottom.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  /**
   * Tops the transcript up until there is something to scroll.
   *
   * A page is a count of messages, and forty short ones do not fill a window —
   * which would leave the scroll handler with no room to fire in and the reader
   * at the top of a conversation that looks finished. Runs after each page
   * lands, and stops as soon as there is a screenful in reserve.
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el || el.scrollHeight > el.clientHeight * 2.5) return
    readOlder()
  }, [messages, hasOlderMessages, loadingOlder, readOlder])

  /*
   * Refresh the context gauge when the conversation changes.
   *
   * Keyed on the *last* message rather than on how many there are. Scrolling
   * back reads in older messages, which changes the count and changes the
   * context not at all — so a gauge watching the count asked the main process
   * to work it out again for every page the reader scrolled past.
   */
  const lastMessageId = messages[messages.length - 1]?.id
  useEffect(() => {
    if (!activeThreadId) {
      setContext(null)
      return
    }
    let cancelled = false
    void window.deepPink.chat.compactionStatus(activeThreadId).then((status) => {
      if (!cancelled) setContext(status)
    })
    return () => {
      cancelled = true
    }
  }, [activeThreadId, lastMessageId, generating])

  if (!settings) return <div className="main" />

  const keybinds = settings.keybinds
  const model = thread?.config.model ?? settings.defaultModel
  const usedRatio = context?.limit ? Math.min(context.used / context.limit, 1) : 0

  // The thread's, not the sum of what has been read in — a figure that counted
  // upwards as you scrolled back would be a lie about what anything cost.
  const totalCost = threadTotals?.costUsd ?? 0
  const totalTokens = threadTotals?.totalTokens ?? 0

  /**
   * Both halves of the switch. The same thing the shortcut does, because a
   * button and a binding that disagreed would be two features.
   */
  const toggleTemporary = async (): Promise<void> => {
    if (!thread) return
    if (thread.temporary) {
      await keepThread(thread.id)
      showToast('Kept — this chat now stays')
      return
    }
    const made = await makeThreadTemporary(thread.id)
    showToast(
      made
        ? 'Temporary — this chat is deleted when you leave it'
        : 'Only a new chat — unnamed, unpinned and unused — can be made temporary'
    )
  }

  const commitRename = (): void => {
    if (thread) void updateThread(thread.id, { title: titleDraft.trim() })
    setRenaming(false)
  }

  return (
    <div className="main">
      <div className="topbar">
        <button
          className="btn btn--ghost"
          onClick={toggleSidebar}
          title={`Toggle sidebar — ${formatBinding(keybinds['sidebar.toggle'])}`}
          type="button"
          aria-label="Toggle sidebar"
        >
          <PanelLeft {...ICON} />
        </button>

        {renaming && thread ? (
          <input
            className="input"
            style={{ maxWidth: 380 }}
            value={titleDraft}
            autoFocus
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <button
            className="topbar__title"
            style={{ textAlign: 'left' }}
            onDoubleClick={() => {
              if (!thread) return
              setTitleDraft(thread.title)
              setRenaming(true)
            }}
            title="Double-click to rename"
            type="button"
          >
            {thread ? threadLabel(thread) : 'Deep Pink'}
          </button>
        )}

        {/* A switch, in the one place a reader is already looking at what this
            conversation is. It shows on a chat that is temporary and on one
            that could still become temporary, and it is the same control in
            both cases — the styling says which way it is set, and clicking it
            sets it the other way. On a chat that has been spoken in there is
            nothing to offer, so there is no button. */}
        {thread && (thread.temporary || canBecomeTemporary(thread)) && (
          <button
            className="btn btn--ghost temp-badge"
            data-on={thread.temporary}
            onClick={() => void toggleTemporary()}
            title={
              thread.temporary
                ? `Temporary — deleted when you leave it or close the app (${formatBinding(
                    keybinds['thread.toggleTemporary']
                  )})`
                : `Make this chat temporary — deleted when you leave it (${formatBinding(
                    keybinds['thread.toggleTemporary']
                  )})`
            }
            type="button"
          >
            <Ghost {...ICON} />
            <span className="btn__label">Temporary</span>
          </button>
        )}

        {thread && (
          <>
            <button
              className="btn"
              onClick={() => setOverlay('models')}
              title={`Model — ${formatBinding(keybinds['model.picker'])}`}
              type="button"
            >
              <Cpu {...ICON} />
              <span className="btn__label">{modelShortName(model)}</span>
            </button>
            <button
              className="btn"
              onClick={() => setOverlay('providers')}
              title={`Provider routing — ${formatBinding(keybinds['provider.picker'])}`}
              type="button"
            >
              <Route {...ICON} />
              <span className="btn__label">
                {thread.config.providerRouting?.order[0] ??
                  settings.modelProviderRouting[model]?.order[0] ??
                  'auto provider'}
              </span>
            </button>
            <button
              className="btn"
              onClick={() => setOverlay('prompt')}
              title={`Inspect the system prompt — ${formatBinding(keybinds['prompt.inspect'])}`}
              type="button"
            >
              <FileText {...ICON} />
              Prompt
            </button>
            <button
              className="btn"
              onClick={() => setOverlay('threadStats')}
              title={`Thread statistics — ${formatBinding(keybinds['stats.thread'])}`}
              type="button"
            >
              <BarChart3 {...ICON} />
              {formatTokens(totalTokens)} · {formatCost(totalCost)}
            </button>
          </>
        )}
      </div>

      {/* A gauge of how full the context window is. Hidden while a thread is
          nearly empty, where a full-width track with an invisible fill reads as
          a stray line rather than information. */}
      {context?.limit && usedRatio >= 0.01 ? (
        <div
          className="context-gauge"
          title={`${context.used.toLocaleString()} of ${context.limit.toLocaleString()} context tokens`}
        >
          <div className="meter">
            <div
              className="meter__fill"
              data-warn={usedRatio > settings.compaction.triggerRatio}
              style={{ width: `${Math.max(usedRatio * 100, 1)}%` }}
            />
          </div>
          <span className="context-gauge__label">
            {Math.round(usedRatio * 100)}% of context
          </span>
          {/* Compaction asks first unless it has been told not to — and asking
              has to happen somewhere. Here, where the gauge that says why is
              already on screen, rather than as a dialog over a reply. */}
          {context.needed && settings.compaction.requireConfirmation && !compacting && (
            <button
              className="btn btn--small"
              disabled={generating}
              onClick={() => void compact()}
              title={`Replace the older part of this thread with a summary — ${formatBinding(
                keybinds['context.compact']
              )}`}
              type="button"
            >
              Compact now
            </button>
          )}
        </div>
      ) : null}

      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="transcript__inner">
          {/* A fixed height, held for as long as there is anything above — so
              it cannot change size as pages arrive, and so nothing below it can
              be moved by one. Meant to be scrolled past rather than read: by
              the time it is on screen the page it stands for is usually already
              rendered above it. */}
          {hasOlderMessages && (
            <div className="transcript__earlier" aria-hidden="true">
              earlier messages
            </div>
          )}
          {!thread ? (
            <div className="empty" style={{ height: '50vh' }}>
              <div className="empty__title">Nothing open</div>
              <p>Start a thread to begin.</p>
              <button className="btn btn--primary" onClick={() => void createThread()} type="button">
                <Plus {...ICON} />
                New thread
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="empty" style={{ height: '46vh' }}>
              <div className="empty__title">
                {thread.temporary ? 'Ask, and forget' : 'Ask anything'}
              </div>
              {thread.temporary && (
                <p>
                  Nothing said here is kept. It is deleted when you open another
                  chat or close the app, and it is never synced.
                </p>
              )}
              <p>
                Using <strong>{modelShortName(model)}</strong>. Press{' '}
                <span className="kbd">{formatBinding(keybinds['palette.open'])}</span> for the
                command palette, or <span className="kbd">{formatBinding(keybinds['keybinds.cheatsheet'])}</span>{' '}
                for every shortcut.
              </p>
              {/* Said here because here is the only place it can be done: a
                  chat can be made temporary before it is used and not after. */}
              {!thread.temporary && (
                <p>
                  <span className="kbd">{formatBinding(keybinds['thread.toggleTemporary'])}</span>{' '}
                  makes this one temporary — deleted when you leave it, and never synced.
                </p>
              )}
            </div>
          ) : (
            groupIntoTurns(messages).map((block, index, blocks) =>
              block.kind === 'message' ? (
                <MessageItem key={block.id} message={block.message} ui={settings.ui} />
              ) : (
                <AssistantTurn
                  key={block.id}
                  messages={block.messages}
                  ui={settings.ui}
                  isLast={index === blocks.length - 1}
                />
              )
            )
          )}

          {compacting && (
            <div className="row" style={{ margin: '10px 0' }}>
              <span className="chip chip--accent">compacting context…</span>
            </div>
          )}
        </div>
      </div>

      <Composer />
    </div>
  )
}
