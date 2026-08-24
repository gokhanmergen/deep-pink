import { create } from 'zustand'
import type {
  Attachment,
  Folder,
  McpServerStatus,
  Message,
  OpenRouterModel,
  SearchHit,
  PendingAttachment,
  Settings,
  SettingsPatch,
  StreamEvent,
  Thread,
  ThreadConfig,
  ToolCall
} from '@shared/types'

export type Overlay =
  | null
  | 'palette'
  | 'search'
  | 'settings'
  | 'models'
  | 'defaultModel'
  | 'titleModel'
  | 'providers'
  | 'prompt'
  | 'threadStats'
  | 'globalStats'
  | 'mcp'
  | 'keybinds'

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
  messages: Message[]
  generating: boolean
  compacting: boolean
  mcpStatuses: McpServerStatus[]
  overlay: Overlay
  /** Where to go when the current overlay closes, e.g. back to Settings. */
  overlayReturnTo: Overlay
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
  /** Message id the transcript should scroll to and flash. */
  highlightMessageId: string | null
  /**
   * The image being looked at, and everything else in the thread it can be
   * stepped through. Held here rather than in the transcript so the viewer
   * outlives the row that opened it — a re-render mid-stream must not close it.
   */
  imageViewer: { images: Attachment[]; index: number } | null

  init: () => Promise<void>
  refreshThreads: () => Promise<void>
  refreshSettings: () => Promise<Settings>
  selectThread: (id: string | null) => Promise<void>
  createThread: () => Promise<Thread>
  deleteThread: (id: string) => Promise<void>
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
  abort: () => Promise<void>
  compact: () => Promise<void>
  saveSettings: (patch: SettingsPatch) => Promise<void>
  refreshModels: (force?: boolean) => Promise<void>
  setVisibleThreads: (ids: string[]) => void
  /** Moves to the thread `delta` places away in the list, as displayed. */
  stepThread: (delta: number) => void
  runSearch: (query: string) => Promise<void>
  setOverlay: (overlay: Overlay, returnTo?: Overlay) => void
  /** Opens the search overlay, optionally with a query already in it. */
  openSearch: (query?: string) => void
  /** Closes the overlay, returning to whatever opened it. */
  closeOverlay: () => void
  setSidebarFilter: (value: string) => void
  toggleSidebar: () => void
  showToast: (message: string, tone?: Toast['tone']) => void
  approveTool: (approved: boolean) => Promise<void>
  setHighlight: (messageId: string | null) => void
  /** Opens the image viewer on `id`, stepping through every image given. */
  openImageViewer: (images: Attachment[], id: string) => void
  closeImageViewer: () => void
  /** Moves to the next image along, wrapping at either end. */
  stepImageViewer: (delta: number) => void
  /** Resolves true if the user confirms. */
  askConfirm: (options: ConfirmOptions) => Promise<boolean>
  /** Resolves the entered text, or null if cancelled. */
  askPrompt: (options: PromptOptions) => Promise<string | null>
  resolveDialog: (value: string | null) => void
}

const api = window.deepPink

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
  generating: false,
  compacting: false,
  mcpStatuses: [],
  overlay: null,
  overlayReturnTo: null,
  sidebarVisible: true,
  sidebarFilter: '',
  searchHits: [],
  searchSeed: '',
  visibleThreadIds: [],
  pendingApproval: null,
  toast: null,
  dialog: null,
  highlightMessageId: null,
  imageViewer: null,

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

    if (threads.length) {
      await get().selectThread(threads[0].id)
    }

    unsubscribers.push(api.mcp.onStatus((statuses) => set({ mcpStatuses: statuses })))
    unsubscribers.push(api.chat.onEvent((event) => handleStreamEvent(event, set, get)))

    // A sync that brought something in has changed the library underneath the
    // window: the list, the open thread and the settings all have to catch up,
    // which is the whole of what "seamless" means here.
    unsubscribers.push(
      api.sync.onChanged(() => {
        void (async () => {
          await get().refreshSettings()
          await get().refreshThreads()
          const active = get().activeThreadId
          if (active) await get().selectThread(active)
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
    set({ threads: await api.threads.list() })
  },

  async refreshSettings() {
    const settings = await api.settings.get()
    set({ settings })
    return settings
  },

  async selectThread(id) {
    // A thread is created the moment the button is pressed, so leaving one
    // without saying anything is the most ordinary thing in the app — and it
    // leaves an "Untitled thread" in the list forever. Anything named, pinned,
    // filed, spoken in, or still generating is left exactly where it is.
    const leaving = get().activeThreadId
    if (leaving && leaving !== id && !get().generating && !get().messages.length) {
      const thread = get().threads.find((t) => t.id === leaving)
      if (
        thread &&
        !thread.title &&
        thread.messageCount === 0 &&
        !thread.pinned &&
        !thread.folderId
      ) {
        set({ threads: get().threads.filter((t) => t.id !== leaving) })
        void window.deepPink.threads.remove(leaving)
      }
    }

    if (!id) {
      set({ activeThreadId: null, messages: [], generating: false })
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
    const switching = get().activeThreadId !== id
    if (switching) set({ activeThreadId: id, highlightMessageId: null })

    const [messages, generating, live] = await Promise.all([
      api.messages.list(id),
      api.chat.isGenerating(id),
      api.chat.liveStreams(id)
    ])

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

    set({ activeThreadId: id, messages: caughtUp, generating })

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

  async createThread() {
    const thread = await api.threads.create()
    await get().refreshThreads()
    await get().selectThread(thread.id)
    return thread
  },

  async deleteThread(id) {
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
      createdAt: Date.now(),
      model: null,
      provider: null,
      status: 'complete',
      error: null,
      toolCalls: null,
      toolResult: null,
      systemPromptSnapshot: null,
      isCompactionSummary: false,
      compactedInto: null,
      usage: null,
      attachments: []
    }
    set({ messages: [...get().messages, optimistic], generating: true })

    await api.chat.send({ threadId, content, attachments: pending })
    await get().refreshThreads()
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
      set({ messages: await api.messages.list(threadId) })
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

  openImageViewer(images, id) {
    const index = images.findIndex((image) => image.id === id)
    if (index < 0) return
    set({ imageViewer: { images, index } })
  },

  closeImageViewer() {
    set({ imageViewer: null })
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

function handleStreamEvent(event: StreamEvent, set: Setter, get: Getter): void {
  const state = get()

  if (event.type === 'title') {
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
        createdAt: Date.now(),
        model: null,
        provider: null,
        status: 'streaming',
        error: null,
        toolCalls: null,
        toolResult: null,
        systemPromptSnapshot: null,
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
      void api.messages
        .list(event.threadId)
        .then((persisted) => set({ messages: mergeStreamed(persisted, get().messages) }))
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
        void api.messages.list(state.activeThreadId).then((messages) => set({ messages }))
      }
      break

    case 'usage':
      set({
        messages: patchMessage(state.messages, event.messageId, (m) => ({ ...m, usage: event.usage }))
      })
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
      if (state.activeThreadId) {
        void api.messages.list(state.activeThreadId).then((messages) => set({ messages }))
      }
      get().showToast(`Compacted — about ${event.freedTokens.toLocaleString()} tokens freed`)
      break
  }
}
