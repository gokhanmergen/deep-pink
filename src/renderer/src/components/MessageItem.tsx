import { useEffect, useRef, useState } from 'react'
import type { Message, UiSettings } from '@shared/types'
import { Markdown } from './Markdown'
import { formatCost, formatDuration, formatTokens, modelShortName } from '../format'
import { useStore } from '../store'

interface Props {
  message: Message
  ui: UiSettings
  isLast: boolean
}

export function MessageItem({ message, ui, isLast }: Props): React.JSX.Element | null {
  const regenerate = useStore((s) => s.regenerate)
  const showToast = useStore((s) => s.showToast)
  const setOverlay = useStore((s) => s.setOverlay)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const highlightMessageId = useStore((s) => s.highlightMessageId)
  const setHighlight = useStore((s) => s.setHighlight)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (highlightMessageId === message.id) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const timer = setTimeout(() => setHighlight(null), 2000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [highlightMessageId, message.id, setHighlight])

  // Marker rows exist only to attribute title-generation cost; never shown.
  if (message.compactedInto === 'title') return null

  const copy = (): void => {
    void navigator.clipboard.writeText(message.content)
    showToast('Copied to clipboard')
  }

  const branch = async (): Promise<void> => {
    if (!activeThreadId) return
    const thread = await window.deepPink.threads.branch(activeThreadId, message.id)
    if (thread) {
      await useStore.getState().refreshThreads()
      await useStore.getState().selectThread(thread.id)
      showToast('Branched into a new thread')
    }
  }

  const saveEdit = async (): Promise<void> => {
    await window.deepPink.messages.update(message.id, { content: draft })
    setEditing(false)
    if (activeThreadId) {
      await useStore.getState().selectThread(activeThreadId)
    }
  }

  if (message.role === 'tool') {
    const result = message.toolResult
    return (
      <div className="message" data-role="tool" data-density={ui.messageDensity} ref={ref}>
        <details className="disclosure">
          <summary className="disclosure__summary">
            <span className="dot" data-state={result?.isError ? 'error' : 'connected'} />
            <strong>{result?.name ?? 'tool'}</strong>
            <span className="dim">
              {result?.isError ? 'failed' : 'returned'}
              {result ? ` · ${formatDuration(result.durationMs)}` : ''}
            </span>
          </summary>
          <div className="disclosure__content">
            <pre>{message.content}</pre>
          </div>
        </details>
      </div>
    )
  }

  if (message.role === 'system') {
    if (!message.isCompactionSummary) return null
    return (
      <div className="message" data-role="system" data-density={ui.messageDensity} ref={ref}>
        <details className="disclosure">
          <summary className="disclosure__summary">
            <span className="chip chip--accent">compacted</span>
            <span>Summary of the earlier conversation</span>
          </summary>
          <div className="disclosure__content">
            <Markdown content={message.content} codeTheme={ui.codeTheme} />
          </div>
        </details>
      </div>
    )
  }

  const isUser = message.role === 'user'
  const streaming = message.status === 'streaming'

  return (
    <div
      className="message"
      data-role={message.role}
      data-density={ui.messageDensity}
      ref={ref}
      style={
        highlightMessageId === message.id
          ? { outline: '1px solid var(--accent-line)', borderRadius: 8 }
          : undefined
      }
    >
      <div className="message__head">
        <span className="message__role">{isUser ? 'You' : 'Assistant'}</span>
        {message.model && !isUser && (
          <span className="chip" title={message.model}>
            {modelShortName(message.model)}
          </span>
        )}
        {message.provider && <span className="chip">{message.provider}</span>}

        <div className="message__actions">
          <button className="btn btn--ghost" onClick={copy} title="Copy" type="button">
            Copy
          </button>
          {isUser && (
            <button
              className="btn btn--ghost"
              onClick={() => {
                setDraft(message.content)
                setEditing(true)
              }}
              title="Edit"
              type="button"
            >
              Edit
            </button>
          )}
          {!isUser && (
            <button
              className="btn btn--ghost"
              onClick={() => void regenerate(message.id)}
              title="Regenerate"
              type="button"
            >
              Retry
            </button>
          )}
          <button className="btn btn--ghost" onClick={() => void branch()} title="Branch" type="button">
            Branch
          </button>
          {message.systemPromptSnapshot && (
            <button
              className="btn btn--ghost"
              onClick={() => setOverlay('prompt')}
              title="What went into the context for this turn"
              type="button"
            >
              Context
            </button>
          )}
        </div>
      </div>

      {message.reasoning && (
        <details className="disclosure" open={ui.showReasoningByDefault}>
          <summary className="disclosure__summary">
            <span className="chip">reasoning</span>
            <span className="dim">{formatTokens(Math.ceil(message.reasoning.length / 4))} tokens</span>
          </summary>
          <div className="disclosure__content">
            <pre>{message.reasoning}</pre>
          </div>
        </details>
      )}

      <div className="message__body">
        {editing ? (
          <div>
            <textarea
              className="textarea"
              rows={Math.min(draft.split('\n').length + 2, 20)}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoFocus
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn btn--primary" onClick={() => void saveEdit()} type="button">
                Save
              </button>
              <button className="btn" onClick={() => setEditing(false)} type="button">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <Markdown content={message.content} codeTheme={ui.codeTheme} />
            {streaming && !message.content && <span className="caret" />}
          </>
        )}
      </div>

      {message.toolCalls?.length ? (
        <div className="row row--wrap" style={{ marginTop: 8 }}>
          {message.toolCalls.map((call) => (
            <span key={call.id} className="chip chip--accent" title={call.arguments}>
              calling {call.name}
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

      {message.usage && (
        <div className="message__footer">
          <span className="chip" title="Prompt tokens sent">
            ↑ {formatTokens(message.usage.promptTokens)}
          </span>
          <span className="chip" title="Completion tokens received">
            ↓ {formatTokens(message.usage.completionTokens)}
          </span>
          {message.usage.reasoningTokens > 0 && (
            <span className="chip" title="Reasoning tokens">
              ◇ {formatTokens(message.usage.reasoningTokens)}
            </span>
          )}
          {message.usage.cachedTokens > 0 && (
            <span className="chip" title="Prompt tokens served from cache">
              ⚡ {formatTokens(message.usage.cachedTokens)} cached
            </span>
          )}
          <span className="chip chip--accent" title="Cost of this message">
            {formatCost(message.usage.costUsd)}
          </span>
          {message.usage.tokensPerSecond && (
            <span className="chip" title="Generation speed">
              {message.usage.tokensPerSecond.toFixed(1)} tok/s
            </span>
          )}
          {message.usage.timeToFirstTokenMs != null && (
            <span className="chip" title="Time to first token">
              ttft {formatDuration(message.usage.timeToFirstTokenMs)}
            </span>
          )}
        </div>
      )}

      {isLast && streaming && message.content && <span className="caret" />}
    </div>
  )
}
