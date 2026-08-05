import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { dateBucket, formatDateTime, formatRelativeShort } from '../format'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { formatBinding } from '../keybinds'
import type { SearchHit, Thread, ThreadSort } from '@shared/types'

/** The three ways the list can be ordered, in the order they are shown. */
const VIEWS: { id: ThreadSort; label: string; action: string; hint: string }[] = [
  { id: 'edited', label: 'Edited', action: 'view.sortEdited', hint: 'Most recently edited first' },
  { id: 'created', label: 'Created', action: 'view.sortCreated', hint: 'Newest thread first' },
  { id: 'tags', label: 'Tags', action: 'view.sortTags', hint: 'A folder per tag' }
]

/** Stands for the folder of threads that have no tags; no tag can be empty. */
const UNTAGGED = ''

/**
 * A folder, for the tag view.
 *
 * It opens and closes rather than sitting beside a caret, so the icon is the
 * whole of the state and the tag name can start at the left edge of the row.
 * Drawn as an outline, and coloured by inheritance, so hover and the open
 * state carry it along with the rest of the row.
 */
function FolderIcon({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg
      className="folder__icon"
      viewBox="0 0 16 16"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {open ? (
        <>
          <path d="M2.1 12.4V4.8c0-.7.6-1.3 1.3-1.3H6c.4 0 .8.2 1 .5l.8 1h4.4c.7 0 1.3.6 1.3 1.3v1.1" />
          <path d="M2.5 13.3l1.7-4.5c.2-.5.6-.8 1.1-.8h8.3c.5 0 .8.4.6.9l-1.5 3.9c-.2.4-.6.7-1.1.7H2.5Z" />
        </>
      ) : (
        <path d="M2.2 11.9V4.9c0-.7.6-1.3 1.3-1.3h2.6c.4 0 .8.2 1 .5l.8 1h4.4c.7 0 1.3.6 1.3 1.3v5.5c0 .7-.6 1.3-1.3 1.3H3.5c-.7 0-1.3-.6-1.3-1.3Z" />
      )}
    </svg>
  )
}

/**
 * One thread in the list.
 *
 * Memoised deliberately: selecting a thread changes `activeThreadId`, which
 * re-renders the sidebar, and without this every row in the list would be
 * rebuilt to change the highlight on two of them. With a few hundred threads —
 * each now carrying tag chips and two timestamps — that was the whole of the
 * delay in switching threads.
 */
const ThreadRow = memo(function ThreadRow({
  thread,
  active,
  showTags,
  showPin,
  createdFirst,
  onSelect,
  onMenu
}: {
  thread: Thread
  active: boolean
  showTags: boolean
  /** Thread pins order two of the views; the tag view has its own pins. */
  showPin: boolean
  /** Lead with the timestamp the list is ordered by. */
  createdFirst: boolean
  onSelect: (id: string) => void
  onMenu: (event: React.MouseEvent, thread: Thread) => void
}): React.JSX.Element {
  return (
    <button
      className="thread-item"
      data-active={active}
      onClick={() => onSelect(thread.id)}
      onContextMenu={(event) => onMenu(event, thread)}
      title={thread.title || 'Untitled thread'}
      type="button"
    >
      {showPin && thread.pinned && <span className="thread-item__pin">●</span>}
      <span className="thread-item__body">
        <span className="thread-item__title">{thread.title || 'Untitled thread'}</span>
        {showTags && thread.tags.length > 0 && (
          <span className="thread-item__tags">
            {thread.tags.map((tag) => (
              <span className="tagchip tagchip--static" key={tag}>
                #{tag}
              </span>
            ))}
          </span>
        )}
      </span>
      {/* Both times, with whichever one the list is ordered by leading — so the
          numbers read down the column in the order the rows are in, and the
          other is there without a second trip. */}
      <span
        className="thread-item__meta"
        title={`Edited ${formatDateTime(thread.updatedAt)}\nCreated ${formatDateTime(thread.createdAt)}`}
      >
        {formatRelativeShort(createdFirst ? thread.createdAt : thread.updatedAt)}
        <span className="thread-item__meta-alt">
          {formatRelativeShort(createdFirst ? thread.updatedAt : thread.createdAt)}
        </span>
      </span>
    </button>
  )
})

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
  const askConfirm = useStore((s) => s.askConfirm)
  const askPrompt = useStore((s) => s.askPrompt)
  const addTag = useStore((s) => s.addTag)
  const retagThread = useStore((s) => s.retagThread)
  const taggingThreadId = useStore((s) => s.taggingThreadId)
  const settings = useStore((s) => s.settings)
  const allTags = useStore((s) => s.allTags)
  const expandedTags = useStore((s) => s.expandedTags)
  const toggleTagFolder = useStore((s) => s.toggleTagFolder)
  const setTagFlags = useStore((s) => s.setTagFlags)
  const setThreadSort = useStore((s) => s.setThreadSort)

  const [menu, setMenu] = useState<{ x: number; y: number; thread: Thread } | null>(null)
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; name: string } | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  // Search runs on every keystroke against the local SQLite index, so there is
  // nothing to debounce for the network's sake — a short delay only smooths out
  // re-renders while typing fast.
  useEffect(() => {
    const timer = setTimeout(() => void runSearch(filter), 40)
    return () => clearTimeout(timer)
  }, [filter, runSearch])

  const view = settings?.ui.threadSort ?? 'edited'
  const showTags = settings?.ui.showTagsInSidebar ?? true

  // Date grouping reads whichever timestamp the view is about, so the "Today"
  // heading means today's edits in one view and today's new threads in the other.
  const grouped = useMemo(() => {
    const stamp = (thread: Thread): number =>
      view === 'created' ? thread.createdAt : thread.updatedAt

    const ordered = [...threads].sort((a, b) => stamp(b) - stamp(a))
    const pinned = ordered.filter((t) => t.pinned)
    const rest = ordered.filter((t) => !t.pinned)

    const buckets = new Map<string, Thread[]>()
    for (const thread of rest) {
      const key = dateBucket(stamp(thread))
      const list = buckets.get(key) ?? []
      list.push(thread)
      buckets.set(key, list)
    }
    return { pinned, buckets }
  }, [threads, view])

  /**
   * The tag view: one folder per tag, plus a home for threads that have none.
   *
   * A thread with three tags appears in three folders — that is what tags are
   * for, and pretending otherwise would hide conversations from folders they
   * genuinely belong in. Folders are ordered by how much is in them, so the
   * subjects you actually work on lead, with names breaking ties. A pinned
   * *folder* comes first regardless, and is unrelated to a pinned thread: the
   * two views have separate ideas of what matters, so they keep separate pins.
   */
  const folders = useMemo(() => {
    const byTag = new Map<string, Thread[]>()
    const untagged: Thread[] = []
    const byEdited = [...threads].sort((a, b) => b.updatedAt - a.updatedAt)

    for (const thread of byEdited) {
      if (!thread.tags.length) {
        untagged.push(thread)
        continue
      }
      for (const tag of thread.tags) {
        const list = byTag.get(tag) ?? []
        list.push(thread)
        byTag.set(tag, list)
      }
    }

    const pinnedTags = new Set(allTags.filter((t) => t.pinned).map((t) => t.name))
    const named = [...byTag.entries()]
      .map(([name, list]) => ({ name, threads: list, pinned: pinnedTags.has(name) }))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.threads.length - a.threads.length || a.name.localeCompare(b.name)
      })

    return { named, untagged }
  }, [threads, allTags])

  const hitsByThread = useMemo(() => {
    const map = new Map<string, SearchHit>()
    for (const hit of hits) {
      if (!map.has(hit.threadId)) map.set(hit.threadId, hit)
    }
    return [...map.values()]
  }, [hits])

  // Store actions never change identity, so these are stable for the life of
  // the sidebar — which is what lets the rows below skip re-rendering.
  const onSelectThread = useCallback((id: string) => void selectThread(id), [selectThread])
  const onThreadMenu = useCallback((event: React.MouseEvent, thread: Thread) => {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, thread })
  }, [])

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
      id: 'tag',
      label: 'Add a tag…',
      hint: formatBinding(settings?.keybinds['tags.add'] ?? 'mod+shift+k'),
      onSelect: () => {
        void (async () => {
          const name = await askPrompt({
            title: `Tag “${thread.title || 'Untitled thread'}”`,
            body: 'Tags are shared between threads and searchable from anywhere.',
            placeholder: 'Tag name',
            confirmLabel: 'Add tag'
          })
          if (name?.trim()) await addTag(thread.id, name)
        })()
      }
    },
    {
      id: 'retag',
      label: 'Re-tag with the model',
      hint: formatBinding(settings?.keybinds['tags.retag'] ?? 'mod+alt+k'),
      disabled: taggingThreadId !== null,
      onSelect: () => void retagThread(thread.id)
    },
    {
      id: 'delete',
      label: 'Delete',
      hint: formatBinding(settings?.keybinds['thread.delete'] ?? 'mod+shift+backspace'),
      danger: true,
      onSelect: () => {
        // Deleting takes the messages with it and cannot be undone, so ask —
        // naming the thread, since the menu may not be over the active one.
        void (async () => {
          const ok = await askConfirm({
            title: `Delete “${thread.title || 'Untitled thread'}”?`,
            body: 'Its messages go with it. This cannot be undone.',
            confirmLabel: 'Delete',
            danger: true
          })
          if (ok) void deleteThread(thread.id)
        })()
      }
    }
  ]

  const folderMenuItems = (name: string): ContextMenuItem[] => {
    const tag = allTags.find((t) => t.name === name)
    return [
      {
        id: 'pin',
        label: tag?.pinned ? 'Unpin this folder' : 'Pin this folder',
        onSelect: () => {
          void setTagFlags(name, { pinned: !tag?.pinned })
          showToast(tag?.pinned ? 'Folder unpinned' : 'Folder pinned to the top')
        }
      },
      {
        id: 'manual',
        label: tag?.manualOnly ? 'Let the model use this tag' : 'Keep the model off this tag',
        onSelect: () => {
          void setTagFlags(name, { manualOnly: !tag?.manualOnly })
          showToast(
            tag?.manualOnly
              ? `The model may use #${name} again`
              : `#${name} is yours to place from now on`
          )
        }
      },
      {
        id: 'search',
        label: 'Find every thread with this tag',
        onSelect: () => useStore.getState().openSearch(`tag:${name}`)
      }
    ]
  }

  const renderThread = (thread: Thread): React.JSX.Element => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      active={thread.id === activeThreadId}
      showTags={showTags}
      showPin={view !== 'tags'}
      createdFirst={view === 'created'}
      onSelect={onSelectThread}
      onMenu={onThreadMenu}
    />
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

      <div className="viewswitch" role="group" aria-label="Order the thread list">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            className="viewswitch__option"
            data-active={view === entry.id}
            onClick={() => setThreadSort(entry.id)}
            title={`${entry.hint} — ${formatBinding(settings?.keybinds[entry.action] ?? '')}`}
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="sidebar__search">
        <input
          ref={inputRef}
          className="input"
          placeholder="Search threads and tags…"
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
                    {hit.kind === 'tag' && (
                      <span className="cmditem__sub">
                        tagged <span dangerouslySetInnerHTML={{ __html: hit.snippet }} />
                      </span>
                    )}
                    {showTags && hit.tags.length > 0 && (
                      <span className="tagline">
                        {hit.tags.map((tag) => (
                          <span className="tagchip tagchip--static" key={tag}>
                            #{tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </>
          ) : (
            <div className="sidebar__group-label">No matches</div>
          )
        ) : view === 'tags' ? (
          <>
            {folders.named.map((folder) => {
              const open = expandedTags.includes(folder.name)
              return (
                <div key={folder.name}>
                  <button
                    className="folder"
                    data-open={open}
                    onClick={() => toggleTagFolder(folder.name)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setTagMenu({ x: event.clientX, y: event.clientY, name: folder.name })
                    }}
                    type="button"
                  >
                    <FolderIcon open={open} />
                    {folder.pinned && <span className="thread-item__pin">●</span>}
                    <span className="folder__name">#{folder.name}</span>
                    <span className="folder__count">{folder.threads.length}</span>
                  </button>
                  {open && (
                    <div className="folder__contents">{folder.threads.map(renderThread)}</div>
                  )}
                </div>
              )
            })}

            {folders.untagged.length > 0 && (
              <div>
                <button
                  className="folder"
                  data-open={expandedTags.includes(UNTAGGED)}
                  onClick={() => toggleTagFolder(UNTAGGED)}
                  type="button"
                >
                  <FolderIcon open={expandedTags.includes(UNTAGGED)} />
                  <span className="folder__name dim">No tags</span>
                  <span className="folder__count">{folders.untagged.length}</span>
                </button>
                {expandedTags.includes(UNTAGGED) && (
                  <div className="folder__contents">{folders.untagged.map(renderThread)}</div>
                )}
              </div>
            )}

            {threads.length === 0 && <div className="sidebar__group-label">No threads yet</div>}
          </>
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

      {tagMenu && (
        <ContextMenu
          x={tagMenu.x}
          y={tagMenu.y}
          items={folderMenuItems(tagMenu.name)}
          onClose={() => setTagMenu(null)}
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
