import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CompactionStatus } from '@shared/types'
import { useStore } from '../store'
import { MessageItem } from './MessageItem'
import { Composer } from './Composer'
import { formatBinding } from '../keybinds'
import { formatCost, formatTokens, modelShortName } from '../format'

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

  const thread = threads.find((t) => t.id === activeThreadId) ?? null

  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [context, setContext] = useState<CompactionStatus | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)

  // Track whether the user has scrolled away; only autoscroll if they have not.
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useLayoutEffect(() => {
    if (!pinnedToBottom.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    pinnedToBottom.current = true
  }, [activeThreadId])

  // Refresh the context gauge when the conversation changes.
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
  }, [activeThreadId, messages.length, generating])

  if (!settings) return <div className="main" />

  const keybinds = settings.keybinds
  const model = thread?.config.model ?? settings.defaultModel
  const usedRatio = context?.limit ? Math.min(context.used / context.limit, 1) : 0

  const totalCost = messages.reduce((sum, m) => sum + (m.usage?.costUsd ?? 0), 0)
  const totalTokens = messages.reduce((sum, m) => sum + (m.usage?.totalTokens ?? 0), 0)

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
        >
          ☰
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
            {thread ? thread.title || 'Untitled thread' : 'Deep Pink'}
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
              {modelShortName(model)}
            </button>
            <button
              className="btn"
              onClick={() => setOverlay('providers')}
              title={`Provider routing — ${formatBinding(keybinds['provider.picker'])}`}
              type="button"
            >
              {thread.config.providerRouting?.order[0] ??
                settings.modelProviderRouting[model]?.order[0] ??
                'auto provider'}
            </button>
            <button
              className="btn"
              onClick={() => setOverlay('prompt')}
              title={`Inspect the system prompt — ${formatBinding(keybinds['prompt.inspect'])}`}
              type="button"
            >
              Prompt
            </button>
            <button
              className="btn"
              onClick={() => setOverlay('threadStats')}
              title={`Thread statistics — ${formatBinding(keybinds['stats.thread'])}`}
              type="button"
            >
              {formatTokens(totalTokens)} · {formatCost(totalCost)}
            </button>
          </>
        )}
      </div>

      {context?.limit ? (
        <div style={{ padding: '0 24px' }}>
          <div className="meter" title={`${context.used.toLocaleString()} of ${context.limit.toLocaleString()} context tokens`}>
            <div
              className="meter__fill"
              data-warn={usedRatio > settings.compaction.triggerRatio}
              style={{ width: `${usedRatio * 100}%` }}
            />
          </div>
        </div>
      ) : null}

      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="transcript__inner">
          {!thread ? (
            <div className="empty" style={{ height: '50vh' }}>
              <div className="empty__title">Nothing open</div>
              <p>Start a thread to begin.</p>
              <button className="btn btn--primary" onClick={() => void createThread()} type="button">
                New thread
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="empty" style={{ height: '46vh' }}>
              <div className="empty__title">Ask anything</div>
              <p>
                Using <strong>{modelShortName(model)}</strong>. Press{' '}
                <span className="kbd">{formatBinding(keybinds['palette.open'])}</span> for the
                command palette, or <span className="kbd">{formatBinding(keybinds['keybinds.cheatsheet'])}</span>{' '}
                for every shortcut.
              </p>
            </div>
          ) : (
            messages.map((message, index) => (
              <MessageItem
                key={message.id}
                message={message}
                ui={settings.ui}
                isLast={index === messages.length - 1}
              />
            ))
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
