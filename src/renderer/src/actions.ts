import { useStore } from './store'
import { COMPOSER_ID } from './components/Composer'

export interface AppAction {
  id: string
  label: string
  group: string
  run: () => void | Promise<void>
  /** Hidden from the palette but still bindable. */
  hidden?: boolean
}

function focusComposer(): void {
  const el = document.getElementById(COMPOSER_ID) as HTMLTextAreaElement | null
  el?.focus()
}

/**
 * Zoom is Chromium's, applied in the main process. An earlier version set the
 * root element's font-size, which did nothing at all: no stylesheet here uses
 * `rem`, and body's size is set explicitly from settings.
 */
function zoom(direction: 'in' | 'out' | 'reset'): void {
  void window.deepPink.window.zoom(direction)
}

/**
 * Every user-facing action, in one place. The keybind handler and the command
 * palette both read from here, so a new feature gets a shortcut for free.
 */
export function buildActions(): AppAction[] {
  const store = useStore.getState()
  const { activeThreadId, threads, settings } = store
  const thread = threads.find((t) => t.id === activeThreadId) ?? null

  const requireThread = (fn: (id: string) => void | Promise<void>) => () => {
    if (!activeThreadId) {
      store.showToast('Open a thread first')
      return
    }
    return fn(activeThreadId)
  }

  return [
    // Threads
    { id: 'thread.new', label: 'New thread', group: 'Threads', run: () => void store.createThread() },
    {
      id: 'thread.rename',
      label: 'Rename thread',
      group: 'Threads',
      run: requireThread((id) => {
        const next = window.prompt('Thread name', thread?.title ?? '')
        if (next !== null) void store.updateThread(id, { title: next.trim() })
      })
    },
    {
      id: 'thread.delete',
      label: 'Delete thread',
      group: 'Threads',
      run: requireThread((id) => {
        if (window.confirm('Delete this thread and its messages?')) void store.deleteThread(id)
      })
    },
    {
      id: 'thread.pin',
      label: thread?.pinned ? 'Unpin thread' : 'Pin thread',
      group: 'Threads',
      run: requireThread((id) => void store.updateThread(id, { pinned: !thread?.pinned }))
    },
    {
      id: 'thread.archive',
      label: 'Archive thread',
      group: 'Threads',
      run: requireThread(async (id) => {
        await store.updateThread(id, { archived: true })
        await store.refreshThreads()
        await store.selectThread(useStore.getState().threads[0]?.id ?? null)
      })
    },
    {
      id: 'thread.branch',
      label: 'Branch from the last message',
      group: 'Threads',
      run: requireThread(async (id) => {
        const last = store.messages[store.messages.length - 1]
        if (!last) return
        const branched = await window.deepPink.threads.branch(id, last.id)
        if (branched) {
          await store.refreshThreads()
          await store.selectThread(branched.id)
        }
      })
    },
    {
      id: 'thread.export',
      label: 'Export thread as JSON',
      group: 'Threads',
      run: requireThread(async (id) => {
        const data = await window.deepPink.data.exportThread(id)
        if (!data) return
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `${(data.thread.title || 'thread').replace(/[^\w -]/g, '')}.json`
        anchor.click()
        URL.revokeObjectURL(url)
        store.showToast('Thread exported')
      })
    },
    {
      id: 'thread.next',
      label: 'Next thread',
      group: 'Threads',
      hidden: true,
      run: () => {
        const index = threads.findIndex((t) => t.id === activeThreadId)
        const next = threads[Math.min(index + 1, threads.length - 1)]
        if (next) void store.selectThread(next.id)
      }
    },
    {
      id: 'thread.prev',
      label: 'Previous thread',
      group: 'Threads',
      hidden: true,
      run: () => {
        const index = threads.findIndex((t) => t.id === activeThreadId)
        const prev = threads[Math.max(index - 1, 0)]
        if (prev) void store.selectThread(prev.id)
      }
    },

    // Navigation
    { id: 'palette.open', label: 'Command palette', group: 'Navigation', run: () => store.setOverlay('palette') },
    {
      id: 'search.threads',
      label: 'Search all threads',
      group: 'Navigation',
      run: () => store.setOverlay('search')
    },
    {
      id: 'search.inThread',
      label: 'Search in this thread',
      group: 'Navigation',
      run: () => {
        store.setOverlay('search')
      }
    },
    { id: 'sidebar.toggle', label: 'Toggle sidebar', group: 'Navigation', run: () => store.toggleSidebar() },
    { id: 'focus.composer', label: 'Focus composer', group: 'Navigation', hidden: true, run: focusComposer },
    { id: 'settings.open', label: 'Settings', group: 'Navigation', run: () => store.setOverlay('settings') },
    {
      id: 'keybinds.cheatsheet',
      label: 'Keyboard shortcuts',
      group: 'Navigation',
      run: () => store.setOverlay('keybinds')
    },

    // Messages
    {
      id: 'message.stop',
      label: 'Stop generating',
      group: 'Messages',
      run: () => void store.abort()
    },
    {
      id: 'message.regenerate',
      label: 'Regenerate the last reply',
      group: 'Messages',
      run: () => {
        const last = [...store.messages].reverse().find((m) => m.role === 'assistant')
        if (last) void store.regenerate(last.id)
      }
    },
    {
      id: 'message.editLast',
      label: 'Edit the last message I sent',
      group: 'Messages',
      hidden: true,
      run: () => {
        const last = [...store.messages].reverse().find((m) => m.role === 'user')
        if (!last) return
        const next = window.prompt('Edit message', last.content)
        if (next === null) return
        void window.deepPink.messages
          .update(last.id, { content: next })
          .then(() => store.selectThread(store.activeThreadId))
      }
    },
    {
      id: 'message.copyLast',
      label: 'Copy the last reply',
      group: 'Messages',
      run: () => {
        const last = [...store.messages].reverse().find((m) => m.role === 'assistant')
        if (!last) return
        void navigator.clipboard.writeText(last.content)
        store.showToast('Copied the last reply')
      }
    },
    {
      id: 'message.deleteLast',
      label: 'Delete the last message',
      group: 'Messages',
      hidden: true,
      run: () => {
        const last = store.messages[store.messages.length - 1]
        if (!last) return
        void window.deepPink.messages.remove(last.id).then(() => store.selectThread(store.activeThreadId))
      }
    },

    // Model & routing
    { id: 'model.picker', label: 'Change model', group: 'Model', run: () => store.setOverlay('models') },
    {
      id: 'provider.picker',
      label: 'Choose the provider for this model',
      group: 'Model',
      run: () => store.setOverlay('providers')
    },
    {
      id: 'titleModel.picker',
      label: 'Choose the thread-naming model',
      group: 'Model',
      run: () => store.setOverlay('titleModel')
    },
    {
      id: 'thread.retitle',
      label: 'Regenerate this thread’s name',
      group: 'Model',
      run: requireThread(async (id) => {
        const title = await window.deepPink.chat.retitle(id)
        await store.refreshThreads()
        store.showToast(title ? `Renamed to “${title}”` : 'Could not generate a name')
      })
    },

    // Capabilities
    {
      id: 'web.toggle',
      label: 'Toggle web access for this thread',
      group: 'Capabilities',
      run: requireThread((id) => {
        const on = thread?.config.webAccessEnabled ?? settings?.web.enabled ?? false
        void store.updateThread(id, { config: { webAccessEnabled: !on } })
        store.showToast(on ? 'Web access off' : 'Web access on')
      })
    },
    { id: 'mcp.panel', label: 'MCP servers', group: 'Capabilities', run: () => store.setOverlay('mcp') },
    {
      id: 'reasoning.toggle',
      label: 'Show or hide reasoning traces',
      group: 'Capabilities',
      run: () => {
        const on = settings?.ui.showReasoningByDefault ?? false
        void store.saveSettings({ ui: { showReasoningByDefault: !on } })
      }
    },
    {
      id: 'context.compact',
      label: 'Compact the context now',
      group: 'Capabilities',
      run: () => void store.compact()
    },

    // Transparency
    {
      id: 'prompt.inspect',
      label: 'Inspect the system prompt',
      group: 'Transparency',
      run: () => store.setOverlay('prompt')
    },
    {
      id: 'stats.thread',
      label: 'Thread statistics',
      group: 'Transparency',
      run: () => store.setOverlay('threadStats')
    },
    {
      id: 'stats.global',
      label: 'Global statistics',
      group: 'Transparency',
      run: () => store.setOverlay('globalStats')
    },

    // View
    { id: 'view.zoomIn', label: 'Zoom in', group: 'View', hidden: true, run: () => zoom('in') },
    { id: 'view.zoomOut', label: 'Zoom out', group: 'View', hidden: true, run: () => zoom('out') },
    { id: 'view.zoomReset', label: 'Reset zoom', group: 'View', hidden: true, run: () => zoom('reset') }
  ]
}
