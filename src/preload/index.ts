import { contextBridge, ipcRenderer } from 'electron'
import type {
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
  SearchHit,
  TagBackfillEstimate,
  TagSummary,
  PromptPreview,
  CompactionStatus,
  SendMessageRequest,
  Settings,
  SettingsPatch,
  StreamEvent,
  Thread,
  ThreadConfig,
  ThreadStats
} from '@shared/types'

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
    update: (
      id: string,
      patch: Partial<Pick<Thread, 'title' | 'pinned' | 'archived'>> & {
        config?: Partial<ThreadConfig>
      }
    ): Promise<Thread | null> => ipcRenderer.invoke('threads:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('threads:delete', id),
    branch: (id: string, messageId: string): Promise<Thread | null> =>
      ipcRenderer.invoke('threads:branch', id, messageId)
  },

  messages: {
    list: (threadId: string, includeCompacted = false): Promise<Message[]> =>
      ipcRenderer.invoke('messages:list', threadId, includeCompacted),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('messages:delete', id),
    removeAfter: (threadId: string, messageId: string): Promise<void> =>
      ipcRenderer.invoke('messages:deleteAfter', threadId, messageId),
    update: (id: string, patch: Partial<Message>): Promise<Message | null> =>
      ipcRenderer.invoke('messages:update', id, patch)
  },

  chat: {
    send: (req: SendMessageRequest): Promise<void> => ipcRenderer.invoke('chat:send', req),
    abort: (threadId: string): Promise<void> => ipcRenderer.invoke('chat:abort', threadId),
    isGenerating: (threadId: string): Promise<boolean> =>
      ipcRenderer.invoke('chat:isGenerating', threadId),
    approveTool: (toolCallId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke('chat:approveTool', toolCallId, approved),
    /** Text of any reply still arriving in this thread. */
    liveStreams: (threadId: string): Promise<LiveStream[]> =>
      ipcRenderer.invoke('chat:liveStreams', threadId),
    retitle: (threadId: string): Promise<string | null> =>
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

  tags: {
    /** Every tag in the library, with how many threads carry it. */
    list: (): Promise<TagSummary[]> => ipcRenderer.invoke('tags:list'),
    forThread: (threadId: string): Promise<string[]> =>
      ipcRenderer.invoke('tags:forThread', threadId),
    add: (threadId: string, name: string): Promise<Thread | null> =>
      ipcRenderer.invoke('tags:add', threadId, name),
    remove: (threadId: string, name: string): Promise<Thread | null> =>
      ipcRenderer.invoke('tags:remove', threadId, name),
    /** Renames everywhere; renaming onto an existing tag merges the two. */
    rename: (from: string, to: string): Promise<string | null> =>
      ipcRenderer.invoke('tags:rename', from, to),
    /** Removes a tag from every thread and from the library. */
    deleteEverywhere: (name: string): Promise<void> => ipcRenderer.invoke('tags:delete', name),
    /** `manualOnly` puts a tag out of the model's reach; `pinned` is folder order. */
    setFlags: (
      name: string,
      flags: { manualOnly?: boolean; pinned?: boolean }
    ): Promise<void> => ipcRenderer.invoke('tags:setFlags', name, flags),
    /** Asks the tagging model to revisit this thread now. */
    retag: (threadId: string): Promise<string[] | null> =>
      ipcRenderer.invoke('tags:retag', threadId),
    /** Token counts for tagging every untagged thread, for pricing up front. */
    backfillEstimate: (): Promise<TagBackfillEstimate> =>
      ipcRenderer.invoke('tags:backfillEstimate'),
    /** Tags every untagged thread, reporting progress as a chat event. */
    tagAllUntagged: (): Promise<{ tagged: number; total: number }> =>
      ipcRenderer.invoke('tags:tagAllUntagged'),
    /** Stops that pass after the thread it is on. */
    stopBackfill: (): Promise<void> => ipcRenderer.invoke('tags:stopBackfill'),
    backfillRunning: (): Promise<boolean> => ipcRenderer.invoke('tags:backfillRunning')
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
    exportThread: (
      threadId: string
    ): Promise<{ thread: Thread; messages: Message[]; exportedAt: string } | null> =>
      ipcRenderer.invoke('data:exportThread', threadId)
  },

  app: {
    /** Version and runtime versions, for the About box and bug reports. */
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info')
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
    /** Reads the export and reports what would happen, changing nothing. */
    preview: (path: string): Promise<ImportPreview> => ipcRenderer.invoke('import:preview', path),
    run: (path: string): Promise<ImportResult> => ipcRenderer.invoke('import:run', path)
  },

  attachments: {
    /** Opens a stored image at full size in the desktop's image viewer. */
    open: (id: string): Promise<void> => ipcRenderer.invoke('attachments:open', id),
    /** Full text of a text attachment; null for images. */
    text: (id: string): Promise<string | null> => ipcRenderer.invoke('attachments:text', id)
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

  platform: process.platform
}

export type DeepPinkApi = typeof api

contextBridge.exposeInMainWorld('deepPink', api)
