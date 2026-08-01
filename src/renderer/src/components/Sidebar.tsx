import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { dateBucket, formatRelative } from '../format'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { formatBinding } from '../keybinds'
import type { SearchHit, Thread } from '@shared/types'

/** Renders an FTS snippet, which contains <mark> around the matched terms. */
function Snippet({ html }: { html: string }): React.JSX.Element {
  return <span className="cmditem__sub" dangerouslySetInnerHTML={{ __html: html }} />
}

export function Sidebar(): React.JSX.Element {
  const threads = useStore((s) => s.threads)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const filter = useStore((s) => s.sidebarFilter)
  const hits = useStore((s) => s.searchHits)
  const selectThread = useStore((s) => s.selectThread)
  const createThread = useStore((s) => s.createThread)
  const setSidebarFilter = useStore((s) => s.setSidebarFilter)
  const runSearch = useStore((s) => s.runSearch)
  const setOverlay = useStore((s) => s.setOverlay)
  const setHighlight = useStore((s) => s.setHighlight)
  const updateThread = useStore((s) => s.updateThread)
  const deleteThread = useStore((s) => s.deleteThread)
  const showToast = useStore((s) => s.showToast)
  const settings = useStore((s) => s.settings)

  const [menu, setMenu] = useState<{ x: number; y: number; thread: Thread } | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  // Search runs on every keystroke against the local SQLite index, so there is
  // nothing to debounce for the network's sake — a short delay only smooths out
  // re-renders while typing fast.
  useEffect(() => {
    const timer = setTimeout(() => void runSearch(filter), 40)
    return () => clearTimeout(timer)
  }, [filter, runSearch])

  const grouped = useMemo(() => {
    const pinned = threads.filter((t) => t.pinned)
    const rest = threads.filter((t) => !t.pinned)
    const buckets = new Map<string, Thread[]>()
    for (const thread of rest) {
      const key = dateBucket(thread.updatedAt)
      const list = buckets.get(key) ?? []
      list.push(thread)
      buckets.set(key, list)
    }
    return { pinned, buckets }
  }, [threads])

  const hitsByThread = useMemo(() => {
    const map = new Map<string, SearchHit>()
    for (const hit of hits) {
      if (!map.has(hit.threadId)) map.set(hit.threadId, hit)
    }
    return [...map.values()]
  }, [hits])

  const openHit = async (hit: SearchHit): Promise<void> => {
    await selectThread(hit.threadId)
    if (hit.messageId) setHighlight(hit.messageId)
  }

  const menuItems = (thread: Thread): ContextMenuItem[] => [
    {
      id: 'pin',
      label: thread.pinned ? 'Unpin' : 'Pin',
      hint: formatBinding(settings?.keybinds['thread.pin'] ?? 'mod+shift+p'),
      onSelect: () => {
        void updateThread(thread.id, { pinned: !thread.pinned })
        showToast(thread.pinned ? 'Unpinned' : 'Pinned to the top')
      }
    },
    {
      id: 'delete',
      label: 'Delete',
      hint: formatBinding(settings?.keybinds['thread.delete'] ?? 'mod+shift+backspace'),
      danger: true,
      onSelect: () => {
        const name = thread.title || 'this untitled thread'
        // Deleting takes the messages with it and cannot be undone, so ask —
        // naming the thread, since the menu may not be over the active one.
        if (!window.confirm(`Delete “${name}” and all of its messages?`)) return
        void deleteThread(thread.id)
      }
    }
  ]

  const renderThread = (thread: Thread): React.JSX.Element => (
    <button
      key={thread.id}
      className="thread-item"
      data-active={thread.id === activeThreadId}
      onClick={() => void selectThread(thread.id)}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY, thread })
      }}
      title={thread.title || 'Untitled thread'}
      type="button"
    >
      {thread.pinned && <span className="thread-item__pin">●</span>}
      <span className="thread-item__title">{thread.title || 'Untitled thread'}</span>
      <span className="thread-item__meta">{formatRelative(thread.updatedAt)}</span>
    </button>
  )

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__brand-mark" />
        <span className="sidebar__brand-name">Deep Pink</span>
      </div>

      <div className="sidebar__actions">
        <button
          className="btn btn--primary"
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={() => void createThread()}
          type="button"
        >
          New thread
        </button>
        <button
          className="btn"
          onClick={() => setOverlay('palette')}
          title="Command palette"
          type="button"
        >
          ⌘K
        </button>
      </div>

      <div className="sidebar__search">
        <input
          ref={inputRef}
          className="input"
          placeholder="Search threads…"
          value={filter}
          onChange={(event) => setSidebarFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setSidebarFilter('')
              inputRef.current?.blur()
            }
          }}
        />
      </div>

      <div className="sidebar__list">
        {filter.trim() ? (
          hitsByThread.length ? (
            <>
              <div className="sidebar__group-label">
                {hitsByThread.length} match{hitsByThread.length === 1 ? '' : 'es'}
              </div>
              {hitsByThread.map((hit) => (
                <button
                  key={`${hit.threadId}:${hit.messageId ?? 'title'}`}
                  className="cmditem"
                  data-active={hit.threadId === activeThreadId}
                  onClick={() => void openHit(hit)}
                  type="button"
                >
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="cmditem__label" style={{ display: 'block' }}>
                      {hit.threadTitle || 'Untitled thread'}
                    </span>
                    {hit.messageId && <Snippet html={hit.snippet} />}
                  </span>
                </button>
              ))}
            </>
          ) : (
            <div className="sidebar__group-label">No matches</div>
          )
        ) : (
          <>
            {grouped.pinned.length > 0 && (
              <>
                <div className="sidebar__group-label">Pinned</div>
                {grouped.pinned.map(renderThread)}
              </>
            )}
            {[...grouped.buckets.entries()].map(([label, list]) => (
              <div key={label}>
                <div className="sidebar__group-label">{label}</div>
                {list.map(renderThread)}
              </div>
            ))}
            {threads.length === 0 && (
              <div className="sidebar__group-label">No threads yet</div>
            )}
          </>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.thread)}
          onClose={() => setMenu(null)}
        />
      )}

      <div className="sidebar__footer">
        <button
          className="btn btn--ghost"
          onClick={() => setOverlay('globalStats')}
          title="Global statistics"
          type="button"
        >
          Stats
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => setOverlay('mcp')}
          title="MCP servers"
          type="button"
        >
          MCP
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => setOverlay('settings')}
          title="Settings"
          type="button"
        >
          Settings
        </button>
      </div>
    </aside>
  )
}
