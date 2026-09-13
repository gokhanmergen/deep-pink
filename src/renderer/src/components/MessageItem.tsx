import { memo, useEffect, useRef, useState } from 'react'
import { Copy, Pencil } from 'lucide-react'
import { ICON } from '../icons'
import type { Attachment, Message, UiSettings } from '@shared/types'
import { Markdown } from './Markdown'
import { TextAttachment } from './TextAttachment'
import { useStore } from '../store'

/**
 * A message the user wrote, or a compaction summary. Assistant replies and the
 * tool work that goes with them are rendered together by AssistantTurn.
 *
 * Memoised, and every store read below is of a value rather than of the store.
 * A transcript is hundreds of these; a row that woke up because some other row
 * was highlighted, or because a reply three screens down grew by a word, is a
 * row re-rendering for no reason — multiplied by however long the conversation
 * is, which is exactly when it matters.
 */
export const MessageItem = memo(function MessageItem({
  message,
  ui
}: {
  message: Message
  ui: UiSettings
}): React.JSX.Element | null {
  const showToast = useStore((s) => s.showToast)
  const setHighlight = useStore((s) => s.setHighlight)
  const openImageViewer = useStore((s) => s.openImageViewer)
  // The answer, not the id: only the row that is or was highlighted re-renders.
  const highlighted = useStore((s) => s.highlightMessageId === message.id)

  /**
   * The pictures the viewer opens on, in the order they were said.
   *
   * What is on screen, which since the transcript arrives a page at a time is
   * no longer all of them — the viewer widens the list to the whole thread
   * itself, once it is open. Read at the moment of the click rather than
   * subscribed to: a row that re-rendered on each new picture would be a row
   * re-rendering on each new picture.
   */
  const imagesOnScreen = (): Attachment[] =>
    useStore
      .getState()
      .messages.flatMap((entry) => entry.attachments.filter((file) => file.kind === 'image'))

  // The answer again, not the id: a row does not wake up because some other
  // row is being edited.
  const editing = useStore((s) => s.editingMessageId === message.id)
  const editMessage = useStore((s) => s.editMessage)
  const [draft, setDraft] = useState(message.content)
  const ref = useRef<HTMLDivElement>(null)

  /*
   * Seeded when the editor opens rather than when the button is pressed.
   *
   * The button is no longer the only way in — the shortcut for the last
   * message you sent opens this same editor, and it has no button to hang a
   * `setDraft` off. Both now do the one thing they have in common, which is
   * naming the message, and the row takes care of the rest.
   *
   * `block: 'nearest'` scrolls it into view only if it is not already there,
   * so opening the editor on a message you were looking at does not move the
   * page under you.
   */
  useEffect(() => {
    if (!editing) return
    setDraft(message.content)
    ref.current?.scrollIntoView({ block: 'nearest' })
    // On opening alone. `message.content` is deliberately not a dependency:
    // re-seeding when it changed would throw away what is being typed the
    // moment anything else refreshed the transcript.
  }, [editing])

  useEffect(() => {
    if (!highlighted) return
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = setTimeout(() => setHighlight(null), 2000)
    return () => clearTimeout(timer)
  }, [highlighted, setHighlight])

  if (message.role === 'system') {
    if (!message.isCompactionSummary) return null
    return (
      <div
        className="message"
        data-role="system"
        data-density={ui.messageDensity}
        data-message-id={message.id}
        ref={ref}
      >
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
    editMessage(null)
    // Re-reads the loaded range in place rather than reopening the thread,
    // which would throw away everything scrolled back to.
    await useStore.getState().refreshTranscript()
  }

  return (
    <div
      className="message"
      data-role={message.role}
      data-density={ui.messageDensity}
      // What the transcript holds onto while a page is read in above it.
      data-message-id={message.id}
      ref={ref}
      style={highlighted ? { outline: '1px solid var(--accent-line)', borderRadius: 8 } : undefined}
    >
      {/*
        * No "YOU" over it.
        *
        * A label earns its place when the thing under it would be ambiguous
        * without one, and this one never is: the reader wrote it, it is the
        * only thing on the page sitting on a raised surface, and it carries
        * the accent down its leading edge. Three ways of saying whose words
        * these are, and the word itself was the one that took a line of the
        * page to say it.
        */}
      <div className="message__head">
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
            <Copy {...ICON} />
            Copy
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => editMessage(message.id)}
            title="Edit"
            type="button"
          >
            <Pencil {...ICON} />
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
                // Opens in the app's own viewer, where it can be zoomed, saved
                // and stepped through — handing it to the desktop's image
                // program is still offered, from in there.
                event.preventDefault()
                openImageViewer(imagesOnScreen(), image.id)
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
              onKeyDown={(event) => {
                // A way out that does not need the mouse, now that there is a
                // way in that does not either.
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  editMessage(null)
                }
              }}
              autoFocus
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn btn--primary" onClick={() => void saveEdit()} type="button">
                Save
              </button>
              <button className="btn" onClick={() => editMessage(null)} type="button">
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
})
