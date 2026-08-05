import { useEffect, useRef, useState } from 'react'
import type { SearchHit } from '@shared/types'
import { useStore } from '../store'
import { Overlay } from './Overlay'
import { formatRelative } from '../format'

/**
 * Full-text search over every message, straight out of the local FTS5 index.
 * There is no network round trip, so results land as fast as you type.
 */
export function SearchOverlay({ onClose }: { onClose: () => void }): React.JSX.Element {
  const selectThread = useStore((s) => s.selectThread)
  const setHighlight = useStore((s) => s.setHighlight)
  // Clicking a tag elsewhere opens this overlay with `tag:…` already typed.
  const seed = useStore((s) => s.searchSeed)

  const [query, setQuery] = useState(seed)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      void window.deepPink.search.query(query, 80).then((results) => {
        if (!cancelled) {
          setHits(results)
          setCursor(0)
        }
      })
    }, 30)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const open = async (hit: SearchHit | undefined): Promise<void> => {
    if (!hit) return
    onClose()
    await selectThread(hit.threadId)
    if (hit.messageId) setHighlight(hit.messageId)
  }

  return (
    <Overlay
      onClose={onClose}
      wide
      header={
        <div className="panel__head" style={{ padding: 0 }}>
          <input
            className="panel__search"
            placeholder="Search messages, names and tags…"
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((c) => Math.min(c + 1, hits.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                void open(hits[cursor])
              }
            }}
          />
        </div>
      }
      footer={
        <>
          <span>
            {query.trim()
              ? `${hits.length} result${hits.length === 1 ? '' : 's'}`
              : 'Searches names, tags and message bodies — try tag:rust'}
          </span>
          <div style={{ flex: 1 }} />
          <span className="kbd">↑↓</span>
          <span className="kbd">↵</span>
        </>
      }
    >
      <div className="cmdlist" ref={listRef} style={{ maxHeight: '58vh' }}>
        {query.trim() && hits.length === 0 && (
          <div className="empty" style={{ height: 140 }}>No matches</div>
        )}
        {hits.map((hit, index) => (
          <button
            key={`${hit.threadId}:${hit.messageId ?? 'title'}:${index}`}
            className="cmditem"
            data-active={index === cursor}
            onMouseEnter={() => setCursor(index)}
            onClick={() => void open(hit)}
            type="button"
          >
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className="cmditem__label" style={{ display: 'block' }}>
                {hit.threadTitle || 'Untitled thread'}
                {hit.role && (
                  <span className="chip" style={{ marginLeft: 8 }}>
                    {hit.role}
                  </span>
                )}
              </span>
              {hit.kind === 'tag' ? (
                <span className="cmditem__sub">
                  tagged <span dangerouslySetInnerHTML={{ __html: hit.snippet }} />
                </span>
              ) : (
                <span
                  className="cmditem__sub"
                  dangerouslySetInnerHTML={{ __html: hit.snippet }}
                />
              )}
              {hit.tags.length > 0 && (
                <span className="tagline">
                  {hit.tags.map((tag) => (
                    <span className="tagchip tagchip--static" key={tag}>
                      #{tag}
                    </span>
                  ))}
                </span>
              )}
            </span>
            <span className="cmditem__sub nowrap">{formatRelative(hit.createdAt)}</span>
          </button>
        ))}
      </div>
    </Overlay>
  )
}
