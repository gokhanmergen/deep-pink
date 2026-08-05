import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'

/**
 * The tags on the open thread, and the way to change them by hand.
 *
 * Tags are a property of the conversation rather than of any message, so they
 * sit with the thread's name in the chrome above the transcript. Whether a
 * model maintains them or not, this is always here: automatic tagging is an
 * assistant, not the only way in.
 */
export function TagBar(): React.JSX.Element | null {
  const threads = useStore((s) => s.threads)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const allTags = useStore((s) => s.allTags)
  const addTag = useStore((s) => s.addTag)
  const removeTag = useStore((s) => s.removeTag)
  const openSearch = useStore((s) => s.openSearch)
  const retagThread = useStore((s) => s.retagThread)
  const tagging = useStore((s) => s.taggingThreadId)

  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const thread = threads.find((t) => t.id === activeThreadId) ?? null

  useEffect(() => {
    setAdding(false)
    setDraft('')
  }, [activeThreadId])

  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  // Suggestions are what exists elsewhere but not here yet — the point of a tag
  // library is that the second thread about Rust reuses the first one's tag.
  const suggestions = useMemo(() => {
    const taken = new Set(thread?.tags ?? [])
    return allTags.filter((tag) => !taken.has(tag.name)).slice(0, 40)
  }, [allTags, thread])

  if (!thread) return null

  const commit = async (): Promise<void> => {
    const name = draft.trim()
    setDraft('')
    if (!name) {
      setAdding(false)
      return
    }
    await addTag(thread.id, name)
    inputRef.current?.focus()
  }

  return (
    <div className="tagbar">
      {thread.tags.map((tag) => (
        <span className="tagchip" key={tag}>
          <button
            className="tagchip__name"
            // Searching for the tag is what a tag is for, so clicking one does it.
            onClick={() => openSearch(`tag:${tag}`)}
            title={`Find every thread tagged ${tag}`}
            type="button"
          >
            #{tag}
          </button>
          <button
            className="tagchip__remove"
            onClick={() => void removeTag(thread.id, tag)}
            title={`Remove ${tag} from this thread`}
            aria-label={`Remove the tag ${tag}`}
            type="button"
          >
            ✕
          </button>
        </span>
      ))}

      {adding ? (
        <>
          <input
            ref={inputRef}
            className="tagbar__input"
            list="deep-pink-tag-suggestions"
            placeholder="Tag name"
            value={draft}
            maxLength={32}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              setAdding(false)
              setDraft('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void commit()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setAdding(false)
                setDraft('')
              }
            }}
          />
          <datalist id="deep-pink-tag-suggestions">
            {suggestions.map((tag) => (
              <option key={tag.name} value={tag.name}>
                {tag.threads} thread{tag.threads === 1 ? '' : 's'}
              </option>
            ))}
          </datalist>
        </>
      ) : (
        <button className="tagbar__add" onClick={() => setAdding(true)} type="button">
          + tag
        </button>
      )}

      <button
        className="tagbar__add"
        onClick={() => void retagThread(thread.id)}
        disabled={tagging !== null}
        title="Ask the tagging model to look at this thread now"
        type="button"
      >
        ↻
      </button>
    </div>
  )
}
