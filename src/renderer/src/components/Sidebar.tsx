import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { canBecomeTemporary, useStore } from '../store'
import { dateBucket, formatDateTime, formatRelativeShort, threadLabel } from '../format'
import {
  BarChart3,
  Blocks,
  Command,
  FileDown,
  FileJson,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  FolderPlus,
  FolderMinus,
  Ghost,
  Pencil,
  Pin,
  PinOff,
  Pause as PauseIcon,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Trash2
} from 'lucide-react'
import { ICON, ICON_LG } from '../icons'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Logo } from './Logo'
import { buildActions, exportThread } from '../actions'
import { formatBinding } from '../keybinds'
import type { Folder, SearchHit, Thread } from '@shared/types'

/** What a thread being dragged is carried as. */
const THREAD_MIME = 'application/x-deep-pink-thread'

/**
 * How many rows the list starts with, and how many it adds at a time.
 *
 * The first number only has to cover the tallest window anybody has; the
 * second only has to keep ahead of a scroll, and both are cheap enough that
 * being generous costs nothing.
 */
const FIRST_ROWS = 60
const MORE_ROWS = 60

/**
 * One thread in the list.
 *
 * Memoised deliberately: selecting a thread changes `activeThreadId`, which
 * re-renders the sidebar, and without this every row in the list would be
 * rebuilt to change the highlight on two of them. With a few hundred threads —
 * each carrying two timestamps — that was the whole of the delay in switching
 * threads.
 */
const ThreadRow = memo(function ThreadRow({
  thread,
  active,
  inFolder,
  onSelect,
  onMenu,
  onDragState
}: {
  thread: Thread
  active: boolean
  /** Indented, because it is inside an open folder. */
  inFolder: boolean
  onSelect: (id: string) => void
  onMenu: (event: React.MouseEvent, thread: Thread) => void
  onDragState: (threadId: string | null) => void
}): React.JSX.Element {
  return (
    <button
      className="thread-item"
      data-active={active}
      data-in-folder={inFolder}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(THREAD_MIME, thread.id)
        // Plain text as well, because some platforms drop the custom type when
        // the drag leaves and re-enters the window.
        event.dataTransfer.setData('text/plain', thread.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragState(thread.id)
      }}
      onDragEnd={() => onDragState(null)}
      data-temporary={thread.temporary}
      onClick={() => onSelect(thread.id)}
      onContextMenu={(event) => onMenu(event, thread)}
      title={
        thread.temporary
          ? 'Temporary chat — deleted when you leave it or close the app'
          : threadLabel(thread)
      }
      type="button"
    >
      <span className="thread-item__head">
        {thread.pinned && <Pin className="thread-item__pin" size={11} strokeWidth={2} />}
        {thread.temporary && <Ghost className="thread-item__ghost" size={12} strokeWidth={2} />}
        <span className="thread-item__title">{threadLabel(thread)}</span>
        {/* The time the list is ordered by, where the eye already is. */}
        <span
          className="thread-item__time"
          title={`Edited ${formatDateTime(thread.updatedAt)}\nCreated ${formatDateTime(thread.createdAt)}`}
        >
          {formatRelativeShort(thread.updatedAt)}
        </span>
      </span>

      {/* The second line is what the extra height bought: how long the
          conversation is, and the other timestamp — labelled, now that there
          is room for a word. */}
      <span className="thread-item__sub">
        <span className="nowrap">
          {thread.messageCount === 0
            ? 'empty'
            : `${thread.messageCount} message${thread.messageCount === 1 ? '' : 's'}`}
        </span>
        <span className="thread-item__sep">·</span>
        {/* The second half of the line is the age of an ordinary thread, and
            for a temporary one the only thing worth saying about it. */}
        <span className="nowrap">
          {thread.temporary ? 'not saved' : `created ${formatRelativeShort(thread.createdAt)}`}
        </span>
      </span>
    </button>
  )
})

/** Renders an FTS snippet, which contains <mark> around the matched terms. */
function Snippet({ html }: { html: string }): React.JSX.Element {
  return <span className="cmditem__sub" dangerouslySetInnerHTML={{ __html: html }} />
}

/** A folder and the threads it holds, as one row in the list. */
interface FolderEntry {
  kind: 'folder'
  folder: Folder
  threads: Thread[]
  /** When anything inside was last edited; the folder's own age when empty. */
  stamp: number
}

interface ThreadEntry {
  kind: 'thread'
  thread: Thread
  stamp: number
}

type Entry = FolderEntry | ThreadEntry

const isPinned = (entry: Entry): boolean =>
  entry.kind === 'folder' ? entry.folder.pinned : entry.thread.pinned

export function Sidebar(): React.JSX.Element {
  const threads = useStore((s) => s.threads)
  const folders = useStore((s) => s.folders)
  const openFolderIds = useStore((s) => s.openFolderIds)
  const draggingThreadId = useStore((s) => s.draggingThreadId)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const filter = useStore((s) => s.sidebarFilter)
  const hits = useStore((s) => s.searchHits)
  const selectThread = useStore((s) => s.selectThread)
  const createThread = useStore((s) => s.createThread)
  const setSidebarFilter = useStore((s) => s.setSidebarFilter)
  const runSearch = useStore((s) => s.runSearch)
  const setOverlay = useStore((s) => s.setOverlay)
  const revealMessage = useStore((s) => s.revealMessage)
  const updateThread = useStore((s) => s.updateThread)
  const deleteThread = useStore((s) => s.deleteThread)
  const keepThread = useStore((s) => s.keepThread)
  const makeThreadTemporary = useStore((s) => s.makeThreadTemporary)
  const showToast = useStore((s) => s.showToast)
  const askConfirm = useStore((s) => s.askConfirm)
  const askPrompt = useStore((s) => s.askPrompt)
  const retitleThread = useStore((s) => s.retitleThread)
  const settings = useStore((s) => s.settings)
  const sync = useStore((s) => s.sync)
  const syncProgress = useStore((s) => s.syncProgress)
  const setVisibleThreads = useStore((s) => s.setVisibleThreads)
  const toggleFolder = useStore((s) => s.toggleFolder)
  const renameFolder = useStore((s) => s.renameFolder)
  const deleteFolder = useStore((s) => s.deleteFolder)
  const setFolderPinned = useStore((s) => s.setFolderPinned)
  const moveThreadToFolder = useStore((s) => s.moveThreadToFolder)
  const setDraggingThread = useStore((s) => s.setDraggingThread)

  const [menu, setMenu] = useState<{ x: number; y: number; thread: Thread } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; folder: Folder } | null>(
    null
  )
  /** The folder the pointer is over mid-drag, or '' for the list itself. */
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  // Search runs on every keystroke against the local SQLite index, so there is
  // nothing to debounce for the network's sake — a short delay only smooths out
  // re-renders while typing fast.
  useEffect(() => {
    const timer = setTimeout(() => void runSearch(filter), 40)
    return () => clearTimeout(timer)
  }, [filter, runSearch])

  /**
   * Temporary chats are lifted out of the list and shown above it.
   *
   * They belong nowhere in an ordering by date: a chat that will not see
   * tomorrow does not want to be told apart from yesterday's, and one filed
   * under "Today" among thirty others is exactly the chat somebody clicks away
   * from without meaning to. There is normally one, and it sits at the top
   * under a heading that says what it is.
   */
  const temporaryThreads = useMemo(
    () => threads.filter((t) => t.temporary).sort((a, b) => b.createdAt - a.createdAt),
    [threads]
  )

  /**
   * The list, as folders and loose threads together.
   *
   * A folder takes the time of the newest thing inside it, so it rises through
   * the list as its contents are worked on and sinks as they are left alone —
   * which is the same rule the threads themselves follow, and the reason a
   * folder can sit under "Today" without anything special being said about it.
   */
  const entries = useMemo<Entry[]>(() => {
    const known = new Map(folders.map((folder) => [folder.id, folder]))
    const contents = new Map<string, Thread[]>()
    const loose: Thread[] = []

    for (const thread of [...threads]
      .filter((t) => !t.temporary)
      .sort((a, b) => b.updatedAt - a.updatedAt)) {
      // A thread whose folder has gone is loose, not lost.
      if (!thread.folderId || !known.has(thread.folderId)) {
        loose.push(thread)
        continue
      }
      const list = contents.get(thread.folderId) ?? []
      list.push(thread)
      contents.set(thread.folderId, list)
    }

    const all: Entry[] = folders.map((folder) => {
      const inside = contents.get(folder.id) ?? []
      return {
        kind: 'folder',
        folder,
        threads: inside,
        stamp: inside.length ? inside[0].updatedAt : folder.createdAt
      }
    })

    for (const thread of loose) all.push({ kind: 'thread', thread, stamp: thread.updatedAt })

    return all.sort((a, b) => b.stamp - a.stamp)
  }, [threads, folders])

  const grouped = useMemo(() => {
    const pinned = entries.filter(isPinned)
    const buckets = new Map<string, Entry[]>()

    for (const entry of entries.filter((e) => !isPinned(e))) {
      const key = dateBucket(entry.stamp)
      const list = buckets.get(key) ?? []
      list.push(entry)
      buckets.set(key, list)
    }
    return { pinned, buckets }
  }, [entries])

  /**
   * The list as the sections it is drawn in, in the order they are drawn.
   *
   * Collected in one place so there is a single answer to "what is row 200",
   * which is what lets the render below stop early without the three branches
   * it used to be spread across.
   */
  const sections = useMemo<{ label: string; entries: Entry[] }[]>(() => {
    const out: { label: string; entries: Entry[] }[] = []
    if (temporaryThreads.length) {
      out.push({
        label: 'Temporary — gone when you leave',
        entries: temporaryThreads.map((thread) => ({ kind: 'thread', thread, stamp: 0 }))
      })
    }
    if (grouped.pinned.length) out.push({ label: 'Pinned', entries: grouped.pinned })
    for (const [label, list] of grouped.buckets) out.push({ label, entries: list })
    return out
  }, [temporaryThreads, grouped])

  const totalEntries = useMemo(
    () => sections.reduce((n, section) => n + section.entries.length, 0),
    [sections]
  )

  /**
   * How much of the list is built at all.
   *
   * A library of several hundred conversations is several thousand DOM nodes,
   * and the sidebar builds them the moment it is shown — which is why showing
   * it again after hiding it took long enough to notice. Almost none of them
   * are on screen: the list is ordered by how recently a thread was touched,
   * so what anybody wants is at the top of it.
   *
   * So a screenful or two is built, and more is built as it is scrolled
   * towards. Nothing is thrown away once built — a sidebar that forgot rows
   * behind you would move the scrollbar under your hand for no reason, and the
   * rows that are already there cost nothing to leave alone.
   */
  /*
   * Unless the reader has asked for the whole list at once, in which case the
   * first block *is* the whole list and every mechanism below turns itself
   * off: `built` never falls short of the total, so nothing is ever cut and
   * nothing is ever built ahead.
   */
  const atOnce = settings?.ui.loadEverythingAtOnce ?? false
  const firstBlock = atOnce ? Number.POSITIVE_INFINITY : FIRST_ROWS

  const [built, setBuilt] = useState(firstBlock)
  const listRef = useRef<HTMLDivElement>(null)

  // Back to the top of the list for a different library, or a search that has
  // just been cleared: what was built for one is not what is wanted for another.
  useEffect(() => {
    setBuilt(firstBlock)
  }, [filter, firstBlock])

  /** Builds the next block of rows if the end of the list is nearly in view. */
  const buildAhead = useCallback((): void => {
    const el = listRef.current
    if (!el || atOnce) return
    // Measured in the event rather than on a frame, for the reason the
    // transcript's own scroll handler gives: a window that is not painting
    // does not run rAF, and this decides whether there is anything to show.
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (fromBottom > el.clientHeight * 1.5) return
    setBuilt((n) => n + MORE_ROWS)
  }, [])

  // Enough to scroll, whatever the window height and however short the rows.
  useEffect(() => {
    const el = listRef.current
    if (!el || atOnce || built >= totalEntries) return
    if (el.scrollHeight > el.clientHeight * 2) return
    setBuilt((n) => n + MORE_ROWS)
  }, [built, totalEntries, sections, atOnce])

  /** The sections again, cut off at what has been built. */
  const shownSections = useMemo(() => {
    let left = built
    const out: { label: string; entries: Entry[] }[] = []
    for (const section of sections) {
      if (left <= 0) break
      const entries = section.entries.length <= left ? section.entries : section.entries.slice(0, left)
      left -= entries.length
      out.push({ label: section.label, entries })
    }
    return out
  }, [sections, built])

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
  const onDragState = useCallback(
    (threadId: string | null) => {
      setDraggingThread(threadId)
      if (!threadId) setDropTarget(null)
    },
    [setDraggingThread]
  )

  /**
   * The threads on screen, in the order they are on screen.
   *
   * Alt+Up and Alt+Down walk this rather than the underlying list, so they
   * follow what you are actually looking at — the open folders, and the search
   * results — instead of the order the database happened to return.
   */
  const visibleThreadIds = useMemo(() => {
    if (filter.trim()) return hitsByThread.map((hit) => hit.threadId)

    const ids: string[] = temporaryThreads.map((thread) => thread.id)
    const walk = (entry: Entry): void => {
      if (entry.kind === 'thread') {
        ids.push(entry.thread.id)
        return
      }
      if (openFolderIds.includes(entry.folder.id)) {
        for (const thread of entry.threads) ids.push(thread.id)
      }
    }
    grouped.pinned.forEach(walk)
    for (const list of grouped.buckets.values()) list.forEach(walk)
    return ids
  }, [filter, hitsByThread, grouped, openFolderIds, temporaryThreads])

  useEffect(() => {
    setVisibleThreads(visibleThreadIds)
  }, [visibleThreadIds, setVisibleThreads])

  // Hidden sidebar, no visible order — the keys fall back to the thread list.
  useEffect(() => () => setVisibleThreads([]), [setVisibleThreads])

  const openHit = async (hit: SearchHit): Promise<void> => {
    // `revealMessage` rather than a select and a highlight: the message may be
    // further back than the transcript reads in on opening, and something has
    // to go and get it.
    if (hit.messageId) await revealMessage(hit.threadId, hit.messageId)
    else await selectThread(hit.threadId)
  }

  /** Reads the dragged thread out of a drop, whichever type survived. */
  const draggedThreadId = (event: React.DragEvent): string | null =>
    event.dataTransfer.getData(THREAD_MIME) ||
    event.dataTransfer.getData('text/plain') ||
    draggingThreadId

  // The button and the shortcut are the same action, so the two cannot drift.
  const runAction = (id: string): void => {
    void buildActions().find((action) => action.id === id)?.run()
  }

  const menuItems = (thread: Thread): ContextMenuItem[] => {
    const folder = folders.find((f) => f.id === thread.folderId) ?? null
    return [
      // One entry, both ways, and only where it means anything: a conversation
      // that has already been had cannot be un-had. Offered first when it is
      // there, because it is the only one of these with a deadline.
      ...(thread.temporary || canBecomeTemporary(thread)
        ? [
            {
              id: 'temporary',
              label: thread.temporary ? 'Keep this chat' : 'Make temporary',
              icon: <Ghost {...ICON} />,
              hint: formatBinding(settings?.keybinds['thread.toggleTemporary'] ?? 'mod+alt+t'),
              onSelect: () => {
                if (thread.temporary) {
                  void keepThread(thread.id)
                  showToast('Kept — this chat now stays')
                  return
                }
                void makeThreadTemporary(thread.id).then((made) =>
                  showToast(
                    made
                      ? 'Temporary — this chat is deleted when you leave it'
                      : 'Only a new chat — unnamed, unpinned and unused — can be made temporary'
                  )
                )
              }
            }
          ]
        : []),
      {
        id: 'pin',
        label: thread.pinned ? 'Unpin' : 'Pin',
        icon: thread.pinned ? <PinOff {...ICON} /> : <Pin {...ICON} />,
        hint: formatBinding(settings?.keybinds['thread.pin'] ?? 'mod+shift+p'),
        onSelect: () => {
          void updateThread(thread.id, { pinned: !thread.pinned })
          // Pinning keeps a temporary chat, because pinning it to a list it
          // would never appear in is not a thing anybody means.
          showToast(
            thread.temporary
              ? 'Pinned — and kept, so it stays'
              : thread.pinned
                ? 'Unpinned'
                : 'Pinned to the top'
          )
        }
      },
      // A temporary chat is never named by the model, so there is no name to
      // regenerate; it reads as "Temporary chat" until it goes.
      ...(thread.temporary
        ? []
        : [
            {
              id: 'retitle',
              label: 'Regenerate name',
              icon: <RefreshCw {...ICON} />,
              hint: formatBinding(settings?.keybinds['thread.retitle'] ?? 'shift+f2'),
              onSelect: () => void retitleThread(thread.id)
            }
          ]),
      {
        id: 'export',
        label: 'Export as Markdown',
        icon: <FileDown {...ICON} />,
        hint: formatBinding(settings?.keybinds['thread.export'] ?? 'mod+shift+x'),
        onSelect: () => void exportThread(thread.id, 'markdown')
      },
      {
        id: 'export-archive',
        label: 'Export as an archive',
        icon: <FileJson {...ICON} />,
        hint: formatBinding(settings?.keybinds['thread.exportArchive'] ?? 'mod+alt+x'),
        onSelect: () => void exportThread(thread.id, 'archive')
      },
      ...(folder
        ? [
            {
              id: 'unfile',
              label: `Take out of “${folder.name}”`,
              icon: <FolderMinus {...ICON} />,
              onSelect: () => {
                void moveThreadToFolder(thread.id, null)
                showToast(`Taken out of “${folder.name}”`)
              }
            }
          ]
        : []),
      {
        id: 'delete',
        label: 'Delete',
        icon: <Trash2 {...ICON} />,
        hint: formatBinding(settings?.keybinds['thread.delete'] ?? 'mod+shift+backspace'),
        danger: true,
        onSelect: () => {
          // Deleting takes the messages with it and cannot be undone, so ask —
          // naming the thread, since the menu may not be over the active one.
          void (async () => {
            const ok = await askConfirm({
              title: `Delete “${threadLabel(thread)}”?`,
              body: 'Its messages go with it. This cannot be undone.',
              confirmLabel: 'Delete',
              danger: true
            })
            if (ok) void deleteThread(thread.id)
          })()
        }
      }
    ]
  }

  const folderMenuItems = (folder: Folder): ContextMenuItem[] => [
    {
      id: 'pin',
      label: folder.pinned ? 'Unpin folder' : 'Pin folder',
      icon: folder.pinned ? <PinOff {...ICON} /> : <Pin {...ICON} />,
      onSelect: () => {
        void setFolderPinned(folder.id, !folder.pinned)
        showToast(folder.pinned ? 'Folder unpinned' : 'Folder pinned to the top')
      }
    },
    {
      id: 'rename',
      label: 'Rename…',
      icon: <Pencil {...ICON} />,
      onSelect: () => {
        void (async () => {
          const name = await askPrompt({
            title: `Rename “${folder.name}”`,
            defaultValue: folder.name,
            placeholder: 'Folder name',
            confirmLabel: 'Rename'
          })
          if (name?.trim()) await renameFolder(folder.id, name)
        })()
      }
    },
    {
      id: 'delete',
      label: 'Delete folder',
      icon: <Trash2 {...ICON} />,
      danger: true,
      onSelect: () => {
        void (async () => {
          const inside = threads.filter((t) => t.folderId === folder.id).length
          const ok = await askConfirm({
            title: `Delete “${folder.name}”?`,
            body: inside
              ? `The ${inside} thread${inside === 1 ? '' : 's'} inside return to the list. Nothing is deleted with it.`
              : 'The folder is empty.',
            confirmLabel: 'Delete folder',
            danger: true
          })
          if (ok) await deleteFolder(folder.id)
        })()
      }
    }
  ]

  /**
   * With a folder open, everything outside it is dimmed so what is inside can
   * be read at a glance. Dimming is the only thing that happens: a dim row is
   * an ordinary row that opens on a click, exactly as it would otherwise.
   *
   * Carried as one attribute on the list and applied by the stylesheet, rather
   * than as a prop on each row. As a prop it changed on every thread the moment
   * any folder opened, which defeated the memo on the rows and re-rendered the
   * whole list — hundreds of rows, each re-formatting its two timestamps — for
   * what is a change of opacity.
   */
  const focusing = openFolderIds.length > 0

  const renderThread = (thread: Thread, options: { inFolder?: boolean } = {}): React.JSX.Element => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      active={thread.id === activeThreadId}
      inFolder={options.inFolder ?? false}
      onSelect={onSelectThread}
      onMenu={onThreadMenu}
      onDragState={onDragState}
    />
  )

  const renderFolder = (entry: FolderEntry): React.JSX.Element => {
    const { folder } = entry
    const open = openFolderIds.includes(folder.id)

    return (
      <div
        className="folder-group"
        key={folder.id}
        data-open={open}
        data-dropping={dropTarget === folder.id}
        onDragOver={(event) => {
          if (!draggingThreadId) return
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
          setDropTarget(folder.id)
        }}
        onDrop={(event) => {
          const threadId = draggedThreadId(event)
          event.preventDefault()
          event.stopPropagation()
          setDropTarget(null)
          if (threadId) void moveThreadToFolder(threadId, folder.id)
        }}
      >
        <button
          className="folder"
          data-open={open}
          aria-expanded={open}
          onClick={() => toggleFolder(folder.id)}
          onContextMenu={(event) => {
            event.preventDefault()
            setFolderMenu({ x: event.clientX, y: event.clientY, folder })
          }}
          title={`${folder.name} — ${entry.threads.length} thread${entry.threads.length === 1 ? '' : 's'}`}
          type="button"
        >
          {open ? (
            <FolderOpenIcon className="folder__icon" {...ICON_LG} />
          ) : (
            <FolderIcon className="folder__icon" {...ICON_LG} />
          )}
          {folder.pinned && <Pin className="thread-item__pin" size={11} strokeWidth={2} />}
          <span className="folder__name">{folder.name}</span>
          <span className="folder__count">{entry.threads.length}</span>
        </button>

        {open && (
          <div className="folder__contents">
            {entry.threads.length ? (
              entry.threads.map((thread) => renderThread(thread, { inFolder: true }))
            ) : (
              <div className="folder__empty">Empty — drag a thread in</div>
            )}
          </div>
        )}
      </div>
    )
  }

  const renderEntry = (entry: Entry): React.JSX.Element =>
    entry.kind === 'folder' ? renderFolder(entry) : renderThread(entry.thread)

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <Logo size={18} />
        <span className="sidebar__brand-name">Deep Pink</span>
      </div>

      <div className="sidebar__actions">
        <button
          className="btn btn--primary"
          style={{ flex: 1, justifyContent: 'center' }}
          onClick={() => void createThread()}
          type="button"
        >
          <Plus {...ICON} />
          New thread
        </button>
        <button
          className="btn"
          onClick={() => setOverlay('palette')}
          title="Command palette"
          type="button"
        >
          <Command {...ICON} />
        </button>
      </div>

      <div className="sidebar__search">
        <Search className="icon" size={13} strokeWidth={ICON.strokeWidth} />
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

      {/* Deliberately quieter than everything above it: filing is housekeeping,
          and a full-sized button for it would compete with starting a thread. */}
      <div className="sidebar__minor">
        <button
          className="minor-btn"
          onClick={() => runAction('folder.new')}
          title={`New folder — ${formatBinding(settings?.keybinds['folder.new'] ?? 'mod+shift+n')}`}
          type="button"
        >
          <FolderPlus size={12} strokeWidth={ICON.strokeWidth} />
          New folder
        </button>
      </div>

      {/* Dropping anywhere that is not a folder takes the thread out of the one
          it is in, which is how a drag back to the list is meant to read. */}
      <div
        className="sidebar__list"
        ref={listRef}
        onScroll={buildAhead}
        data-focusing={focusing}
        data-dropping={dropTarget === ''}
        onDragOver={(event) => {
          if (!draggingThreadId) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropTarget('')
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDropTarget(null)
        }}
        onDrop={(event) => {
          const threadId = draggedThreadId(event)
          event.preventDefault()
          setDropTarget(null)
          if (threadId) void moveThreadToFolder(threadId, null)
        }}
      >
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
                      {threadLabel({ title: hit.threadTitle, temporary: hit.temporary })}
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
            {shownSections.map((section) => (
              <div key={section.label}>
                <div className="sidebar__group-label">{section.label}</div>
                {section.entries.map(renderEntry)}
              </div>
            ))}
            {totalEntries === 0 && <div className="sidebar__group-label">No threads yet</div>}
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

      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={folderMenuItems(folderMenu.folder)}
          onClose={() => setFolderMenu(null)}
        />
      )}

      {sync?.config.enabled && sync.ready && (
        // Sync is meant to be invisible, so the one place it is visible has to
        // say everything at a glance: what it is doing, when it last worked,
        // and — the only part that needs a person — whether it stopped.
        <button
          className="syncline"
          data-state={
            sync.running
              ? 'running'
              : sync.paused
                ? 'paused'
                : sync.lastError
                  ? 'error'
                  : 'idle'
          }
          onClick={() => setOverlay('settings')}
          title={
            sync.paused
              ? sync.config.pause?.until
                ? `Paused until ${formatDateTime(sync.config.pause.until)}`
                : 'Paused until you resume it'
              : sync.lastError
                ? `Sync: ${sync.lastError}`
                : sync.lastSyncedAt
                  ? `Last synced ${formatDateTime(sync.lastSyncedAt)}`
                  : 'Not synced yet'
          }
          type="button"
        >
          <span className="syncline__row">
            {sync.paused && !sync.running ? (
              <PauseIcon className="syncline__icon" {...ICON} />
            ) : (
              <RefreshCw className="syncline__icon" {...ICON} />
            )}
            <span className="syncline__text">
              {sync.running
                ? (syncProgress?.detail ?? 'syncing…')
                : sync.paused
                  ? 'sync paused'
                  : sync.lastError
                    ? 'sync stopped'
                    : sync.lastSyncedAt
                      ? `synced ${formatRelativeShort(sync.lastSyncedAt)}`
                      : 'not synced yet'}
            </span>
            {sync.running && syncProgress && syncProgress.total > 1 && (
              <span className="syncline__count">
                {syncProgress.done}/{syncProgress.total}
              </span>
            )}
          </span>
          {sync.running && (
            <span className="syncline__track">
              <span
                className="syncline__fill"
                data-indeterminate={!syncProgress || syncProgress.total < 1}
                style={
                  syncProgress && syncProgress.total > 0
                    ? { width: `${Math.min((syncProgress.done / syncProgress.total) * 100, 100)}%` }
                    : undefined
                }
              />
            </span>
          )}
        </button>
      )}

      <div className="sidebar__footer">
        <button
          className="btn btn--ghost"
          onClick={() => setOverlay('globalStats')}
          title="Global statistics"
          type="button"
        >
          <BarChart3 className="icon" {...ICON} />
          Stats
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => setOverlay('mcp')}
          title="MCP servers"
          type="button"
        >
          <Blocks className="icon" {...ICON} />
          MCP
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => setOverlay('settings')}
          title="Settings"
          type="button"
        >
          <SettingsIcon className="icon" {...ICON} />
          Settings
        </button>
      </div>
    </aside>
  )
}
