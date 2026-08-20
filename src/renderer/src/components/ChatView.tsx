import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CompactionStatus } from '@shared/types'
import { useStore } from '../store'
import { MessageItem } from './MessageItem'
import { AssistantTurn } from './AssistantTurn'
import { groupIntoTurns } from '../turns'
import { Composer } from './Composer'
import { BarChart3, Cpu, FileText, PanelLeft, Plus, Route } from 'lucide-react'
import { ICON } from '../icons'
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
        </div>
      ) : null}

      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="transcript__inner">
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
              <div className="empty__title">Ask anything</div>
              <p>
                Using <strong>{modelShortName(model)}</strong>. Press{' '}
                <span className="kbd">{formatBinding(keybinds['palette.open'])}</span> for the
                command palette, or <span className="kbd">{formatBinding(keybinds['keybinds.cheatsheet'])}</span>{' '}
                for every shortcut.
              </p>
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
