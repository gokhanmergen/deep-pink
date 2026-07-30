import { useState } from 'react'
import type { Attachment } from '@shared/types'

/**
 * A text attachment in the transcript.
 *
 * The preview stored on the row is enough to render the collapsed chip; the full
 * body is fetched only if the reader opens it, so a thread carrying a few
 * thousand lines of pasted code stays cheap to display.
 */
export function TextAttachment({ attachment }: { attachment: Attachment }): React.JSX.Element {
  const [body, setBody] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async (): Promise<void> => {
    if (body !== null || loading) return
    setLoading(true)
    setBody((await window.deepPink.attachments.text(attachment.id)) ?? '(could not read it)')
    setLoading(false)
  }

  const lines = attachment.preview ? attachment.preview.split('\n').length : 0

  return (
    <details
      className="disclosure textfile"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) void load()
      }}
    >
      <summary className="disclosure__summary">
        <span className="chip">text</span>
        <strong>{attachment.filename}</strong>
        <span className="dim">
          {Math.round(attachment.bytes / 1024) || 1} KB · ~
          {Math.ceil(attachment.bytes / 4).toLocaleString()} tokens
        </span>
      </summary>
      <div className="disclosure__content">
        <pre>
          {body ?? attachment.preview ?? ''}
          {body === null && attachment.preview && lines > 0 ? '\n…' : ''}
        </pre>
        {loading && <span className="dim">Loading…</span>}
      </div>
    </details>
  )
}
