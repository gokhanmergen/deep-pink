import { create } from 'zustand'
import type {
  McpServerStatus,
  Message,
  OpenRouterModel,
  SearchHit,
  TagSummary,
  PendingAttachment,
  Settings,
  SettingsPatch,
  StreamEvent,
  Thread,
  ThreadConfig,
  ThreadSort,
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
  | 'tagModel'
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
  /** Every tag in the library, for suggestions and the Settings list. */
  allTags: TagSummary[]
  /** Query the search overlay opens with, when something opened it for you. */
  searchSeed: string
  /** The thread a one-off re-tag is running on, for the little progress popup. */
  taggingThreadId: string | null
  /** How far the "tag every untagged thread" pass has got, while it runs. */
  tagBatch: { done: number; total: number } | null
  /** Tag folders currently open in the tag view. */
  expandedTags: string[]
  /**
   * Threads the sidebar is showing, in the order it is showing them. Published
   * by the sidebar because it is the only thing that knows: the order depends
   * on the view, on which folders are open, and on whether a search is running.
   * Empty when the sidebar is not on screen.
   */
  visibleThreadIds: string[]
  pendingApproval: PendingApproval | null
  toast: Toast | null
  dialog: DialogRequest | null
  /** Message id the transcript should scroll to and flash. */
  highlightMessageId: string | null

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
  send: (content: string, attachments?: PendingAttachment[]) => Promise<void>
  regenerate: (messageId: string) => Promise<void>
  abort: () => Promise<void>
  compact: () => Promise<void>
  saveSettings: (patch: SettingsPatch) => Promise<void>
  /** Switches the sidebar's view. Applied on the spot, saved behind it. */
  setThreadSort: (sort: ThreadSort) => void
  refreshModels: (force?: boolean) => Promise<void>
  refreshTags: () => Promise<void>
  /** Asks the tagging model to look at one thread now. */
  retagThread: (threadId: string) => Promise<void>
  /** Tags every thread that has no tags yet. */
  tagAllUntagged: () => Promise<void>
  /** Marks a tag manual-only, or pins its folder. */
  setTagFlags: (name: string, flags: { manualOnly?: boolean; pinned?: boolean }) => Promise<void>
  toggleTagFolder: (name: string) => void
  setVisibleThreads: (ids: string[]) => void
  /** Moves to the thread `delta` places away in the list, as displayed. */
  stepThread: (delta: number) => void
  /** Adds a tag to a thread by hand. Silently ignores an empty name. */
  addTag: (threadId: string, name: string) => Promise<void>
  removeTag: (threadId: string, name: string) => Promise<void>
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
  allTags: [],
  searchSeed: '',
  taggingThreadId: null,
  tagBatch: null,
  expandedTags: [],
  visibleThreadIds: [],
  pendingApproval: null,
  toast: null,
  dialog: null,
  highlightMessageId: null,

  async init() {
    if (initialised) return
    initialised = true

    const [settings, threads, mcpStatuses, allTags] = await Promise.all([
      api.settings.get(),
      api.threads.list(),
      api.mcp.statuses(),
      api.tags.list()
    ])

    set({ settings, threads, mcpStatuses, allTags, ready: true })

    if (threads.length) {
      await get().selectThread(threads[0].id)
    }

    unsubscribers.push(api.mcp.onStatus((statuses) => set({ mcpStatuses: statuses })))
    unsubscribers.push(api.chat.onEvent((event) => handleStreamEvent(event, set, get)))

    // A run started before this window existed — or before it was reloaded —
    // is still going in the main process, so show its bar rather than nothing.
    void api.tags.backfillRunning().then((running) => {
      if (running && !get().tagBatch) set({ tagBatch: { done: 0, total: 0 } })
    })

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

  setThreadSort(sort) {
    const current = get().settings
    if (!current || current.ui.threadSort === sort) return

    // Switching views is a glance, not a decision: waiting on a round trip to
    // the database — which re-reads the keyring on the way back — makes a free
    // action feel expensive. Paint it now and persist behind it; nothing else
    // reads this setting, so there is nothing to disagree with in the meantime.
    set({ settings: { ...current, ui: { ...current.ui, threadSort: sort } } })
    void api.settings.save({ ui: { threadSort: sort } })
  },

  async refreshModels(force = false) {
    try {
      set({ models: await api.models.list(force) })
    } catch {
      /* offline or no key yet — the cached catalogue is enough */
    }
  },

  async refreshTags() {
    set({ allTags: await api.tags.list() })
  },

  async retagThread(threadId) {
    // One thread is one request, so there is nothing to count — the popup says
    // which thread is being looked at and goes away when it is done.
    set({ taggingThreadId: threadId })
    try {
      const tags = await api.tags.retag(threadId)
      await get().refreshThreads()
      await get().refreshTags()
      get().showToast(
        tags === null
          ? 'The tagging model could not be reached'
          : tags.length
            ? `Tagged ${tags.join(', ')}`
            : 'No tags fit this thread'
      )
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      set({ taggingThreadId: null })
    }
  },

  async tagAllUntagged() {
    if (get().tagBatch) return
    // Painted before the first event arrives, so the bar appears on the click
    // rather than after the first thread has been through the model.
    set({ tagBatch: { done: 0, total: 0 } })
    try {
      const result = await api.tags.tagAllUntagged()
      await get().refreshThreads()
      await get().refreshTags()
      get().showToast(
        result.total
          ? `Tagged ${result.tagged} of ${result.total} untagged threads`
          : 'Every thread already has tags'
      )
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      set({ tagBatch: null })
    }
  },

  async setTagFlags(name, flags) {
    await api.tags.setFlags(name, flags)
    await get().refreshTags()
  },

  setVisibleThreads(ids) {
    const current = get().visibleThreadIds
    if (current.length === ids.length && current.every((id, i) => id === ids[i])) return
    set({ visibleThreadIds: ids })
  },

  stepThread(delta) {
    // What the sidebar is showing, or — when it is hidden or every folder is
    // shut — the underlying list, so the keys still do something sensible.
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

  toggleTagFolder(name) {
    const open = get().expandedTags
    set({
      expandedTags: open.includes(name) ? open.filter((t) => t !== name) : [...open, name]
    })
  },

  async addTag(threadId, name) {
    const updated = await api.tags.add(threadId, name)
    if (!updated) return
    set({ threads: get().threads.map((t) => (t.id === threadId ? updated : t)) })
    await get().refreshTags()
  },

  async removeTag(threadId, name) {
    const updated = await api.tags.remove(threadId, name)
    if (!updated) return
    set({ threads: get().threads.map((t) => (t.id === threadId ? updated : t)) })
    await get().refreshTags()
  },

  async runSearch(query) {
    if (!query.trim()) {
      set({ searchHits: [] })
      return
    }
    set({ searchHits: await api.search.query(query) })
  },

  setOverlay(overlay, returnTo = null) {
    // Opening search any other way starts empty, rather than with whatever a
    // tag click left behind.
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

  // Tags belong to the thread rather than to any message, so they land
  // whether or not the thread they changed is the one on screen. During a
  // library-wide pass this fires once per thread, which is far more reloading
  // than anyone can read — there, the progress handler paces it instead.
  if (event.type === 'tags') {
    if (!get().tagBatch) {
      void get().refreshThreads()
      void get().refreshTags()
    }
    return
  }

  if (event.type === 'tag-progress') {
    set({ tagBatch: event.finished ? null : { done: event.done, total: event.total } })
    // Often enough that the list visibly fills in, rarely enough that a run
    // over a thousand threads is not a thousand round trips.
    if (!event.finished && event.done > 0 && event.done % 10 === 0) {
      void get().refreshThreads()
      void get().refreshTags()
    }
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
