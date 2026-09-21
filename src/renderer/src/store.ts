import { create } from 'zustand'
import type {
  Attachment,
  Folder,
  McpServerStatus,
  Message,
  MessagePage,
  OpenRouterModel,
  SearchHit,
  PendingAttachment,
  Settings,
  SettingsPatch,
  StreamEvent,
  SyncProgress,
  SyncState,
  Thread,
  ThreadConfig,
  ThreadTotals,
  ToolCall
} from '@shared/types'
import { wantKeyPoint } from './keyPoint'

export type Overlay =
  | null
  | 'palette'
  | 'search'
  | 'settings'
  | 'models'
  | 'defaultModel'
  | 'titleModel'
  | 'pregenTitleModel'
  | 'keyPointModel'
  | 'providers'
  | 'prompt'
  | 'threadStats'
  | 'globalStats'
  | 'mcp'
  | 'keybinds'

/**
 * A section of the settings panel, named so other parts of the app can ask for
 * one.
 *
 * Several places offer a way into Settings — the sync line in the sidebar, the
 * shortcut sheet, the notice about a missing API key — and each of them is
 * about something specific. Opening the panel on whatever it happened to show
 * last and leaving the reader to find the rest is the app knowing where they
 * were going and not taking them there.
 */
export type SettingsTab =
  | 'account'
  | 'models'
  | 'prompts'
  | 'web'
  | 'charts'
  | 'docs'
  | 'keyPoint'
  | 'context'
  | 'appearance'
  | 'keys'
  | 'data'
  | 'sync'

export interface PendingApproval {
  toolCall: ToolCall
  serverName: string
}

export interface Toast {
  message: string
  tone: 'info' | 'error'
}

/**
 * An in-app replacement for window.confirm / window.prompt.
 *
 * The native ones are OS-drawn, ignore the app's theme, and block the renderer
 * while they are open. This keeps the promise-based shape of the originals so
 * call sites read the same way.
 */
export interface DialogRequest {
  kind: 'confirm' | 'prompt'
  title: string
  body?: string
  confirmLabel: string
  cancelLabel: string
  danger: boolean
  defaultValue: string
  placeholder?: string
  resolve: (value: string | null) => void
}

export interface ConfirmOptions {
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export interface PromptOptions {
  title: string
  body?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
}

interface State {
  ready: boolean
  settings: Settings | null
  models: OpenRouterModel[]
  threads: Thread[]
  folders: Folder[]
  /**
   * Folders currently open, in the order they were opened. Held here rather
   * than on disk: which drawer you have out is about the minute you are in,
   * not a preference worth restoring a week later.
   */
  openFolderIds: string[]
  /** The thread being dragged, so the list can show where it would land. */
  draggingThreadId: string | null
  activeThreadId: string | null
  /**
   * The part of the conversation that has been read in — the end of it, and
   * however much before that the reader has scrolled back to. Never the whole
   * thread unless the whole thread is short.
   */
  messages: Message[]
  /**
   * Where the loaded part begins, in the database's own ordering. Kept opaque:
   * it is handed straight back to ask for the page before this one, or to
   * re-read this one, and nothing here does arithmetic on it.
   */
  messageWindowStart: number | null
  /** Whether there is anything before what has been read in. */
  hasOlderMessages: boolean
  /** A page is on its way, so the scroll handler does not ask for it again. */
  loadingOlder: boolean
  /**
   * What the whole thread cost, which is not the sum of what is on screen.
   * Read from the database so the header does not count upwards as you scroll.
   */
  threadTotals: ThreadTotals | null
  generating: boolean
  compacting: boolean
  mcpStatuses: McpServerStatus[]
  overlay: Overlay
  /** Where to go when the current overlay closes, e.g. back to Settings. */
  overlayReturnTo: Overlay
  /**
   * Which section of Settings is open, or null before it has ever been opened.
   *
   * Held here rather than in the panel because the panel is unmounted and
   * remounted constantly — every model picker opened from inside it takes it
   * off screen and puts it back — and a tab in local state is lost each time.
   * It is also what lets a caller aim: `openSettings('sync')` sets it, and
   * `openSettings()` leaves it where it was, so the sidebar's Settings button
   * reopens the panel where you left it.
   */
  settingsTab: SettingsTab | null
  sidebarVisible: boolean
  sidebarFilter: string
  searchHits: SearchHit[]
  /** Query the search overlay opens with, when something opened it for you. */
  searchSeed: string
  /**
   * Threads the sidebar is showing, in the order it is showing them. Published
   * by the sidebar because it is the only thing that knows: the order depends
   * on whether a search is running. Empty when the sidebar is not on screen.
   */
  visibleThreadIds: string[]
  pendingApproval: PendingApproval | null
  toast: Toast | null
  dialog: DialogRequest | null
  /**
   * Every thread with a reply arriving in it, not only the one on screen.
   *
   * `generating` above is about the open conversation, which is what the
   * composer and the transcript need. The sidebar needs the other question —
   * *which* threads are working — because a turn started here goes on running
   * after you leave, and a list that said nothing about it was a list where
   * the only way to find out was to go back and look.
   *
   * An array rather than a Set so the rows can be compared by identity: the
   * list re-renders when this changes, and a row that is neither starting nor
   * finishing must not.
   */
  generatingThreadIds: string[]
  /**
   * Threads naming has finished with and produced no name for.
   *
   * Only ever grows, and only within a session: what it records is that the
   * request came back empty, which is a fact about a moment and not about the
   * thread. Renaming one by hand, or a later sweep naming it, gives it a
   * title and takes it out of the shimmering case anyway.
   */
  namingFinished: Set<string>
  /**
   * How much each working thread has produced, and how fast.
   *
   * Only ever holds threads that are generating, and only exists so the list
   * can say something more useful than "12 messages" about a row where the
   * number is changing as you look at it.
   *
   * Published on a timer rather than per delta. A reply arrives in dozens of
   * chunks a second and the sidebar is hundreds of rows; setting this on each
   * one would re-render the list at the rate the model types.
   */
  liveStats: Record<string, { tokens: number; perSecond: number }>
  /** Message id the transcript should scroll to and flash. */
  highlightMessageId: string | null
  /**
   * The message currently open for editing, if any.
   *
   * Held here rather than in the row that shows it because two things ask for
   * it — the Edit button on a message, and the shortcut for the last one you
   * sent — and a row cannot be told anything by a keybind. The shortcut used to
   * put up a modal single-line prompt instead, which was a second, worse editor
   * for the same job: no room for a message of more than a line, and nothing
   * about it resembling the one the button opens.
   */
  editingMessageId: string | null
  /**
   * The thread being renamed, and which of the two places showing its name is
   * doing the renaming.
   *
   * A name appears twice — in the top bar of the conversation and in its row in
   * the list — and renaming happens where you asked for it rather than in both
   * at once. Double-clicking the title in the top bar edits it there; the row's
   * own menu edits the row. Held here rather than in either component because
   * the menu that starts it is not inside the thing it edits.
   */
  renaming: { threadId: string; where: 'topbar' | 'sidebar' } | null
  /**
   * The image being looked at, and everything else in the thread it can be
   * stepped through. Held here rather than in the transcript so the viewer
   * outlives the row that opened it — a re-render mid-stream must not close it.
   */
  imageViewer: { images: Attachment[]; index: number } | null
  /**
   * Sync, held here rather than in the settings panel: the sidebar shows it
   * too, and two copies of "is it running" would eventually disagree.
   */
  sync: SyncState | null
  /** Where the current run has got to, or null between runs. */
  syncProgress: SyncProgress | null

  init: () => Promise<void>
  refreshThreads: () => Promise<void>
  refreshSettings: () => Promise<Settings>
  selectThread: (id: string | null) => Promise<void>
  /**
   * Asks which of a reply's sentences is the one to read first, and remembers
   * the answer on the message. See `./keyPoint`.
   */
  findKeyPoint: (messageId: string, reply: string, candidates: string[]) => Promise<void>
  createThread: () => Promise<Thread>
  deleteThread: (id: string) => Promise<void>
  /** Stops a temporary chat being temporary, so it outlives the session. */
  keepThread: (id: string) => Promise<void>
  /**
   * Makes a chat temporary. Resolves false when it was refused, which means
   * something has already been said in it.
   */
  makeThreadTemporary: (id: string) => Promise<boolean>
  /**
   * Reads in the page before the one on screen. Returns whether anything was
   * added, so the caller can put the view back where the reader left it.
   */
  loadOlderMessages: () => Promise<boolean>
  /**
   * Re-reads the range that is on screen, in place. What an edit or a deletion
   * calls: reopening the thread would throw away everything scrolled back to.
   */
  refreshTranscript: () => Promise<void>
  /**
   * Throws the loaded range away and re-reads the end of the conversation.
   * For when the transcript is no longer the one that was loaded — compaction.
   */
  resetTranscript: () => Promise<void>
  /** Re-reads what the thread has cost, which the header shows. */
  refreshTotals: () => Promise<void>
  /**
   * Opens a thread at a particular message and flashes it — what a search hit
   * does. Reads in whatever part of the conversation it takes to get there.
   */
  revealMessage: (threadId: string, messageId: string) => Promise<void>
  updateThread: (
    id: string,
    patch: Partial<Pick<Thread, 'title' | 'pinned' | 'archived'>> & {
      config?: Partial<ThreadConfig>
    }
  ) => Promise<void>
  /** Asks the naming model for a fresh name for a thread — any thread. */
  retitleThread: (id: string) => Promise<void>
  refreshFolders: () => Promise<void>
  /** Creates a folder and opens it, so it is ready to be dropped into. */
  createFolder: (name: string) => Promise<Folder | null>
  renameFolder: (id: string, name: string) => Promise<void>
  /** Deletes the folder. The threads it held return to the list. */
  deleteFolder: (id: string) => Promise<void>
  setFolderPinned: (id: string, pinned: boolean) => Promise<void>
  toggleFolder: (id: string) => void
  /** Closes every open folder, and with them the dimming of everything else. */
  closeAllFolders: () => void
  /** Files a thread in a folder, or takes it out again with null. */
  moveThreadToFolder: (threadId: string, folderId: string | null) => Promise<void>
  setDraggingThread: (threadId: string | null) => void
  send: (content: string, attachments?: PendingAttachment[]) => Promise<void>
  regenerate: (messageId: string) => Promise<void>
  /**
   * Answers a message again, from that message.
   *
   * What editing one of your own does, and what the offer under an unanswered
   * turn does. Distinct from `regenerate`, which is handed a *reply* and works
   * back to the message before it; this is handed the message to answer.
   */
  resendFrom: (messageId: string) => Promise<void>
  abort: () => Promise<void>
  compact: () => Promise<void>
  saveSettings: (patch: SettingsPatch) => Promise<void>
  refreshModels: (force?: boolean) => Promise<void>
  setVisibleThreads: (ids: string[]) => void
  /** Moves to the thread `delta` places away in the list, as displayed. */
  stepThread: (delta: number) => void
  runSearch: (query: string) => Promise<void>
  setOverlay: (overlay: Overlay, returnTo?: Overlay) => void
  /** Opens Settings, on a named section when the caller has one in mind. */
  openSettings: (tab?: SettingsTab) => void
  /** Moves to a section, which is how the panel's own list of them works. */
  setSettingsTab: (tab: SettingsTab) => void
  /** Opens the search overlay, optionally with a query already in it. */
  openSearch: (query?: string) => void
  /** Closes the overlay, returning to whatever opened it. */
  closeOverlay: () => void
  setSidebarFilter: (value: string) => void
  toggleSidebar: () => void
  showToast: (message: string, tone?: Toast['tone']) => void
  approveTool: (approved: boolean) => Promise<void>
  setHighlight: (messageId: string | null) => void
  /** Opens a message for editing in place, or closes whatever is open. */
  editMessage: (messageId: string | null) => void
  /** Starts renaming a thread where its name already is. Null stops. */
  startRename: (target: { threadId: string; where: 'topbar' | 'sidebar' } | null) => void
  /** Opens the image viewer on `id`, stepping through every image given. */
  openImageViewer: (images: Attachment[], id: string) => void
  closeImageViewer: () => void
  /** Moves to the next image along, wrapping at either end. */
  stepImageViewer: (delta: number) => void
  refreshSync: () => Promise<SyncState | null>
  /** Holds off automatic syncing; null means until it is resumed by hand. */
  pauseSync: (until: number | null) => Promise<void>
  resumeSync: () => Promise<void>
  /** Syncs now, and reports what happened. */
  runSync: () => Promise<void>
  /** Resolves true if the user confirms. */
  askConfirm: (options: ConfirmOptions) => Promise<boolean>
  /** Resolves the entered text, or null if cancelled. */
  askPrompt: (options: PromptOptions) => Promise<string | null>
  resolveDialog: (value: string | null) => void
}

const api = window.deepPink

/**
 * How much of a conversation is read at once.
 *
 * A page is what has to be parsed and laid out before a conversation appears,
 * and Markdown is not cheap: tables, maths and code blocks, each message its
 * own document. So this is deliberately about a screenful rather than several
 * — the transcript tops itself up on open until there is something to scroll,
 * and asks for the next page while it is still two screens away, so nobody is
 * ever waiting at an edge. What it buys is that opening a thread parses what
 * you are about to read rather than three times that much.
 */
const PAGE_SIZE = 16

/**
 * A limit that no conversation reaches, which is how "all of it" is asked for.
 *
 * The reader who has turned paging off wants the whole thread in the window,
 * and the query already answers that question: ask for more messages than
 * exist and it returns from the beginning with nothing before it, so every
 * path that pages — opening, compacting, jumping to a search hit — becomes a
 * single whole-thread read without any of them needing to know that is what
 * happened.
 */
const WHOLE_THREAD = 1_000_000

/** How much of a transcript one read asks for, which the reader decides. */
function pageSize(get: Getter): number {
  return get().settings?.ui.loadEverythingAtOnce ? WHOLE_THREAD : PAGE_SIZE
}

/**
 * The same, for a caller outside the store — which is `./prefetch`, reading a
 * thread before it is asked for. It has to ask for the same range the open
 * will, or it warms a screenful nobody is about to look at.
 */
export function transcriptPageSize(): number {
  return pageSize(useStore.getState)
}

/**
 * Re-reads the part of the transcript that is on screen.
 *
 * An edit, a deletion or a tool result changes rows that are already loaded, so
 * the window has to be read again — but asking for a *page* would collapse it
 * back to one screenful and take the reader's place in the conversation with
 * it. This asks for exactly the range that was already there, plus whatever has
 * been added at the end since.
 *
 * Returns null when the reader has moved to another thread in the meantime, in
 * which case what came back belongs to a conversation nobody is looking at.
 */
async function readWindow(threadId: string, get: Getter): Promise<MessagePage | null> {
  const page = await api.messages.from(threadId, get().messageWindowStart)
  return get().activeThreadId === threadId ? page : null
}

/* ------------------------------------------------------------------ *
 * Keeping the thread list still
 * ------------------------------------------------------------------ */

/**
 * Whether two readings of the same thread say the same thing.
 *
 * `config` is compared as text because it is a small object of small values
 * and this runs once per thread per refresh — a few hundred microseconds for
 * the whole library, against the alternative of re-rendering it.
 */
function unchanged(before: Thread, after: Thread): boolean {
  return (
    before.title === after.title &&
    before.updatedAt === after.updatedAt &&
    before.createdAt === after.createdAt &&
    before.pinned === after.pinned &&
    before.archived === after.archived &&
    before.folderId === after.folderId &&
    before.temporary === after.temporary &&
    before.messageCount === after.messageCount &&
    (before.config === after.config ||
      JSON.stringify(before.config) === JSON.stringify(after.config))
  )
}

/**
 * The new list, holding on to every object that did not actually change.
 *
 * Almost everything asks for the whole list again: a rename, a new thread, a
 * name arriving from the model, a folder being dragged into, every sync. The
 * list *is* the sidebar, and to a memoised row a new object means a changed
 * row — so a library of several hundred conversations re-rendered all of them
 * every time one of them moved. Comparing a few thousand fields is orders of
 * magnitude cheaper than rebuilding a few thousand DOM nodes.
 *
 * When nothing at all moved the previous array is returned unchanged, so the
 * sidebar does not re-render either.
 */
function reconcile(current: Thread[], incoming: Thread[]): Thread[] {
  const held = new Map(current.map((thread) => [thread.id, thread]))
  let moved = current.length !== incoming.length

  const next = incoming.map((thread, at) => {
    const before = held.get(thread.id)
    if (!before || !unchanged(before, thread)) {
      moved = true
      return thread
    }
    // The same rows in a different order is still a change to the list.
    if (current[at] !== before) moved = true
    return before
  })

  return moved ? next : current
}

/* ------------------------------------------------------------------ *
 * Where each conversation was left
 * ------------------------------------------------------------------ */

/**
 * A thread reopens where you were reading it, not at some place that depends
 * on how fast the highlighting finished.
 *
 * Two halves, and both are needed. The offset alone is meaningless, because a
 * thread opens with only the end of itself read in — an offset measured
 * against six pages of conversation means nothing against one. So the range
 * that was loaded is remembered with it, and reading the thread back in starts
 * from there.
 *
 * Held for the session rather than written down. Where you were in a
 * conversation an hour ago is a fact about that sitting; a thread that has
 * been replied to since has moved on, and opening it at the end is then the
 * honest answer. Not reactive on purpose — nothing renders differently because
 * of it, the transcript just reads it as it restores.
 */
export interface Place {
  /** The range that was read in, so the same part of it comes back. */
  startSeq: number | null
  scrollTop: number
  /**
   * Remembered separately from the offset because it is the thing that has to
   * survive the conversation changing height. "1,482 pixels down" stops being
   * the bottom the moment a code block finishes highlighting; "at the end"
   * never does.
   */
  atBottom: boolean
  /**
   * The message that was at the top of the window, and how far into it.
   *
   * The offset above has the same weakness "at the end" was invented to avoid:
   * it is a number of pixels, and a number of pixels stops describing anywhere
   * the moment the content above it changes height — which on returning to a
   * thread it always has, because nothing has been highlighted or measured
   * yet. Restoring by pixels landed short, and short of a long conversation is
   * its end.
   *
   * A message cannot drift. Null for a view with no message at its top, which
   * is a view with nothing in it.
   */
  topMessageId: string | null
  /** Where that message's top sat relative to the window's, usually negative. */
  topOffset: number
}

const places = new Map<string, Place>()

export function rememberPlace(threadId: string, place: Place): void {
  places.set(threadId, place)
}

export function placeOf(threadId: string): Place | null {
  return places.get(threadId) ?? null
}

/**
 * Whether this chat may still be made temporary.
 *
 * The same question the main process settles for real in `makeThreadTemporary`
 * — repeated here so the offer is not made where it would be refused. A chat
 * that has been named, pinned, filed, archived or spoken in is one something
 * has been done to, and the choice to leave no trace is one taken before doing
 * anything rather than after.
 */
export function canBecomeTemporary(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread &&
      !thread.temporary &&
      !thread.title &&
      !thread.pinned &&
      !thread.archived &&
      !thread.folderId &&
      thread.messageCount === 0
  )
}

/** For a thread that is gone, or whose transcript is no longer the one left. */
export function forgetPlace(threadId: string): void {
  places.delete(threadId)
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Guards against subscribing to the main process more than once.
 *
 * React's StrictMode invokes effects twice, and any future remount would do the
 * same. Two listeners means every streamed delta is applied twice — replies
 * come out as "11.. Install Install via via" — and every turn paints a
 * duplicate placeholder.
 */
let initialised = false
const unsubscribers: (() => void)[] = []

export function disposeStore(): void {
  while (unsubscribers.length) unsubscribers.pop()?.()
  // The live-figures ticker holds the setter it was started with, so leaving it
  // running would keep a torn-down store alive and writing into it.
  if (statsTicker) {
    clearInterval(statsTicker)
    statsTicker = null
  }
  emitted.clear()
  threadOfMessage.clear()
  initialised = false
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  settings: null,
  models: [],
  threads: [],
  folders: [],
  openFolderIds: [],
  draggingThreadId: null,
  activeThreadId: null,
  messages: [],
  messageWindowStart: null,
  hasOlderMessages: false,
  loadingOlder: false,
  threadTotals: null,
  generating: false,
  compacting: false,
  mcpStatuses: [],
  overlay: null,
  overlayReturnTo: null,
  settingsTab: null,
  sidebarVisible: true,
  sidebarFilter: '',
  searchHits: [],
  searchSeed: '',
  visibleThreadIds: [],
  pendingApproval: null,
  toast: null,
  dialog: null,
  generatingThreadIds: [],
  namingFinished: new Set<string>(),
  liveStats: {},
  highlightMessageId: null,
  editingMessageId: null,
  renaming: null,
  imageViewer: null,
  sync: null,
  syncProgress: null,

  async init() {
    if (initialised) return
    initialised = true

    const [settings, threads, folders, mcpStatuses] = await Promise.all([
      api.settings.get(),
      api.threads.list(),
      api.folders.list(),
      api.mcp.statuses()
    ])

    set({ settings, threads, folders, mcpStatuses, ready: true })

    /*
     * A blank chat to start in, rather than whatever was open last.
     *
     * This opened `threads[0]`, which is the list's own order — pinned first,
     * then most recently touched — so starting the app dropped you into the
     * middle of a conversation you were not thinking about, scrolled to
     * something you last said at some point you no longer remember. Nothing
     * about launching an app says "carry on with that"; it usually means there
     * is a new thing to ask.
     *
     * Nothing accumulates from this. An empty, unnamed, unpinned, unfiled
     * thread is deleted the moment you leave it, and `deleteEmptyThreads`
     * sweeps up the one left open when the window was closed — both of which
     * already existed for the New Thread button, which has always worked this
     * way.
     */
    await get().createThread()

    unsubscribers.push(api.mcp.onStatus((statuses) => set({ mcpStatuses: statuses })))
    unsubscribers.push(api.chat.onEvent((event) => handleStreamEvent(event, set, get)))

    // A sync that brought something in has changed the library underneath the
    // window: the list, the open thread and the settings all have to catch up,
    // which is the whole of what "seamless" means here.
    void get().refreshSync()

    unsubscribers.push(
      api.sync.onState((state) => set({ sync: state, syncProgress: state.running ? get().syncProgress : null }))
    )
    unsubscribers.push(api.sync.onProgress((progress) => set({ syncProgress: progress })))

    unsubscribers.push(
      api.sync.onChanged(() => {
        void (async () => {
          await get().refreshSettings()
          await get().refreshThreads()
          /*
           * Re-read in place rather than reopened.
           *
           * This asked `selectThread` for the thread already open, which was a
           * way of saying "read that again" and has stopped being one. It is
           * also the more careful thing: a sync that brought in a message
           * should add it to what is on screen, not throw the screen away and
           * rebuild it from wherever the range happens to start.
           */
          if (get().activeThreadId) await get().refreshTranscript()
        })()
      })
    )

    // The catalogue is cached on disk; refreshing in the background keeps the
    // first paint instant.
    get()
      .refreshModels()
      .catch(() => undefined)
  },

  async refreshThreads() {
    set({ threads: reconcile(get().threads, await api.threads.list()) })
  },

  async refreshSettings() {
    const settings = await api.settings.get()
    set({ settings })
    return settings
  },

  async selectThread(id) {
    // Two reasons a thread does not survive being left.
    //
    // A thread is created the moment the button is pressed, so leaving one
    // without saying anything is the most ordinary thing in the app — and it
    // leaves an "Untitled thread" in the list forever. Anything named, pinned,
    // filed, spoken in, or still generating is left exactly where it is.
    //
    // A temporary chat goes whatever is in it: that is what was asked for when
    // it was started, and "until you go elsewhere" is only a promise if a reply
    // still arriving does not extend it. The main process stops the generation
    // as part of the delete, so leaving mid-reply ends the reply.
    const leaving = get().activeThreadId
    const thread =
      leaving && leaving !== id ? (get().threads.find((t) => t.id === leaving) ?? null) : null

    if (thread) {
      const abandoned =
        !get().generating &&
        !get().messages.length &&
        !thread.title &&
        thread.messageCount === 0 &&
        !thread.pinned &&
        !thread.folderId

      if (thread.temporary || abandoned) {
        set({ threads: get().threads.filter((t) => t.id !== thread.id) })
        forgetPlace(thread.id)
        void window.deepPink.threads.remove(thread.id)
      }
    }

    if (!id) {
      set({
        activeThreadId: null,
        messages: [],
        messageWindowStart: null,
        hasOlderMessages: false,
        threadTotals: null,
        generating: false
      })
      return
    }

    // Set before the transcript is read, not after.
    //
    // Waiting meant two things: the sidebar highlight lagged the keypress, and
    // — because the next keypress computed its move from `activeThreadId` —
    // holding Alt+Down moved one thread rather than several, every press after
    // the first stepping from the same stale place. The old messages stay on
    // screen for the few milliseconds the read takes; blanking them flashes the
    // empty state instead, which is worse.
    /*
     * Opening the thread you are already in does nothing.
     *
     * It used to re-read the transcript and replace every message with a fresh
     * copy — into a range that need not be the one on screen, under a scroll
     * offset measured against the old one. And because `activeThreadId` had
     * not changed, the transcript was never told to put the reader back, so
     * the view simply landed wherever the new content happened to reach.
     * Clicking the row you are on threw away your place in the conversation.
     *
     * Nothing needs re-reading here anyway: this thread is the one receiving
     * live events. What did rely on this — a sync that brought something in —
     * asks for a refresh in place instead, which is the thing it actually
     * wanted.
     */
    if (get().activeThreadId === id) return

    set({ activeThreadId: id, highlightMessageId: null, editingMessageId: null, renaming: null })

    // The end of the conversation, not all of it. The rest arrives as it is
    // scrolled towards, and the totals come from the database because the sum
    // of what happens to be on screen is not what the thread cost.
    //
    // One crossing rather than four: these were separate calls awaited
    // together, which is four round trips for the thing people do most often.
    //
    // Reading back from where this thread was last left, when it was left
    // somewhere — otherwise from the end, which is where a conversation is.
    //
    // "At the end" is not somewhere: a reader who scrolled to the top of a
    // long thread and then came back down does not want the whole of it read
    // in again every time they open it, and the range they happened to have
    // loaded on the way is beside the point. The range is only worth restoring
    // when the offset into it is.
    const place = placeOf(id)
    const { page, totals, generating, live } = await api.messages.open(
      id,
      pageSize(get),
      place && !place.atBottom ? place.startSeq : null
    )
    const messages = page.messages

    // Something else was selected while this was loading; that one wins.
    if (get().activeThreadId !== id) return

    // A reply may have been arriving while this thread was not on screen. The
    // stored row only catches up periodically, so take the text the main
    // process has accumulated — otherwise the reply resumes mid-sentence.
    const caughtUp = live.length
      ? messages.map((message) => {
          const stream = live.find((s) => s.messageId === message.id)
          if (!stream) return message
          return {
            ...message,
            content: stream.content || message.content,
            reasoning: stream.reasoning || message.reasoning,
            status: 'streaming' as const
          }
        })
      : messages

    set({
      activeThreadId: id,
      messages: caughtUp,
      messageWindowStart: page.startSeq,
      hasOlderMessages: page.hasOlder,
      loadingOlder: false,
      threadTotals: totals,
      generating
    })

    // Deltas that arrived while the above was loading were dropped, because the
    // thread was not on screen to receive them. The buffer holds the whole text
    // rather than increments, so one more pass is enough to close that gap and
    // is harmless if nothing changed.
    if (live.length) {
      const settled = await api.chat.liveStreams(id)
      if (get().activeThreadId !== id) return
      set({
        messages: get().messages.map((message) => {
          const stream = settled.find((s) => s.messageId === message.id)
          if (!stream || stream.content.length <= message.content.length) return message
          return { ...message, content: stream.content, reasoning: stream.reasoning || message.reasoning }
        })
      })
    }
  },

  async findKeyPoint(messageId, reply, candidates) {
    /*
     * The question this reply answered, found here rather than passed in.
     *
     * Which sentence matters is not a property of the reply. Marking the key
     * points of an answer without knowing what was asked means marking what
     * the answer emphasises, and an answer emphasises its own structure — so
     * a reply to five questions came back with seven marks and a reply to one
     * came back with the sentence that set it up. The store already holds the
     * turn this reply belongs to; nothing had to be plumbed for it.
     *
     * The nearest user message above, which is the turn: a retry or an edit
     * leaves the assistant message in place under the same question.
     */
    const at = get().messages.findIndex((m) => m.id === messageId)
    let question = ''
    for (let above = at - 1; above >= 0; above--) {
      const message = get().messages[above]
      if (message.role === 'user') {
        question = message.content
        break
      }
      // Past another assistant turn is a different question, and a wrong
      // question is worse than none: it renames what the reply is about.
      if (message.role === 'assistant') break
    }

    const found = await api.messages.keyPoint(messageId, question, reply, candidates)
    // Written onto the message rather than held aside, so they travel with it
    // through every re-read of the transcript.
    set({
      messages: patchMessage(get().messages, messageId, (m) => ({
        ...m,
        keyPoints: found?.texts ?? []
      }))
    })
  },

  async refreshTranscript() {
    const threadId = get().activeThreadId
    if (!threadId) return
    const page = await readWindow(threadId, get)
    if (!page) return
    set({
      messages: page.messages,
      messageWindowStart: page.startSeq,
      hasOlderMessages: page.hasOlder
    })
    await get().refreshTotals()
  },

  async resetTranscript() {
    const threadId = get().activeThreadId
    if (!threadId) return
    // Compaction replaces the older part of the thread, so a remembered range
    // now describes messages that are not there any more.
    forgetPlace(threadId)
    const [page, totals] = await Promise.all([
      api.messages.page(threadId, pageSize(get), null),
      api.messages.totals(threadId)
    ])
    if (get().activeThreadId !== threadId) return
    set({
      messages: page.messages,
      messageWindowStart: page.startSeq,
      hasOlderMessages: page.hasOlder,
      loadingOlder: false,
      threadTotals: totals
    })
  },

  async refreshTotals() {
    const threadId = get().activeThreadId
    if (!threadId) return
    const totals = await api.messages.totals(threadId)
    if (get().activeThreadId === threadId) set({ threadTotals: totals })
  },

  async revealMessage(threadId, messageId) {
    await get().selectThread(threadId)
    if (get().activeThreadId !== threadId) return

    // A hit can be anywhere in a conversation, and what a thread opens with is
    // the end of one. Highlighting a message that was never read in would look
    // exactly like the search having found nothing.
    if (!get().messages.some((m) => m.id === messageId)) {
      const page = await api.messages.including(threadId, messageId)
      if (get().activeThreadId !== threadId) return
      set({
        messages: page.messages,
        messageWindowStart: page.startSeq,
        hasOlderMessages: page.hasOlder,
        loadingOlder: false
      })
    }

    get().setHighlight(messageId)
  },

  async loadOlderMessages() {
    const threadId = get().activeThreadId
    const from = get().messageWindowStart
    if (!threadId || !get().hasOlderMessages || get().loadingOlder) return false

    set({ loadingOlder: true })
    try {
      const page = await api.messages.page(threadId, pageSize(get), from)

      // Somebody opened another thread, or the window moved underneath this
      // request. Either way the page in hand belongs somewhere else, and
      // prepending it would splice one conversation into another.
      if (get().activeThreadId !== threadId || get().messageWindowStart !== from) return false

      if (!page.messages.length) {
        set({ hasOlderMessages: false })
        return false
      }

      set({
        messages: [...page.messages, ...get().messages],
        messageWindowStart: page.startSeq,
        hasOlderMessages: page.hasOlder
      })
      return true
    } catch {
      // A page that would not load is not worth an error in front of the
      // reader: the conversation on screen is unharmed, and scrolling asks
      // again a moment later.
      return false
    } finally {
      set({ loadingOlder: false })
    }
  },

  async createThread() {
    const thread = await api.threads.create()
    await get().refreshThreads()
    await get().selectThread(thread.id)
    return thread
  },

  async keepThread(id) {
    const kept = await window.deepPink.threads.keep(id)
    if (!kept) return
    set({ threads: get().threads.map((t) => (t.id === id ? kept : t)) })
    await get().refreshThreads()
  },

  async makeThreadTemporary(id) {
    const made = await window.deepPink.threads.makeTemporary(id)
    // Refused: the thread has been spoken in. The caller says so; there is
    // nothing to change here.
    if (!made) return false
    set({ threads: get().threads.map((t) => (t.id === id ? made : t)) })
    await get().refreshThreads()
    return true
  },

  async deleteThread(id) {
    forgetPlace(id)
    await api.threads.remove(id)
    const remaining = get().threads.filter((t) => t.id !== id)
    set({ threads: remaining })
    if (get().activeThreadId === id) {
      await get().selectThread(remaining[0]?.id ?? null)
    }
  },

  async updateThread(id, patch) {
    const updated = await api.threads.update(id, patch)
    if (!updated) return
    set({ threads: get().threads.map((t) => (t.id === id ? updated : t)) })
    await get().refreshThreads()
  },

  async retitleThread(id) {
    const title = await window.deepPink.chat.retitle(id)
    await get().refreshThreads()
    get().showToast(title ? `Renamed to “${title}”` : 'Could not generate a name')
  },

  async refreshFolders() {
    set({ folders: await api.folders.list() })
  },

  async createFolder(name) {
    const folder = await api.folders.create(name)
    if (!folder) return null
    // Opened on creation: a new folder is empty, and an empty closed folder
    // gives no sign that the thing you just asked for exists.
    set({ folders: [...get().folders, folder], openFolderIds: [...get().openFolderIds, folder.id] })
    return folder
  },

  async renameFolder(id, name) {
    const updated = await api.folders.update(id, { name })
    if (!updated) return
    set({ folders: get().folders.map((f) => (f.id === id ? updated : f)) })
  },

  async deleteFolder(id) {
    await api.folders.remove(id)
    set({
      folders: get().folders.filter((f) => f.id !== id),
      openFolderIds: get().openFolderIds.filter((open) => open !== id)
    })
    // The threads it held are still there, now carrying no folder.
    await get().refreshThreads()
  },

  async setFolderPinned(id, pinned) {
    const updated = await api.folders.update(id, { pinned })
    if (!updated) return
    set({ folders: get().folders.map((f) => (f.id === id ? updated : f)) })
  },

  toggleFolder(id) {
    const open = get().openFolderIds
    set({ openFolderIds: open.includes(id) ? open.filter((f) => f !== id) : [...open, id] })
  },

  closeAllFolders() {
    if (get().openFolderIds.length) set({ openFolderIds: [] })
  },

  async moveThreadToFolder(threadId, folderId) {
    const current = get().threads.find((t) => t.id === threadId)
    if (!current || current.folderId === folderId) return

    // Painted before the round trip: a drag has already shown the user where
    // the row is going, and waiting to move it makes the drop look refused.
    set({
      threads: get().threads.map((t) => (t.id === threadId ? { ...t, folderId } : t)),
      // Dropping into a shut folder opens it, so the thread is not seen to
      // vanish on being filed.
      openFolderIds:
        folderId && !get().openFolderIds.includes(folderId)
          ? [...get().openFolderIds, folderId]
          : get().openFolderIds
    })

    const updated = await api.threads.setFolder(threadId, folderId)
    if (!updated) {
      // The folder went away underneath the drag; take the list from the database.
      await get().refreshThreads()
      return
    }
    set({ threads: get().threads.map((t) => (t.id === threadId ? updated : t)) })
  },

  setDraggingThread(threadId) {
    set({ draggingThreadId: threadId })
  },

  async send(content, pending = []) {
    let threadId = get().activeThreadId
    if (!threadId) {
      const thread = await get().createThread()
      threadId = thread.id
    }

    // Paint the user's message immediately rather than waiting on the round trip.
    const optimistic: Message = {
      id: `optimistic-${Date.now()}`,
      threadId,
      role: 'user',
      content,
      reasoning: null,
      reasoningChars: 0,
      createdAt: Date.now(),
      model: null,
      provider: null,
      status: 'complete',
      error: null,
      toolCalls: null,
      toolResult: null,
      systemPromptSnapshot: null,
      hasPromptSnapshot: false,
      keyPoints: [],
      isCompactionSummary: false,
      compactedInto: null,
      usage: null,
      attachments: []
    }
    set({ messages: [...get().messages, optimistic], generating: true })

    await api.chat.send({ threadId, content, attachments: pending })
    await get().refreshThreads()
  },

  async resendFrom(messageId) {
    const threadId = get().activeThreadId
    if (!threadId) return

    const index = get().messages.findIndex((m) => m.id === messageId)
    if (index < 0) return

    // Everything after it goes, here as well as on disk — the engine drops the
    // same range from `regenerateFromMessageId`, and doing it here too means
    // the answer being replaced leaves the moment you ask rather than when the
    // first token of its replacement arrives.
    set({ messages: get().messages.slice(0, index + 1), generating: true })
    await api.chat.send({ threadId, content: '', regenerateFromMessageId: messageId })
  },

  async regenerate(messageId) {
    const threadId = get().activeThreadId
    if (!threadId) return

    const index = get().messages.findIndex((m) => m.id === messageId)
    if (index < 0) return

    // Drop everything from the regenerated message onward, then re-run the turn
    // from the message just before it.
    const previous = get().messages[index - 1]
    if (!previous) return

    set({ messages: get().messages.slice(0, index), generating: true })
    await api.chat.send({ threadId, content: '', regenerateFromMessageId: previous.id })
  },

  async abort() {
    const threadId = get().activeThreadId
    if (!threadId) return
    await api.chat.abort(threadId)
    set({ generating: false })
  },

  async compact() {
    const threadId = get().activeThreadId
    if (!threadId) return
    set({ compacting: true })
    try {
      const result = await api.chat.compact(threadId)
      // Read fresh from the end rather than re-reading the window: compaction
      // replaces the older part of the thread with a summary that sits *before*
      // what was on screen, so the range that was loaded no longer describes
      // anything a reader would recognise.
      await get().resetTranscript()
      get().showToast(
        result
          ? `Compacted — about ${result.freedTokens.toLocaleString()} tokens freed`
          : 'Nothing to compact yet'
      )
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      set({ compacting: false })
    }
  },

  async saveSettings(patch) {
    set({ settings: await api.settings.save(patch) })
  },

  async refreshModels(force = false) {
    try {
      set({ models: await api.models.list(force) })
    } catch {
      /* offline or no key yet — the cached catalogue is enough */
    }
  },

  setVisibleThreads(ids) {
    const current = get().visibleThreadIds
    if (current.length === ids.length && current.every((id, i) => id === ids[i])) return
    set({ visibleThreadIds: ids })
  },

  stepThread(delta) {
    // What the sidebar is showing, or — when it is hidden — the underlying
    // list, so the keys still do something sensible.
    const visible = get().visibleThreadIds
    const order = visible.length ? visible : get().threads.map((t) => t.id)
    if (!order.length) return

    const index = order.indexOf(get().activeThreadId ?? '')
    if (index < 0) {
      void get().selectThread(delta > 0 ? order[0] : order[order.length - 1])
      return
    }

    // Stop at the ends rather than re-selecting where you already are, which
    // would reload the thread for nothing.
    const next = order[index + delta]
    if (next) void get().selectThread(next)
  },

  async runSearch(query) {
    if (!query.trim()) {
      set({ searchHits: [] })
      return
    }
    set({ searchHits: await api.search.query(query) })
  },

  setOverlay(overlay, returnTo = null) {
    // Opening search any other way starts empty, rather than with whatever
    // seeded it last time.
    set({ overlay, overlayReturnTo: returnTo, ...(overlay === 'search' ? { searchSeed: '' } : {}) })
  },

  openSettings(tab) {
    // Without a section in mind, whatever was last open stays open.
    set({ overlay: 'settings', overlayReturnTo: null, ...(tab ? { settingsTab: tab } : {}) })
  },

  setSettingsTab(tab) {
    set({ settingsTab: tab })
  },

  openSearch(query = '') {
    set({ overlay: 'search', overlayReturnTo: null, searchSeed: query })
  },

  closeOverlay() {
    const back = get().overlayReturnTo
    set({ overlay: back, overlayReturnTo: null })
  },

  setSidebarFilter(value) {
    set({ sidebarFilter: value })
  },

  toggleSidebar() {
    set({ sidebarVisible: !get().sidebarVisible })
  },

  showToast(message, tone = 'info') {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: { message, tone } })
    toastTimer = setTimeout(() => set({ toast: null }), 4000)
  },

  async approveTool(approved) {
    const pending = get().pendingApproval
    if (!pending) return
    set({ pendingApproval: null })
    await api.chat.approveTool(pending.toolCall.id, approved)
  },

  setHighlight(messageId) {
    set({ highlightMessageId: messageId })
  },

  editMessage(messageId) {
    set({ editingMessageId: messageId })
  },

  startRename(target) {
    set({ renaming: target })
  },

  openImageViewer(images, id) {
    const index = images.findIndex((image) => image.id === id)
    if (index < 0) return
    set({ imageViewer: { images, index } })

    // Opened on what is on screen, so it appears in the same frame as the
    // click, and then widened to every picture in the thread. The arrow keys
    // promise all of them, which stopped being the same thing as "all of them
    // in the transcript" when the transcript started arriving a page at a time.
    const threadId = get().activeThreadId
    if (!threadId) return
    void api.attachments.images(threadId).then((all) => {
      const at = all.findIndex((image) => image.id === id)
      const viewer = get().imageViewer
      // Closed, or stepped on to another picture, while this was arriving.
      if (at < 0 || !viewer || viewer.images[viewer.index]?.id !== id) return
      set({ imageViewer: { images: all, index: at } })
    })
  },

  closeImageViewer() {
    set({ imageViewer: null })
  },

  async refreshSync() {
    const state = await api.sync.state()
    set({ sync: state })
    return state
  },

  async pauseSync(until) {
    set({ sync: await api.sync.pause(until) })
    get().showToast(
      until === null
        ? 'Syncing paused'
        : `Syncing paused until ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    )
  },

  async resumeSync() {
    set({ sync: await api.sync.resume() })
    get().showToast('Syncing resumed')
  },

  async runSync() {
    const result = await api.sync.run()
    await get().refreshSync()
    if (result.error) {
      get().showToast(result.error, 'error')
      return
    }
    get().showToast(
      result.pushed === 0 && result.pulled === 0 && result.deleted === 0
        ? 'Already up to date'
        : `Sent ${result.pushed}, received ${result.pulled}` +
            (result.deleted ? `, removed ${result.deleted}` : '')
    )
  },

  stepImageViewer(delta) {
    const viewer = get().imageViewer
    if (!viewer || viewer.images.length < 2) return
    const count = viewer.images.length
    set({
      imageViewer: { ...viewer, index: (viewer.index + delta + count) % count }
    })
  },

  askConfirm(options) {
    return new Promise<boolean>((resolve) => {
      set({
        dialog: {
          kind: 'confirm',
          title: options.title,
          body: options.body,
          confirmLabel: options.confirmLabel ?? 'Confirm',
          cancelLabel: options.cancelLabel ?? 'Cancel',
          danger: options.danger ?? false,
          defaultValue: '',
          resolve: (value) => resolve(value !== null)
        }
      })
    })
  },

  askPrompt(options) {
    return new Promise<string | null>((resolve) => {
      set({
        dialog: {
          kind: 'prompt',
          title: options.title,
          body: options.body,
          confirmLabel: options.confirmLabel ?? 'Save',
          cancelLabel: 'Cancel',
          danger: false,
          defaultValue: options.defaultValue ?? '',
          placeholder: options.placeholder,
          resolve
        }
      })
    })
  },

  resolveDialog(value) {
    const pending = get().dialog
    set({ dialog: null })
    pending?.resolve(value)
  }
}))

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

type Setter = (partial: Partial<State> | ((state: State) => Partial<State>)) => void
type Getter = () => State

function patchMessage(
  messages: Message[],
  id: string,
  patch: (message: Message) => Message
): Message[] {
  return messages.map((m) => (m.id === id ? patch(m) : m))
}

/**
 * Reconciles the stored transcript with what is currently on screen.
 *
 * The database is authoritative for which messages exist and in what order.
 * The only thing it does not have is the text of a reply still arriving, which
 * is held in memory until the turn completes — so that is layered back on top.
 */
function mergeStreamed(persisted: Message[], onScreen: Message[]): Message[] {
  const live = new Map(onScreen.map((m) => [m.id, m]))

  return persisted.map((stored) => {
    const painted = live.get(stored.id)
    if (!painted || painted.status !== 'streaming') return stored
    return {
      ...stored,
      content: painted.content || stored.content,
      reasoning: painted.reasoning ?? stored.reasoning,
      status: 'streaming',
      usage: stored.usage ?? painted.usage
    }
  })
}

/**
 * Which thread a turn belongs to, learned when it starts.
 *
 * Only `start` and `aborted` name their thread; `done` carries it inside the
 * message it finished, and `error` carries nothing but a message id. So the
 * pairing is remembered as the turn begins and looked up as it ends, which is
 * the only way the list can be told a background reply has stopped.
 */
const threadOfMessage = new Map<string, string>()

/**
 * What each working thread has emitted, counted as it arrives.
 *
 * Kept outside the store on purpose: this is written on every delta, and the
 * store is what the sidebar watches. The ticker below is what moves it across.
 *
 * Characters rather than tokens, because nobody knows the token count until
 * the turn ends and the provider reports it — the app's own four-characters-
 * to-a-token estimate is used everywhere else a number is needed before then,
 * and using a different one here would make two parts of the window disagree.
 */
const emitted = new Map<string, { chars: number; startedAt: number }>()

/** The app's estimate, and the same one the reasoning trace's chip uses. */
const CHARS_PER_TOKEN = 4

let statsTicker: ReturnType<typeof setInterval> | null = null

/**
 * Moves the counts into the store four times a second while anything is
 * working, and stops as soon as nothing is.
 *
 * Four is enough that the number reads as live and slow enough that the list
 * is not re-rendering under a reply arriving at sixty chunks a second.
 */
function runStatsTicker(set: Setter, get: Getter): void {
  if (statsTicker) return
  statsTicker = setInterval(() => {
    if (!emitted.size) {
      clearInterval(statsTicker as ReturnType<typeof setInterval>)
      statsTicker = null
      if (Object.keys(get().liveStats).length) set({ liveStats: {} })
      return
    }

    const next: Record<string, { tokens: number; perSecond: number }> = {}
    for (const [threadId, run] of emitted) {
      const seconds = Math.max((Date.now() - run.startedAt) / 1000, 0.001)
      const tokens = Math.round(run.chars / CHARS_PER_TOKEN)
      next[threadId] = { tokens, perSecond: tokens / seconds }
    }
    set({ liveStats: next })
  }, 250)
}

/**
 * How often the sidebar checks its own story against the main process.
 *
 * Only while it believes something is happening, so an idle app asks nothing.
 * Four seconds is far below noticing and far above the cost: it is one
 * synchronous read of a map.
 */
const RECONCILE_EVERY = 4000

let reconciler: ReturnType<typeof setInterval> | null = null

/**
 * Drops threads the main process is not actually working on.
 *
 * The set above is assembled from events, and an assembled set can be wrong in
 * one direction permanently: a turn whose ending was never announced, or was
 * announced in a way that could not be matched to a thread, leaves a row
 * claiming a reply is still coming and a name still on its way. Every one of
 * those was reachable — measured by driving the store with the sequences the
 * engine can actually produce — and no amount of care at the emitting end
 * makes the class of bug go away, because the renderer cannot know about an
 * event that never arrives.
 *
 * So it asks. Removals only: a turn that has just started may not have
 * reached this window's notion of it yet, and the controller is registered
 * before the first event goes out, so anything genuinely running is in the
 * answer.
 */
function runReconciler(set: Setter, get: Getter): void {
  if (reconciler) return
  reconciler = setInterval(() => {
    const believed = get().generatingThreadIds
    if (!believed.length) {
      clearInterval(reconciler as ReturnType<typeof setInterval>)
      reconciler = null
      return
    }
    void api.chat.generating().then((actually) => {
      const real = new Set(actually)
      const kept = get().generatingThreadIds.filter((id) => real.has(id))
      if (kept.length === get().generatingThreadIds.length) return
      set({ generatingThreadIds: kept })
      // Whatever was stranded is not producing tokens either.
      for (const id of get().liveStats ? Object.keys(get().liveStats) : []) {
        if (!real.has(id)) emitted.delete(id)
      }
    })
  }, RECONCILE_EVERY)
}

/** Counts what a delta added, wherever it is going. */
function countDelta(event: StreamEvent, set: Setter, get: Getter): void {
  if (event.type !== 'content' && event.type !== 'reasoning') return
  const threadId = threadOfMessage.get(event.messageId)
  if (!threadId) return

  const run = emitted.get(threadId)
  // Reasoning counts: it is tokens the model produced and tokens you paid for,
  // even though none of it is the answer.
  if (run) run.chars += event.delta.length
  else emitted.set(threadId, { chars: event.delta.length, startedAt: Date.now() })
  runStatsTicker(set, get)
}

/**
 * Keeps the set of working threads current, whichever thread is on screen.
 *
 * Deliberately above the relevance filter below: that filter exists to stop
 * another conversation painting into this one, and it drops exactly the events
 * the sidebar is waiting for.
 */
function trackGenerating(event: StreamEvent, set: Setter, get: Getter): void {
  const working = (threadId: string, yes: boolean): void => {
    const current = get().generatingThreadIds
    const has = current.includes(threadId)
    if (has === yes) return
    set({
      generatingThreadIds: yes
        ? [...current, threadId]
        : current.filter((id) => id !== threadId)
    })
  }

  switch (event.type) {
    case 'start':
      threadOfMessage.set(event.messageId, event.threadId)
      // A retry reuses the row, so the count starts again with it.
      emitted.set(event.threadId, { chars: 0, startedAt: Date.now() })
      working(event.threadId, true)
      runStatsTicker(set, get)
      runReconciler(set, get)
      /*
       * The list learns about the turn as it starts, not as it ends.
       *
       * `send` awaits the whole turn before refreshing — it is one IPC call
       * that returns when the reply is finished — so for the entire time a
       * reply is arriving the sidebar still believed the thread was empty.
       * Everything the row wants to say in that window depends on knowing
       * otherwise: that it has messages at all, which is what tells the title
       * a name is coming rather than absent, and where it belongs in an order
       * sorted by when it was last touched.
       */
      void get().refreshThreads()
      break
    case 'done': {
      threadOfMessage.delete(event.messageId)
      // The thread it names, or the one it was started under. A `done` whose
      // message has gone — deleted mid-turn, or a thread swept from under it —
      // used to throw here, which left the row believing a reply was still on
      // its way and stopped everything below this line from running.
      const threadId = event.message?.threadId ?? threadOfMessage.get(event.messageId)
      if (!threadId) break
      emitted.delete(threadId)
      working(threadId, false)
      break
    }
    case 'aborted':
      threadOfMessage.delete(event.messageId)
      emitted.delete(event.threadId)
      working(event.threadId, false)
      break
    case 'error': {
      // What it says first, and only then what was remembered about it. An
      // error the renderer could not place used to be an error it ignored,
      // and ignoring it is how a row gets stuck saying a reply is arriving.
      const threadId = event.threadId ?? (event.messageId ? threadOfMessage.get(event.messageId) : undefined)
      if (!threadId) break
      threadOfMessage.delete(event.messageId)
      emitted.delete(threadId)
      working(threadId, false)
      break
    }
  }
}

function handleStreamEvent(event: StreamEvent, set: Setter, get: Getter): void {
  trackGenerating(event, set, get)
  countDelta(event, set, get)

  const state = get()

  if (event.type === 'title') {
    /*
     * A null title is naming saying it has finished and produced nothing.
     *
     * Recorded rather than acted on, because there is nothing to write: the
     * thread keeps no name and reads as "Untitled thread". What it ends is
     * the shimmer in the sidebar, which otherwise runs on a two-minute clock
     * because nothing ever told it the answer had already come back.
     */
    if (event.title === null) {
      set({ namingFinished: new Set(get().namingFinished).add(event.threadId) })
      return
    }
    void get().refreshThreads()
    return
  }

  // Threads can generate concurrently, so an event only applies here if it
  // names this thread or a message already on screen. A message-less error is
  // a failure of the request itself and always surfaces.
  const relevant =
    'threadId' in event
      ? event.threadId === state.activeThreadId
      : event.type === 'error' && !event.messageId
        ? true
        : state.messages.some((m) => m.id === event.messageId)

  if (!relevant) return

  switch (event.type) {
    case 'start': {
      // Never add the same turn twice, however many times this fires.
      if (state.messages.some((m) => m.id === event.messageId)) {
        set({ generating: true })
        break
      }

      const placeholder: Message = {
        id: event.messageId,
        threadId: event.threadId,
        role: 'assistant',
        content: '',
        reasoning: null,
      reasoningChars: 0,
        createdAt: Date.now(),
        model: null,
        provider: null,
        status: 'streaming',
        error: null,
        toolCalls: null,
        toolResult: null,
        systemPromptSnapshot: null,
      hasPromptSnapshot: false,
        keyPoints: [],
      isCompactionSummary: false,
        compactedInto: null,
        usage: null,
        attachments: []
      }
      // Drop the optimistic echo of the user's message; the real row is on disk.
      set({
        generating: true,
        messages: [...state.messages.filter((m) => !m.id.startsWith('optimistic-')), placeholder]
      })

      // The main process writes this row before it emits, so the database
      // already knows where the turn belongs. Take its ordering, and keep only
      // the text that exists nowhere else yet — the deltas streamed so far.
      void readWindow(event.threadId, get).then((page) => {
        if (!page) return
        set({
          messages: mergeStreamed(page.messages, get().messages),
          messageWindowStart: page.startSeq,
          hasOlderMessages: page.hasOlder
        })
      })
      break
    }

    case 'aborted':
      // The turn produced nothing and was discarded rather than persisted.
      set({
        generating: false,
        messages: state.messages.filter((m) => m.id !== event.messageId)
      })
      break

    case 'content':
      set({
        messages: patchMessage(state.messages, event.messageId, (m) => ({
          ...m,
          content: m.content + event.delta
        }))
      })
      break

    case 'reasoning':
      set({
        messages: patchMessage(state.messages, event.messageId, (m) => ({
          ...m,
          reasoning: (m.reasoning ?? '') + event.delta
        }))
      })
      break

    case 'tool-call':
      set({
        messages: patchMessage(state.messages, event.messageId, (m) => ({
          ...m,
          toolCalls: event.toolCalls
        }))
      })
      break

    case 'tool-approval-request':
      set({ pendingApproval: { toolCall: event.toolCall, serverName: event.serverName } })
      break

    case 'tool-result':
      if (state.activeThreadId) {
        const threadId = state.activeThreadId
        void readWindow(threadId, get).then((page) => {
          if (!page) return
          set({
            messages: mergeStreamed(page.messages, get().messages),
            messageWindowStart: page.startSeq,
            hasOlderMessages: page.hasOlder
          })
        })
      }
      break

    case 'usage':
      set({
        messages: patchMessage(state.messages, event.messageId, (m) => ({ ...m, usage: event.usage }))
      })
      // The header's total is the thread's, not the sum of what is on screen,
      // so it is asked for again rather than added to.
      void get().refreshTotals()
      break

    case 'done': {
      const merged = patchMessage(state.messages, event.messageId, (m) => ({
        ...event.message,
        // The streamed text is authoritative for what the user already saw.
        content: event.message.content || m.content,
        reasoning: event.message.reasoning ?? m.reasoning,
        usage: event.message.usage ?? m.usage
      }))
      const stillWorking = event.message.toolCalls != null && event.message.toolCalls.length > 0
      set({ messages: merged, generating: stillWorking })
      void get().refreshTotals()
      /*
       * A finished answer may have a sentence worth marking. Only the last
       * round of a turn: a reply that is about to call a tool is not the
       * answer yet, and asking about it would be asking about a fragment.
       */
      const wantsKey = useStore.getState().settings
      if (!stillWorking && wantsKey?.keyPointEnabled && wantsKey.keyPointSource !== 'self') {
        // `self` needs nobody: the sentence arrived with the reply.
        wantKeyPoint(event.messageId)
      }
      break
    }

    case 'error':
      set({
        generating: false,
        messages: event.messageId
          ? patchMessage(state.messages, event.messageId, (m) => ({
              ...m,
              status: 'error',
              error: event.error
            }))
          : state.messages
      })
      get().showToast(event.error, 'error')
      break

    case 'compaction-start':
      set({ compacting: true })
      break

    case 'compaction-done':
      set({ compacting: false })
      // Same reason as `compact()`: what the summary replaced is no longer
      // where the loaded range said it was.
      void get().resetTranscript()
      get().showToast(`Compacted — about ${event.freedTokens.toLocaleString()} tokens freed`)
      break
  }
}
