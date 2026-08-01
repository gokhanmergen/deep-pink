import { useCallback, useEffect, useState } from 'react'
import type { PromptPreview, SystemPromptSegment } from '@shared/types'
import { useStore } from '../store'
import { Overlay } from './Overlay'
import { formatTokens } from '../format'

const SOURCE_LABEL: Record<SystemPromptSegment['source'], string> = {
  base: 'Settings',
  thread: 'This thread',
  'mcp-instructions': 'MCP server',
  'mcp-resource': 'MCP resource',
  tools: 'Tool schemas',
  web: 'Built-in',
  repo: 'Attached repository',
  compaction: 'Compaction',
  datetime: 'Built-in'
}

/**
 * Shows exactly what will be sent as context, segment by segment, and lets the
 * user switch any of it off — including instructions an MCP server supplied.
 */
export function SystemPromptInspector({ onClose }: { onClose: () => void }): React.JSX.Element {
  const activeThreadId = useStore((s) => s.activeThreadId)
  const threads = useStore((s) => s.threads)
  const updateThread = useStore((s) => s.updateThread)
  const showToast = useStore((s) => s.showToast)

  const [preview, setPreview] = useState<PromptPreview | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [threadPrompt, setThreadPrompt] = useState('')

  const thread = threads.find((t) => t.id === activeThreadId) ?? null

  const load = useCallback(async () => {
    if (!activeThreadId) return
    setPreview(await window.deepPink.prompt.preview(activeThreadId))
  }, [activeThreadId])

  useEffect(() => {
    void load()
  }, [load, thread?.config.disabledPromptSegments.length, thread?.config.systemPrompt])

  useEffect(() => {
    setThreadPrompt(thread?.config.systemPrompt ?? '')
  }, [thread?.id, thread?.config.systemPrompt])

  const toggle = async (segment: SystemPromptSegment): Promise<void> => {
    if (!thread) return
    const disabled = new Set(thread.config.disabledPromptSegments)
    if (disabled.has(segment.id)) disabled.delete(segment.id)
    else disabled.add(segment.id)
    await updateThread(thread.id, { config: { disabledPromptSegments: [...disabled] } })
    await load()
  }

  const saveThreadPrompt = async (): Promise<void> => {
    if (!thread) return
    await updateThread(thread.id, { config: { systemPrompt: threadPrompt.trim() || null } })
    await load()
    showToast('Thread system prompt saved')
  }

  const enabled = preview?.segments.filter((s) => s.enabled) ?? []

  return (
    <Overlay
      title="System prompt"
      onClose={onClose}
      wide
      footer={
        <>
          <span>
            {enabled.length} of {preview?.segments.length ?? 0} segments ·{' '}
            {formatTokens(preview?.estimatedTokens ?? 0)} estimated tokens
            {preview?.toolCount ? ` · ${preview.toolCount} tools` : ''}
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => setShowRaw((v) => !v)} type="button">
            {showRaw ? 'Show segments' : 'Show what is sent'}
          </button>
        </>
      }
    >
      <div className="panel__body">
        {!thread && <p className="dim">Open a thread to inspect its context.</p>}

        {thread && showRaw && (
          <>
            <div className="section-title">Exact system message</div>
            <div className="codeblock">
              <pre style={{ whiteSpace: 'pre-wrap' }}>
                <code>{preview?.systemText || '(no system message will be sent)'}</code>
              </pre>
            </div>
          </>
        )}

        {thread && !showRaw && (
          <>
            <p className="field__hint" style={{ marginBottom: 14 }}>
              Everything below goes into this thread's context. Switch any of it off and it stops
              being sent — that includes text supplied by MCP servers.
            </p>

            {preview?.segments.map((segment) => (
              <div className="list-card" key={segment.id}>
                <div className="spread" style={{ marginBottom: 8 }}>
                  <div className="row row--wrap" style={{ minWidth: 0 }}>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={segment.enabled}
                        onChange={() => void toggle(segment)}
                      />
                    </label>
                    <strong>{segment.label}</strong>
                    <span className="chip">{SOURCE_LABEL[segment.source]}</span>
                    {segment.source === 'mcp-instructions' && (
                      <span className="chip chip--accent">injected</span>
                    )}
                  </div>
                  <span className="chip nowrap">~{formatTokens(segment.tokens)} tok</span>
                </div>

                {segment.origin && (
                  <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
                    {segment.origin}
                  </div>
                )}

                <details className="disclosure" style={{ margin: 0 }}>
                  <summary className="disclosure__summary">
                    {segment.text.length > 220 ? 'Show full text' : 'Show text'}
                  </summary>
                  <div className="disclosure__content">
                    <pre>{segment.text}</pre>
                  </div>
                </details>
              </div>
            ))}

            <div className="section-title">Thread system prompt</div>
            <div className="field">
              <textarea
                className="textarea"
                rows={5}
                placeholder="Extra instructions that apply only to this thread…"
                value={threadPrompt}
                onChange={(event) => setThreadPrompt(event.target.value)}
              />
              <div className="row">
                <button className="btn btn--primary" onClick={() => void saveThreadPrompt()} type="button">
                  Save
                </button>
                <span className="field__hint">
                  The base prompt for every thread lives in Settings › Prompts.
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </Overlay>
  )
}
