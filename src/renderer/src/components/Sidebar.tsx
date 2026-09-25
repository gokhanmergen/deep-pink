import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { canBecomeTemporary, useStore } from '../store'
import { prefetchThread } from '../prefetch'
import { dateBucket, formatDateTime, formatRelativeShort, formatTokens, threadLabel } from '../format'
import {
  Archive,
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
import { ExperimentalDot } from './Experimental'
import { ModelIcon } from './ModelIcon'
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
 * How long a deleted row stays on screen to leave.
 *
 * Short enough that deleting three in a row does not queue, long enough that
 * the rows below are seen to close the gap rather than snap into it. Must match
 * the `thread-out` animation in the stylesheet.
 */
const LEAVING_TAKES = 240

/** How long a changed name stays soft. Matches `name-settles` in the sheet. */
const NAME_SETTLES = 260

/**
 * How long after a turn a name can still be expected.
 *
 * Naming is one small request and it starts the moment the turn ends, so it
 * lands in seconds. Two minutes is far longer than it needs and still short
 * enough that a thread whose naming failed goes back to reading "Untitled
 * thread" rather than shimmering at you for the rest of the session.
 */
const NAMING_TAKES = 2 * 60 * 1000

/** How long a pointer has to stay on a row before it counts as interest. */
const DWELL = 100

/**
 * How long after a thread opens before its neighbours are read.
 *
 * Late enough that the thread actually being opened has the machine to itself
 * — the highlighter is busy with what is on screen, and getting there first is
 * the point of all of this.
 */
const AFTER_OPENING = 1200

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
  wip,
  generating,
  awaitingName,
  model,
  live,
  leaving,
  renaming,
  inFolder,
  onSelect,
  onHover,
  onMenu,
  onDragState,
  onRename
}: {
  thread: Thread
  active: boolean
  /** This inactive thread has unsent prompt text. */
  wip: boolean
  /** A reply is arriving in this thread, whether or not you are looking at it. */
  generating: boolean
  /** It has no name yet and one is coming, so there is nothing to write here. */
  awaitingName: boolean
  /** What this conversation is set to use, so the row can show whose it is. */
  model: string
  /** What it has produced so far, while it is producing. Null when it is not. */
  live: { tokens: number; perSecond: number } | null
  /** It has gone, and is still on screen only long enough to leave. */
  leaving: boolean
  /** Its name is being edited, here in the row rather than anywhere else. */
  renaming: boolean
  /** Indented, because it is inside an open folder. */
  inFolder: boolean
  onSelect: (id: string) => void
  /** The pointer came to rest here, or left. See `dwellOn` in the sidebar. */
  onHover: (id: string | null) => void
  onMenu: (event: React.MouseEvent, thread: Thread) => void
  onDragState: (threadId: string | null) => void
  onRename: (threadId: string, name: string) => void
}): React.JSX.Element {
  /**
   * Whether the name just changed under the reader.
   *
   * It does change: a title written from the question is replaced by one
   * written from the whole exchange a few seconds later, and swapping the text
   * in place made a word turn into a different word with no account of why. It
   * goes soft and comes back sharp instead, which reads as the thing settling
   * rather than being corrected.
   *
   * This was a `key` on the title, which is simpler and was wrong: a key makes
   * a new element whenever the text differs from the last render, and a row
   * that was not rendered at all has no last render. So every row inside a
   * folder blurred in each time the folder was opened, which is a rename
   * animation playing for something that was not renamed.
   *
   * A ref is the distinction, because it is created with the component: on a
   * fresh mount it already holds the name being shown and nothing runs.
   */
  const seen = useRef(thread.title)
  const [settling, setSettling] = useState(false)

  useEffect(() => {
    if (seen.current === thread.title) return
    seen.current = thread.title
    setSettling(true)
    const timer = setTimeout(() => setSettling(false), NAME_SETTLES)
    return () => clearTimeout(timer)
  }, [thread.title])

  return (
    <button
      className="thread-item"
      data-active={active}
      data-in-folder={inFolder}
      onMouseEnter={() => onHover(thread.id)}
      onMouseLeave={() => onHover(null)}
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
      data-wip={wip || undefined}
      data-generating={generating}
      data-leaving={leaving || undefined}
      // A row on its way out is a row nothing should be able to click.
      aria-hidden={leaving || undefined}
      tabIndex={leaving ? -1 : undefined}
      onClick={() => onSelect(thread.id)}
      onContextMenu={(event) => onMenu(event, thread)}
      title={
        thread.temporary
          ? 'Temporary chat — deleted when you leave it or close the app'
          : wip
            ? 'Unsent prompt draft — kept until the app restarts'
            : awaitingName
              ? 'Naming this conversation…'
              : threadLabel(thread)
      }
      type="button"
    >
      <span className="thread-item__head">
        {thread.pinned && <Pin className="thread-item__pin" size={11} strokeWidth={2} />}
        {thread.temporary && <Ghost className="thread-item__ghost" size={12} strokeWidth={2} />}
        {/*
          * A name on its way is drawn as the shape of one.
          *
          * It said "Untitled thread" — a real phrase, in the same type as every
          * real title, for the one row in the list whose name is about to
          * change. Reading it told you nothing and it read like a thread
          * actually called that. A bar that is plainly not a word says the same
          * thing without being mistaken for the answer.
          */}
        {renaming ? (
          /*
           * The name, edited where it is.
           *
           * Renaming used to be a dialog over the list with the name in a text
           * field — a second place to edit a thing already on screen. Here the
           * row simply becomes editable, which is the same gesture as renaming
           * a file anywhere else.
           *
           * `stopPropagation` on the click because the row underneath is a
           * button that opens the thread, and clicking into a text field is
           * not asking to go anywhere.
           */
          <input
            className="thread-item__rename"
            defaultValue={thread.title}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                // Put the original back before blurring, so the commit below
                // writes what was there rather than the abandoned draft.
                event.currentTarget.value = thread.title
                event.currentTarget.blur()
              }
            }}
            onBlur={(event) => onRename(thread.id, event.currentTarget.value)}
          />
        ) : awaitingName ? (
          <span className="thread-item__title thread-item__pending" aria-label="Naming this conversation">
            <span />
          </span>
        ) : (
          <span className="thread-item__title" data-settling={settling || undefined}>
            {wip && !thread.title ? 'WIP Thread' : threadLabel(thread)}
          </span>
        )}
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
        {/*
          * While it is working, the line says what it is doing instead.
          *
          * How many messages a thread has and when it was made are facts that
          * will still be true in an hour; a reply arriving is the one thing
          * about this row that is only true now, and it is the only time the
          * second line has something to say that you could not find out later.
          */}
        {live ? (
          <>
            <span className="nowrap thread-item__live">{formatTokens(live.tokens)} tokens</span>
            <span className="thread-item__sep">·</span>
            <span className="nowrap thread-item__live">{live.perSecond.toFixed(1)}/s</span>
          </>
        ) : (
          <>
            {/* Your messages. The replies are not counted — see
                `READABLE_MESSAGES`; one follows each of these anyway, so
                counting both said the same thing twice. */}
            <span className="nowrap">
              {wip
                ? 'unsent draft'
                : thread.messageCount === 0
                  ? 'empty'
                  : `${thread.messageCount} message${thread.messageCount === 1 ? '' : 's'}`}
            </span>
            <span className="thread-item__sep">·</span>
            {/* The second half of the line is the age of an ordinary thread,
                and for a temporary one the only thing worth saying about it. */}
            <span className="nowrap">
              {thread.temporary ? 'not saved' : `created ${formatRelativeShort(thread.createdAt)}`}
            </span>
          </>
        )}
        {/* At the end of the line rather than beside the title: the title is
            what you read down the list for, and a mark in front of it would be
            a column of logos with the names indented behind them. */}
        <ModelIcon model={model} className="thread-item__model" />
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
  const drafts = useStore((s) => s.drafts)
  const folders = useStore((s) => s.folders)
  const openFolderIds = useStore((s) => s.openFolderIds)
  const draggingThreadId = useStore((s) => s.draggingThreadId)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const activeHasMessages = useStore((s) =>
    Boolean(s.activeThreadId && s.messages.some((message) => message.threadId === s.activeThreadId))
  )
  const generatingThreadIds = useStore((s) => s.generatingThreadIds)
  const namingFinished = useStore((s) => s.namingFinished)
  const hideExperimental = useStore((s) => s.settings?.hideExperimental ?? true)
  const liveStats = useStore((s) => s.liveStats)
  const rename = useStore((s) => s.renaming)
  const startRename = useStore((s) => s.startRename)
  const namingEnabled = useStore((s) => s.settings?.titleGenerationEnabled ?? false)
  // The value, not the settings object: a row must not re-render because some
  // unrelated preference changed.
  const defaultModel = useStore((s) => s.settings?.defaultModel ?? '')
  const filter = useStore((s) => s.sidebarFilter)
  const hits = useStore((s) => s.searchHits)
  const selectThread = useStore((s) => s.selectThread)
  const createThread = useStore((s) => s.createThread)
  const setSidebarFilter = useStore((s) => s.setSidebarFilter)
  const openSettings = useStore((s) => s.openSettings)
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
  /**
   * Hide a new empty thread until it becomes a conversation. An unsent prompt
   * appears as a WIP row only after its thread is inactive, and stays that way
   * until the user returns to it.
   *
   * Empty inactive threads without a draft stay out of the library unless
   * they were named, pinned, filed, or made temporary.
   */
  const draftIdsKey = Object.keys(drafts)
    .filter((id) => Boolean(drafts[id]?.trim()))
    .sort()
    .join('\u0000')
  const draftIds = useMemo(
    () => new Set(draftIdsKey ? draftIdsKey.split('\u0000') : []),
    [draftIdsKey]
  )
  const started = useMemo(
    () =>
      threads.filter(
        (t) =>
          (t.id === activeThreadId && activeHasMessages) ||
          t.messageCount > 0 ||
          t.temporary ||
          t.title ||
          t.pinned ||
          t.folderId ||
          (t.id !== activeThreadId && draftIds.has(t.id))
      ),
    [threads, activeThreadId, activeHasMessages, draftIds]
  )

  /**
   * Rows that have gone, kept on screen long enough to leave.
   *
   * React removes an element the moment its data says so, which is the one
   * thing an exit animation cannot survive. So what has gone is remembered for
   * as long as the animation runs and rendered alongside what has not — in its
   * own old position, because it still carries the timestamp the list sorts by.
   */
  const [leaving, setLeaving] = useState<Thread[]>([])
  const lastSeen = useRef(started)
  const leaveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const present = new Set(started.map((t) => t.id))
    const gone = lastSeen.current.filter((t) => !present.has(t.id))
    lastSeen.current = started

    // If a row returns during its exit animation, cancel its timer and render
    // the live row once instead of leaving a duplicate ghost behind.
    for (const id of present) {
      const timer = leaveTimers.current.get(id)
      if (timer) {
        clearTimeout(timer)
        leaveTimers.current.delete(id)
      }
    }
    setLeaving((current) => {
      const next = current.filter((thread) => !present.has(thread.id))
      return next.length === current.length ? current : next
    })

    if (!gone.length) return

    setLeaving((current) => {
      const byId = new Map(current.map((thread) => [thread.id, thread]))
      for (const thread of gone) {
        if (!present.has(thread.id)) byId.set(thread.id, thread)
      }
      return [...byId.values()]
    })

    for (const thread of gone) {
      if (present.has(thread.id)) continue
      const previous = leaveTimers.current.get(thread.id)
      if (previous) clearTimeout(previous)
      const timer = setTimeout(() => {
        leaveTimers.current.delete(thread.id)
        setLeaving((current) => current.filter((item) => item.id !== thread.id))
      }, LEAVING_TAKES)
      leaveTimers.current.set(thread.id, timer)
    }
  }, [started])

  useEffect(
    () => () => {
      for (const timer of leaveTimers.current.values()) clearTimeout(timer)
      leaveTimers.current.clear()
    },
    []
  )

  /** What the list draws: what is here, and what is still on its way out. */
  const startedIds = useMemo(() => new Set(started.map((thread) => thread.id)), [started])
  const listed = useMemo(
    () =>
      leaving.length
        ? [...started, ...leaving.filter((thread) => !startedIds.has(thread.id))]
        : started,
    [started, startedIds, leaving]
  )

  const goneIds = useMemo(
    () => new Set(leaving.filter((thread) => !startedIds.has(thread.id)).map((thread) => thread.id)),
    [leaving, startedIds]
  )

  const temporaryThreads = useMemo(
    () => listed.filter((t) => t.temporary).sort((a, b) => b.createdAt - a.createdAt),
    [listed]
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

    for (const thread of [...listed]
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
  }, [listed, folders])

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

  /**
   * A row the pointer has settled on, read ahead of being asked for.
   *
   * The delay is the whole of it. A pointer on its way somewhere crosses a
   * dozen rows, and treating each crossing as interest would read a dozen
   * conversations to serve one — so nothing happens until the pointer has
   * stayed, which is the difference between passing over a row and looking at
   * it. A tenth of a second is far below the time it takes to decide to click
   * and far above the time it takes to travel past.
   *
   * One timer for the whole list rather than one per row, because only one row
   * can be under the pointer, and because `ThreadRow` is memoised — a callback
   * that changed identity would wake every row in the sidebar.
   */
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dwellOn = useCallback(
    (id: string | null) => {
      if (dwell.current) clearTimeout(dwell.current)
      if (!id) return
      dwell.current = setTimeout(() => void prefetchThread(id), DWELL)
    },
    []
  )
  useEffect(
    () => () => {
      if (dwell.current) clearTimeout(dwell.current)
    },
    []
  )

  /**
   * Writes a new name and closes the input, whichever way it was closed.
   *
   * Blur is the one commit point: Enter and Escape both blur rather than
   * committing themselves, so there is a single path that saves and a single
   * path that stops, instead of three that have to agree.
   */
  const commitRename = useCallback(
    (threadId: string, name: string) => {
      const trimmed = name.trim()
      const before = useStore.getState().threads.find((t) => t.id === threadId)
      if (before && trimmed !== before.title) void updateThread(threadId, { title: trimmed })
      startRename(null)
    },
    [updateThread, startRename]
  )

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

  /**
   * And the rows either side of the one just opened.
   *
   * Hover is no help to the reader who never touches the pointer: Alt+Up and
   * Alt+Down walk this same list, and the thread most likely to be opened next
   * is the one next to the thread just opened. It costs the same read, and it
   * covers the path the shortcut takes.
   */
  useEffect(() => {
    const at = visibleThreadIds.indexOf(activeThreadId ?? '')
    if (at < 0) return
    // One after the other: the reader is ahead of them both, and prefetching
    // takes one thread at a time on purpose.
    const timer = setTimeout(() => {
      void prefetchThread(visibleThreadIds[at + 1] ?? null).then(() =>
        prefetchThread(visibleThreadIds[at - 1] ?? null)
      )
    }, AFTER_OPENING)
    return () => clearTimeout(timer)
  }, [activeThreadId, visibleThreadIds])

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
      /*
       * Renaming, which the menu never offered.
       *
       * Every other way of naming a thread was reachable — double-clicking the
       * title, the shortcut, asking the model for another one — and the one
       * place you would look for it when you are already pointing at the
       * thread was the place it was missing from. A temporary chat has no name
       * to change; it reads as "Temporary chat" until it goes.
       */
      ...(thread.temporary
        ? []
        : [
            {
              id: 'rename',
              label: 'Rename',
              icon: <Pencil {...ICON} />,
              hint: formatBinding(settings?.keybinds['thread.rename'] ?? 'f2'),
              onSelect: () => startRename({ threadId: thread.id, where: 'sidebar' })
            }
          ]),
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
      /*
       * Archiving, also missing. It takes the thread out of the list without
       * deleting anything, which is the middle ground between keeping a
       * conversation in front of you and losing it — and the menu is where you
       * are when you decide a thread is done with.
       */
      {
        id: 'archive',
        label: 'Archive',
        icon: <Archive {...ICON} />,
        hint: formatBinding(settings?.keybinds['thread.archive'] ?? 'mod+shift+a'),
        onSelect: () => {
          void updateThread(thread.id, { archived: true })
          showToast('Archived — out of the list, not deleted')
        }
      },
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
          const inside = started.filter((t) => t.folderId === folder.id).length
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

  /**
   * Whether a name is on its way to this thread.
   *
   * Not simply "has no title": plenty of threads have none and never will. A
   * temporary chat is never named, a chat nobody has spoken in has nothing to
   * name it after, and with automatic naming switched off none of them are. The
   * placeholder is a promise that something is coming, so it is only shown
   * where something is.
   *
   * And a promise has to expire. Naming can fail — no key, a model that is
   * gone, a request that timed out — and the thread is then untitled for good.
   * A shimmer that never resolves is a worse lie than the words it replaced, so
   * it is only offered while the reply is still arriving or in the short window
   * after it where the name is being written.
   */
  /**
   * The moment the nearest naming window runs out, and a nudge to look again.
   *
   * `awaitingName` below asks what the time is, and nothing was telling the
   * list when the answer would change. So a row that started shimmering went
   * on shimmering after its two minutes were up — until something unrelated
   * happened to re-render the sidebar, which on an app nobody is touching may
   * be minutes away or may be never. Measured: a window that closed at zero
   * was still shimmering forty seconds later, and only stopped at seventy when
   * some other refresh came along.
   *
   * A promise that expires has to have something waiting for it to expire.
   * One timer, for the soonest of them: when it fires the list renders, that
   * row settles, and the next deadline — if there is one — is picked up on the
   * way past. Threads that are still generating are left out, because their
   * window is held open by that rather than by the clock, and its ending is
   * itself a change the list hears about.
   */
  const [, nameWindowClosed] = useReducer((n: number) => n + 1, 0)
  const nextNamingDeadline = ((): number | null => {
    if (!namingEnabled) return null
    const now = Date.now()
    let soonest: number | null = null
    for (const thread of threads) {
      if (thread.title || thread.temporary || thread.messageCount === 0) continue
      if (generatingThreadIds.includes(thread.id)) continue
      if (namingFinished.has(thread.id)) continue
      const at = thread.updatedAt + NAMING_TAKES
      if (at > now && (soonest === null || at < soonest)) soonest = at
    }
    return soonest
  })()

  useEffect(() => {
    if (nextNamingDeadline === null) return
    const timer = setTimeout(nameWindowClosed, Math.max(nextNamingDeadline - Date.now(), 0) + 50)
    return () => clearTimeout(timer)
  }, [nextNamingDeadline])

  const awaitingName = (thread: Thread): boolean =>
    namingEnabled &&
    !thread.title &&
    !thread.temporary &&
    thread.messageCount > 0 &&
    // Naming has come back empty for this one, so nothing is coming and the
    // clock below is beside the point.
    !namingFinished.has(thread.id) &&
    (generatingThreadIds.includes(thread.id) || Date.now() - thread.updatedAt < NAMING_TAKES)

  const renderThread = (thread: Thread, options: { inFolder?: boolean } = {}): React.JSX.Element => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      active={thread.id === activeThreadId}
      wip={thread.id !== activeThreadId && Boolean(drafts[thread.id]?.trim())}
      generating={generatingThreadIds.includes(thread.id)}
      awaitingName={awaitingName(thread)}
      model={thread.config.model ?? defaultModel}
      live={liveStats[thread.id] ?? null}
      leaving={goneIds.has(thread.id)}
      renaming={rename?.where === 'sidebar' && rename.threadId === thread.id}
      onRename={commitRename}
      inFolder={options.inFolder ?? false}
      onSelect={onSelectThread}
      onHover={dwellOn}
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
          onClick={() => openSettings('sync')}
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
        {/* MCP is experimental, and the only one of these that starts
            processes on your machine — the first to go when the workshop is
            put away. */}
        {!hideExperimental && (
        <button
          className="btn btn--ghost"
          onClick={() => setOverlay('mcp')}
          title="MCP servers — experimental"
          type="button"
        >
          <Blocks className="icon" {...ICON} />
          MCP
          {/* The dot the settings list uses, for the same reason: this is a
              row of three words with no room for a fourth, and what it has to
              do here is mark the section rather than explain it. The word
              itself is on the panel this opens. */}
          <ExperimentalDot />
        </button>
        )}
        <button
          className="btn btn--ghost"
          onClick={() => openSettings()}
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
