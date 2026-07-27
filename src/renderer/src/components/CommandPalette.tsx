import { useEffect, useMemo, useRef, useState } from 'react'
import { buildActions } from '../actions'
import { useStore } from '../store'
import { Overlay } from './Overlay'
import { formatBinding } from '../keybinds'

/** Subsequence match, so "npt" finds "New thread". */
function fuzzyScore(needle: string, haystack: string): number {
  if (!needle) return 1
  const target = haystack.toLowerCase()
  const query = needle.toLowerCase()

  if (target.includes(query)) return 100 - target.indexOf(query)

  let index = 0
  let score = 0
  for (const char of query) {
    const found = target.indexOf(char, index)
    if (found < 0) return 0
    score += found === index ? 2 : 1
    index = found + 1
  }
  return score
}

export function CommandPalette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const threads = useStore((s) => s.threads)
  const selectThread = useStore((s) => s.selectThread)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const actions = useMemo(() => buildActions().filter((a) => !a.hidden), [])

  const items = useMemo(() => {
    const commandHits = actions
      .map((action) => ({ kind: 'command' as const, action, score: fuzzyScore(query, action.label) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)

    const threadHits = query.trim()
      ? threads
          .map((thread) => ({
            kind: 'thread' as const,
            thread,
            score: fuzzyScore(query, thread.title || 'Untitled thread')
          }))
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8)
      : []

    return [...commandHits.slice(0, 30), ...threadHits]
  }, [actions, query, threads])

  useEffect(() => setCursor(0), [query])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const run = (index: number): void => {
    const item = items[index]
    if (!item) return
    onClose()
    if (item.kind === 'command') void item.action.run()
    else void selectThread(item.thread.id)
  }

  return (
    <Overlay
      onClose={onClose}
      header={
        <div className="panel__head" style={{ padding: 0 }}>
          <input
            className="panel__search"
            placeholder="Type a command or thread name…"
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((c) => Math.min(c + 1, items.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                run(cursor)
              }
            }}
          />
        </div>
      }
      footer={
        <>
          <span className="kbd">↑↓</span> to move
          <span className="kbd">↵</span> to run
          <span className="kbd">Esc</span> to close
        </>
      }
    >
      <div className="cmdlist" ref={listRef} style={{ maxHeight: '54vh' }}>
        {items.length === 0 && <div className="empty" style={{ height: 120 }}>Nothing matches</div>}
        {items.map((item, index) => (
          <button
            key={item.kind === 'command' ? item.action.id : `thread-${item.thread.id}`}
            className="cmditem"
            data-active={index === cursor}
            onMouseEnter={() => setCursor(index)}
            onClick={() => run(index)}
            type="button"
          >
            <span className="cmditem__label">
              {item.kind === 'command' ? item.action.label : item.thread.title || 'Untitled thread'}
            </span>
            {item.kind === 'command' ? (
              <>
                <span className="cmditem__sub">{item.action.group}</span>
                {settings?.keybinds[item.action.id] && (
                  <span className="kbd">{formatBinding(settings.keybinds[item.action.id])}</span>
                )}
              </>
            ) : (
              <span className="cmditem__sub">Thread</span>
            )}
          </button>
        ))}
      </div>
    </Overlay>
  )
}
