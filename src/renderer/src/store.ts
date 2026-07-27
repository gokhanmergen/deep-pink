import { create } from 'zustand'
import type {
  McpServerStatus,
  Message,
  OpenRouterModel,
  SearchHit,
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
  sidebarVisible: boolean
  sidebarFilter: string
  searchHits: SearchHit[]
  pendingApproval: PendingApproval | null
  toast: Toast | null
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
  send: (content: string) => Promise<void>
  regenerate: (messageId: string) => Promise<void>
  abort: () => Promise<void>
  compact: () => Promise<void>
  saveSettings: (patch: SettingsPatch) => Promise<void>
  refreshModels: (force?: boolean) => Promise<void>
  runSearch: (query: string) => Promise<void>
  setOverlay: (overlay: Overlay) => void
  setSidebarFilter: (value: string) => void
  toggleSidebar: () => void
  showToast: (message: string, tone?: Toast['tone']) => void
  approveTool: (approved: boolean) => Promise<void>
  setHighlight: (messageId: string | null) => void
}

const api = window.deepPink

let toastTimer: ReturnType<typeof setTimeout> | null = null

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
  sidebarVisible: true,
  sidebarFilter: '',
  searchHits: [],
  pendingApproval: null,
  toast: null,
  highlightMessageId: null,

  async init() {
    const [settings, threads, mcpStatuses] = await Promise.all([
      api.settings.get(),
      api.threads.list(),
      api.mcp.statuses()
    ])

    set({ settings, threads, mcpStatuses, ready: true })

    if (threads.length) {
      await get().selectThread(threads[0].id)
    }

    api.mcp.onStatus((statuses) => set({ mcpStatuses: statuses }))
    api.chat.onEvent((event) => handleStreamEvent(event, set, get))

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
    const [messages, generating] = await Promise.all([
      api.messages.list(id),
      api.chat.isGenerating(id)
    ])
    set({ activeThreadId: id, messages, generating, highlightMessageId: null })
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

  async send(content) {
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
      usage: null
    }
    set({ messages: [...get().messages, optimistic], generating: true })

    await api.chat.send({ threadId, content })
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

  async runSearch(query) {
    if (!query.trim()) {
      set({ searchHits: [] })
      return
    }
    set({ searchHits: await api.search.query(query) })
  },

  setOverlay(overlay) {
    set({ overlay })
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

function handleStreamEvent(event: StreamEvent, set: Setter, get: Getter): void {
  const state = get()

  // Events for a thread the user is not looking at only affect the thread list.
  const relevant =
    'threadId' in event
      ? event.threadId === state.activeThreadId
      : state.messages.some((m) => m.id === (event as { messageId: string }).messageId) ||
        state.generating

  if (event.type === 'title') {
    void get().refreshThreads()
    return
  }

  if (!relevant) return

  switch (event.type) {
    case 'start': {
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
        usage: null
      }
      // Replace the optimistic user message with whatever the main process
      // actually stored, then append the assistant placeholder.
      set({
        generating: true,
        messages: [...state.messages.filter((m) => !m.id.startsWith('optimistic-')), placeholder]
      })
      void api.messages.list(event.threadId).then((persisted) => {
        const live = get().messages.find((m) => m.id === event.messageId)
        set({ messages: live ? [...persisted.filter((m) => m.id !== live.id), live] : persisted })
      })
      break
    }

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
