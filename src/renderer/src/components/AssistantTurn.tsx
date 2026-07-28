import { useEffect, useRef } from 'react'
import type { Message, UiSettings, Usage } from '@shared/types'
import { Markdown } from './Markdown'
import { useStore } from '../store'
import { isEmptyAssistantMessage } from '../turns'
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
    tokensPerSecond: parts[parts.length - 1].tokensPerSecond,
    generationId: parts[0].generationId
  }
}

function ToolStep({ message }: { message: Message }): React.JSX.Element {
  const result = message.toolResult
  return (
    <details className="disclosure tool-step">
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
  )
}

interface Props {
  messages: Message[]
  ui: UiSettings
  isLast: boolean
}

export function AssistantTurn({ messages, ui, isLast }: Props): React.JSX.Element {
  const regenerate = useStore((s) => s.regenerate)
  const showToast = useStore((s) => s.showToast)
  const setOverlay = useStore((s) => s.setOverlay)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const highlightMessageId = useStore((s) => s.highlightMessageId)
  const setHighlight = useStore((s) => s.setHighlight)

  const ref = useRef<HTMLDivElement>(null)
  const highlighted = messages.some((m) => m.id === highlightMessageId)

  useEffect(() => {
    if (!highlighted) return
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = setTimeout(() => setHighlight(null), 2000)
    return () => clearTimeout(timer)
  }, [highlighted, setHighlight])

  const first = messages[0]
  const attributed = messages.find((m) => m.model) ?? first
  const usage = sumUsage(messages)
  const streaming = messages.some((m) => m.status === 'streaming')
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

  return (
    <div
      className="message"
      data-role="assistant"
      data-density={ui.messageDensity}
      ref={ref}
      style={highlighted ? { outline: '1px solid var(--accent-line)', borderRadius: 8 } : undefined}
    >
      <div className="message__head">
        <span className="message__role">Assistant</span>
        {attributed.model && (
          <span className="chip" title={attributed.model}>
            {modelShortName(attributed.model)}
          </span>
        )}
        {attributed.provider && <span className="chip">{attributed.provider}</span>}
        {toolCount > 0 && (
          <span className="chip" title="Tool calls made while answering">
            {toolCount} tool {toolCount === 1 ? 'call' : 'calls'}
          </span>
        )}

        <div className="message__actions">
          <button className="btn btn--ghost" onClick={copy} title="Copy" type="button">
            Copy
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => void regenerate(first.id)}
            title="Regenerate"
            type="button"
          >
            Retry
          </button>
          <button className="btn btn--ghost" onClick={() => void branch()} title="Branch" type="button">
            Branch
          </button>
          {attributed.systemPromptSnapshot && (
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

      {messages.map((message) => {
        if (message.role === 'tool') return <ToolStep key={message.id} message={message} />
        if (isEmptyAssistantMessage(message)) return null

        return (
          <div key={message.id} className="turn-part">
            {message.reasoning && (
              <details className="disclosure" open={ui.showReasoningByDefault}>
                <summary className="disclosure__summary">
                  <span className="chip">reasoning</span>
                  <span className="dim">
                    {formatTokens(Math.ceil(message.reasoning.length / 4))} tokens
                  </span>
                </summary>
                <div className="disclosure__content">
                  <pre>{message.reasoning}</pre>
                </div>
              </details>
            )}

            {message.content && (
              <div className="message__body">
                <Markdown content={message.content} codeTheme={ui.codeTheme} />
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

      {usage && (
        <div className="message__footer">
          <span className="chip" title="Prompt tokens sent across this turn">
            ↑ {formatTokens(usage.promptTokens)}
          </span>
          <span className="chip" title="Completion tokens received">
            ↓ {formatTokens(usage.completionTokens)}
          </span>
          {usage.reasoningTokens > 0 && (
            <span className="chip" title="Reasoning tokens">
              ◇ {formatTokens(usage.reasoningTokens)}
            </span>
          )}
          {usage.cachedTokens > 0 && (
            <span className="chip" title="Prompt tokens served from cache">
              ⚡ {formatTokens(usage.cachedTokens)} cached
            </span>
          )}
          <span className="chip chip--accent" title="Cost of this turn, including any tool rounds">
            {formatCost(usage.costUsd)}
          </span>
          {usage.tokensPerSecond && (
            <span className="chip" title="Generation speed">
              {usage.tokensPerSecond.toFixed(1)} tok/s
            </span>
          )}
          {usage.timeToFirstTokenMs != null && (
            <span className="chip" title="Time to first token">
              ttft {formatDuration(usage.timeToFirstTokenMs)}
            </span>
          )}
        </div>
      )}

      {isLast && streaming && text && <span className="caret" />}
    </div>
  )
}
