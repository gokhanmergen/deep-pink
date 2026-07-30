import { useEffect, useRef, useState } from 'react'
import type { Message, UiSettings } from '@shared/types'
import { Markdown } from './Markdown'
import { TextAttachment } from './TextAttachment'
import { useStore } from '../store'

/**
 * A message the user wrote, or a compaction summary. Assistant replies and the
 * tool work that goes with them are rendered together by AssistantTurn.
 */
export function MessageItem({
  message,
  ui
}: {
  message: Message
  ui: UiSettings
}): React.JSX.Element | null {
  const showToast = useStore((s) => s.showToast)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const highlightMessageId = useStore((s) => s.highlightMessageId)
  const setHighlight = useStore((s) => s.setHighlight)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const ref = useRef<HTMLDivElement>(null)

  const highlighted = highlightMessageId === message.id

  useEffect(() => {
    if (!highlighted) return
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = setTimeout(() => setHighlight(null), 2000)
    return () => clearTimeout(timer)
  }, [highlighted, setHighlight])

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

  const saveEdit = async (): Promise<void> => {
    await window.deepPink.messages.update(message.id, { content: draft })
    setEditing(false)
    if (activeThreadId) await useStore.getState().selectThread(activeThreadId)
  }

  return (
    <div
      className="message"
      data-role={message.role}
      data-density={ui.messageDensity}
      ref={ref}
      style={highlighted ? { outline: '1px solid var(--accent-line)', borderRadius: 8 } : undefined}
    >
      <div className="message__head">
        <span className="message__role">You</span>
        <div className="message__actions">
          <button
            className="btn btn--ghost"
            onClick={() => {
              void navigator.clipboard.writeText(message.content)
              showToast('Copied to clipboard')
            }}
            title="Copy"
            type="button"
          >
            Copy
          </button>
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
        </div>
      </div>

      {message.attachments.some((a) => a.kind === 'text') && (
        <div className="textfiles">
          {message.attachments
            .filter((a) => a.kind === 'text')
            .map((file) => (
              <TextAttachment key={file.id} attachment={file} />
            ))}
        </div>
      )}

      {message.attachments.some((a) => a.kind === 'image') && (
        <div className="attachments">
          {message.attachments
            .filter((a) => a.kind === 'image')
            .map((image) => (
            <a
              key={image.id}
              className="attachment"
              href={image.url}
              onClick={(event) => {
                // Open at full size in the default image viewer rather than
                // navigating the app away from the conversation.
                event.preventDefault()
                void window.deepPink.attachments.open(image.id)
              }}
              title={`${image.filename} — ${Math.round(image.bytes / 1024)} KB`}
            >
              <img
                src={image.url}
                alt={image.filename}
                width={image.width ?? undefined}
                height={image.height ?? undefined}
                loading="lazy"
              />
            </a>
            ))}
        </div>
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
          <Markdown content={message.content} codeTheme={ui.codeTheme} />
        )}
      </div>
    </div>
  )
}
