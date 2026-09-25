import { contextBridge, ipcRenderer } from 'electron'
import type {
  Attachment,
  ExportFormat,
  Folder,
  GlobalStats,
  McpServerConfig,
  McpServerStatus,
  Message,
  ModelEndpoint,
  OpenRouterModel,
  AppInfo,
  AttachedRepo,
  ImportPreview,
  ImportResult,
  LiveStream,
  MessagePage,
  OpenedThread,
  SearchHit,
  PromptPreview,
  CompactionStatus,
  SendMessageRequest,
  Settings,
  SettingsPatch,
  StreamEvent,
  SyncConfig,
  SyncProgress,
  SyncResult,
  SyncState,
  Thread,
  ThreadConfig,
  ThreadStats,
  ThreadTotals
} from '@shared/types'
import type { UpdateConfig, UpdateStatus } from '@shared/updates'

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    save: (patch: SettingsPatch): Promise<Settings> =>
      ipcRenderer.invoke('settings:save', patch),
    setApiKey: (key: string): Promise<Settings> => ipcRenderer.invoke('settings:setApiKey', key),
    encryptionAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke('settings:encryptionAvailable')
  },

  models: {
    list: (force = false): Promise<OpenRouterModel[]> => ipcRenderer.invoke('models:list', force),
    endpoints: (modelId: string, force = false): Promise<ModelEndpoint[]> =>
      ipcRenderer.invoke('models:endpoints', modelId, force)
  },

  threads: {
    list: (includeArchived = false): Promise<Thread[]> =>
      ipcRenderer.invoke('threads:list', includeArchived),
    get: (id: string): Promise<Thread | null> => ipcRenderer.invoke('threads:get', id),
    create: (config?: Partial<ThreadConfig>): Promise<Thread> =>
      ipcRenderer.invoke('threads:create', config),
    /** Turns a temporary chat into an ordinary one that outlives the session. */
    keep: (id: string): Promise<Thread | null> => ipcRenderer.invoke('threads:keep', id),
    /**
     * Turns an ordinary chat into a temporary one. Null when refused, which
     * means the thread has already been spoken in.
     */
    makeTemporary: (id: string): Promise<Thread | null> =>
      ipcRenderer.invoke('threads:makeTemporary', id),
    update: (
      id: string,
      patch: Partial<Pick<Thread, 'title' | 'pinned' | 'archived'>> & {
        config?: Partial<ThreadConfig>
      }
    ): Promise<Thread | null> => ipcRenderer.invoke('threads:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('threads:delete', id),
    branch: (id: string, messageId: string): Promise<Thread | null> =>
      ipcRenderer.invoke('threads:branch', id, messageId),
    /** Files a thread in a folder, or takes it out with null. */
    setFolder: (id: string, folderId: string | null): Promise<Thread | null> =>
      ipcRenderer.invoke('threads:setFolder', id, folderId)
  },

  folders: {
    list: (): Promise<Folder[]> => ipcRenderer.invoke('folders:list'),
    /** Returns null when the name is empty once cleaned up. */
    create: (name: string): Promise<Folder | null> => ipcRenderer.invoke('folders:create', name),
    update: (id: string, patch: { name?: string; pinned?: boolean }): Promise<Folder | null> =>
      ipcRenderer.invoke('folders:update', id, patch),
    /** Deletes the folder; the threads it held return to the list. */
    remove: (id: string): Promise<void> => ipcRenderer.invoke('folders:delete', id)
  },

  messages: {
    /**
     * The end of a conversation, or the page before one already held.
     * `before` is the `startSeq` of that page; null asks for the end.
     */
    page: (threadId: string, limit: number, before: number | null = null): Promise<MessagePage> =>
      ipcRenderer.invoke('messages:page', threadId, limit, before),
    /** Everything from `startSeq` on: how a transcript on screen is re-read. */
    from: (threadId: string, startSeq: number | null): Promise<MessagePage> =>
      ipcRenderer.invoke('messages:from', threadId, startSeq),
    /** The range that contains a particular message — what a search hit opens. */
    including: (threadId: string, messageId: string): Promise<MessagePage> =>
      ipcRenderer.invoke('messages:including', threadId, messageId),
    /**
     * What a page folded away for one message: its reasoning trace, and the
     * body of a tool result. Fetched when the disclosure holding them is
     * opened, which for most messages never happens.
     */
    hidden: (messageId: string): Promise<{ reasoning: string | null; content: string }> =>
      ipcRenderer.invoke('messages:hidden', messageId),
    /**
     * Asks which of these sentences are the ones to read first, and
     * remembers the answer against the message. Null when nothing stood out
     * — see `askKeyPoint`. The question goes with them because how many
     * sentences matter is decided by how much was asked, not by the reply.
     */
    keyPoint: (
      messageId: string,
      question: string,
      reply: string,
      candidates: string[]
    ): Promise<{ texts: string[]; costUsd: number } | null> =>
      ipcRenderer.invoke('messages:keyPoint', messageId, question, reply, candidates),
    /** What the whole thread cost, however much of it has been read in. */
    totals: (threadId: string): Promise<ThreadTotals> =>
      ipcRenderer.invoke('messages:totals', threadId),
    /**
     * Everything opening a conversation needs, in one crossing rather than
     * four. `from` reopens the range the reader was last in.
     */
    open: (threadId: string, limit: number, from: number | null = null): Promise<OpenedThread> =>
      ipcRenderer.invoke('threads:open', threadId, limit, from),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('messages:delete', id),
    removeAfter: (threadId: string, messageId: string): Promise<void> =>
      ipcRenderer.invoke('messages:deleteAfter', threadId, messageId),
    update: (id: string, patch: Partial<Message>): Promise<Message | null> =>
      ipcRenderer.invoke('messages:update', id, patch)
  },

  chat: {
    /**
     * Which threads actually have a turn in flight. The renderer's own idea of
     * this is assembled from events and can be stranded; this is the truth.
     */
    generating: (): Promise<string[]> => ipcRenderer.invoke('chat:generating'),
    send: (req: SendMessageRequest): Promise<void> => ipcRenderer.invoke('chat:send', req),
    abort: (threadId: string): Promise<void> => ipcRenderer.invoke('chat:abort', threadId),
    isGenerating: (threadId: string): Promise<boolean> =>
      ipcRenderer.invoke('chat:isGenerating', threadId),
    approveTool: (toolCallId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke('chat:approveTool', toolCallId, approved),
    /** Text of any reply still arriving in this thread. */
    liveStreams: (threadId: string): Promise<LiveStream[]> =>
      ipcRenderer.invoke('chat:liveStreams', threadId),
    /** The new name, or why there is not one — see `retitle` in the engine. */
    retitle: (threadId: string): Promise<{ title: string | null; error: string | null }> =>
      ipcRenderer.invoke('chat:retitle', threadId),
    compact: (threadId: string): Promise<{ summaryMessageId: string; freedTokens: number } | null> =>
      ipcRenderer.invoke('chat:compact', threadId),
    compactionStatus: (threadId: string): Promise<CompactionStatus> =>
      ipcRenderer.invoke('chat:compactionStatus', threadId),

    /** Subscribe to streaming events. Returns an unsubscribe function. */
    onEvent: (listener: (event: StreamEvent) => void): (() => void) => {
      const handler = (_e: unknown, payload: StreamEvent): void => listener(payload)
      ipcRenderer.on('chat:event', handler)
      return () => ipcRenderer.removeListener('chat:event', handler)
    }
  },

  prompt: {
    preview: (threadId: string): Promise<PromptPreview | null> =>
      ipcRenderer.invoke('prompt:preview', threadId)
  },

  search: {
    query: (query: string, limit = 50): Promise<SearchHit[]> =>
      ipcRenderer.invoke('search:query', query, limit)
  },

  stats: {
    thread: (threadId: string): Promise<ThreadStats> => ipcRenderer.invoke('stats:thread', threadId),
    global: (): Promise<GlobalStats> => ipcRenderer.invoke('stats:global'),
    credits: (): Promise<{ totalCredits: number; totalUsage: number } | null> =>
      ipcRenderer.invoke('stats:credits')
  },

  mcp: {
    statuses: (): Promise<McpServerStatus[]> => ipcRenderer.invoke('mcp:statuses'),
    configs: (): Promise<McpServerConfig[]> => ipcRenderer.invoke('mcp:configs'),
    create: (input: Partial<McpServerConfig>): Promise<McpServerConfig> =>
      ipcRenderer.invoke('mcp:create', input),
    update: (id: string, patch: Partial<McpServerConfig>): Promise<McpServerConfig> =>
      ipcRenderer.invoke('mcp:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('mcp:delete', id),
    connect: (id: string): Promise<McpServerStatus> => ipcRenderer.invoke('mcp:connect', id),
    disconnect: (id: string): Promise<void> => ipcRenderer.invoke('mcp:disconnect', id),

    onStatus: (listener: (statuses: McpServerStatus[]) => void): (() => void) => {
      const handler = (_e: unknown, payload: McpServerStatus[]): void => listener(payload)
      ipcRenderer.on('mcp:status', handler)
      return () => ipcRenderer.removeListener('mcp:status', handler)
    }
  },

  data: {
    path: (): Promise<string> => ipcRenderer.invoke('data:path'),
    reveal: (): Promise<void> => ipcRenderer.invoke('data:reveal'),
    wipe: (): Promise<void> => ipcRenderer.invoke('data:wipe'),
    /**
     * Asks where to put the file, writes it, and answers with the path it was
     * saved to — or null if the dialog was dismissed.
     */
    exportThread: (threadId: string, format: ExportFormat): Promise<string | null> =>
      ipcRenderer.invoke('data:exportThread', threadId, format)
  },

  app: {
    /** Version and runtime versions, for the About box and bug reports. */
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info')
  },

  quickQuestion: {
    ask: (question: string, requestId: number): Promise<string> =>
      ipcRenderer.invoke('quick-question:ask', question, requestId),
    cancel: (): void => ipcRenderer.send('quick-question:cancel'),
    onOpened: (listener: () => void): (() => void) => {
      const handler = (): void => listener()
      ipcRenderer.on('quick-question:opened', handler)
      return () => ipcRenderer.removeListener('quick-question:opened', handler)
    },
    onContent: (
      listener: (payload: { requestId: number; content: string }) => void
    ): (() => void) => {
      const handler = (_e: unknown, payload: { requestId: number; content: string }): void =>
        listener(payload)
      ipcRenderer.on('quick-question:content', handler)
      return () => ipcRenderer.removeListener('quick-question:content', handler)
    }
  },

  repo: {
    /** Opens a directory picker; returns the chosen path, or null if cancelled. */
    choose: (): Promise<string | null> => ipcRenderer.invoke('repo:choose'),
    /** Which of these directories still exist. */
    status: (paths: string[]): Promise<AttachedRepo[]> =>
      ipcRenderer.invoke('repo:status', paths)
  },

  import: {
    /** Opens a file picker; returns the chosen path, or null if cancelled. */
    choose: (): Promise<string | null> => ipcRenderer.invoke('import:choose'),
    /**
     * Reads the file and reports what would happen, changing nothing. Takes a
     * ChatGPT export or a thread exported from Deep Pink; which it is comes
     * back in `kind`.
     */
    preview: (path: string): Promise<ImportPreview> => ipcRenderer.invoke('import:preview', path),
    run: (path: string): Promise<ImportResult> => ipcRenderer.invoke('import:run', path)
  },

  attachments: {
    /** Hands a stored image to the desktop's own image viewer. */
    open: (id: string): Promise<void> => ipcRenderer.invoke('attachments:open', id),
    /** Full text of a text attachment; null for images. */
    text: (id: string): Promise<string | null> => ipcRenderer.invoke('attachments:text', id),
    /** Asks where to put a copy and writes it; returns the path, or null. */
    save: (id: string): Promise<string | null> => ipcRenderer.invoke('attachments:save', id),
    /** Puts the image on the clipboard. False if there was nothing to copy. */
    copy: (id: string): Promise<boolean> => ipcRenderer.invoke('attachments:copy', id),
    /** Every image in a thread, in the order it was said — what the viewer
     *  steps through, which is more than the transcript has read in. */
    images: (threadId: string): Promise<Attachment[]> =>
      ipcRenderer.invoke('attachments:images', threadId)
  },

  icons: {
    /**
     * The mark for whoever wrote a model, as a data URL, or null.
     *
     * Null is an ordinary answer, not an error: OpenRouter has no mark for
     * several large authors, so the caller needs something of its own to draw.
     */
    author: (modelId: string): Promise<string | null> =>
      ipcRenderer.invoke('icons:author', modelId)
  },

  /**
   * Whether there is a newer Deep Pink, and what this copy can do about it.
   *
   * `onChanged` rather than polling: the first check happens behind the first
   * paint, so the answer arrives after the window does.
   */
  updates: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:status'),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:check'),
    config: (): Promise<UpdateConfig> => ipcRenderer.invoke('updates:config'),
    save: (patch: Partial<UpdateConfig>): Promise<UpdateConfig> =>
      ipcRenderer.invoke('updates:save', patch),
    onChanged: (fn: (status: UpdateStatus) => void): (() => void) => {
      const handler = (_e: unknown, status: UpdateStatus): void => fn(status)
      ipcRenderer.on('updates:changed', handler)
      return () => ipcRenderer.removeListener('updates:changed', handler)
    }
  },

  sync: {
    /** Everything the settings panel shows. Never includes a secret. */
    state: (): Promise<SyncState> => ipcRenderer.invoke('sync:state'),
    save: (patch: Partial<SyncConfig>): Promise<SyncState> =>
      ipcRenderer.invoke('sync:save', patch),
    /** Makes a key and returns it once, so it can be written down. */
    createKey: (): Promise<string> => ipcRenderer.invoke('sync:createKey'),
    importKey: (text: string): Promise<SyncState> => ipcRenderer.invoke('sync:importKey', text),
    /** The key as text, for showing it again. */
    revealKey: (): Promise<string | null> => ipcRenderer.invoke('sync:revealKey'),
    setSecret: (secret: string): Promise<SyncState> => ipcRenderer.invoke('sync:setSecret', secret),
    /** Writes and reads back a probe object; throws with what went wrong. */
    test: (): Promise<void> => ipcRenderer.invoke('sync:test'),
    run: (): Promise<SyncResult> => ipcRenderer.invoke('sync:run'),
    /**
     * Holds off automatic syncing. `until` is a timestamp to resume at, or null
     * for "until I say so"; a run in flight stops where it is. Syncing by hand
     * still works while paused.
     */
    pause: (until: number | null): Promise<SyncState> => ipcRenderer.invoke('sync:pause', until),
    resume: (): Promise<SyncState> => ipcRenderer.invoke('sync:resume'),
    /** Forgets the key, the credentials and the config. The bucket is left. */
    disconnect: (): Promise<SyncState> => ipcRenderer.invoke('sync:disconnect'),

    /** Fires whenever a run finishes, with the state it left behind. */
    onState: (listener: (state: SyncState) => void): (() => void) => {
      const handler = (_e: unknown, payload: SyncState): void => listener(payload)
      ipcRenderer.on('sync:event', handler)
      return () => ipcRenderer.removeListener('sync:event', handler)
    },

    /** Fires as a run works, for the progress bar. Throttled in the main process. */
    onProgress: (listener: (progress: SyncProgress) => void): (() => void) => {
      const handler = (_e: unknown, payload: SyncProgress): void => listener(payload)
      ipcRenderer.on('sync:progress', handler)
      return () => ipcRenderer.removeListener('sync:progress', handler)
    },

    /** Fires when a sync brought something in, so the window can catch up. */
    onChanged: (listener: () => void): (() => void) => {
      const handler = (): void => listener()
      ipcRenderer.on('sync:changed', handler)
      return () => ipcRenderer.removeListener('sync:changed', handler)
    }
  },

  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url)
  },

  window: {
    /** Scales the whole interface. Returns the level actually applied. */
    zoom: (direction: 'in' | 'out' | 'reset'): Promise<number> =>
      ipcRenderer.invoke('window:zoom', direction),

    /** Fullscreen / maximised state, so the UI can adapt its chrome. */
    onState: (
      listener: (state: { fullscreen: boolean; maximized: boolean }) => void
    ): (() => void) => {
      const handler = (
        _e: unknown,
        payload: { fullscreen: boolean; maximized: boolean }
      ): void => listener(payload)
      ipcRenderer.on('window:state', handler)
      return () => ipcRenderer.removeListener('window:state', handler)
    }
  },

  platform: process.platform,

  /**
   * Everything that went wrong out of reach of the window.
   *
   * An `invoke` that rejects comes back to whoever made it. This is for the
   * rest — a background sweep, a picture that would not store, a throw nobody
   * caught — which until now went to a console the reader does not have open.
   * See `reportProblem` in the main process.
   */
  onProblem: (listener: (message: string) => void): (() => void) => {
    const handler = (_e: unknown, message: string): void => listener(message)
    ipcRenderer.on('app:problem', handler)
    return () => ipcRenderer.removeListener('app:problem', handler)
  },

  /*
   * Whether to skip the first-launch wizard.
   *
   * Set by the test runner, because every suite that boots the app is a first
   * launch — fresh profile, no key, no threads — and a panel over the window
   * would hide the very thing being measured. Read here rather than in the
   * renderer, which has no `process` to read it from.
   */
  wizardSuppressed: Boolean(process.env.DEEP_PINK_NO_WIZARD)
}

export type DeepPinkApi = typeof api

contextBridge.exposeInMainWorld('deepPink', api)
