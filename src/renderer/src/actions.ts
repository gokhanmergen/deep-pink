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
      run: requireThread(async (id) => {
        const next = await store.askPrompt({
          title: 'Rename thread',
          defaultValue: thread?.title ?? '',
          placeholder: 'Thread name'
        })
        if (next !== null) void store.updateThread(id, { title: next.trim() })
      })
    },
    {
      id: 'thread.delete',
      label: 'Delete thread',
      group: 'Threads',
      run: requireThread(async (id) => {
        const ok = await store.askConfirm({
          title: `Delete “${thread?.title || 'Untitled thread'}”?`,
          body: 'Its messages go with it. This cannot be undone.',
          confirmLabel: 'Delete',
          danger: true
        })
        if (ok) void store.deleteThread(id)
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
    // Both walk the list as the sidebar is showing it, so they agree with what
    // is on screen in every view.
    {
      id: 'thread.next',
      label: 'Next thread',
      group: 'Threads',
      hidden: true,
      run: () => store.stepThread(1)
    },
    {
      id: 'thread.prev',
      label: 'Previous thread',
      group: 'Threads',
      hidden: true,
      run: () => store.stepThread(-1)
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
      run: async () => {
        const last = [...store.messages].reverse().find((m) => m.role === 'user')
        if (!last) return
        const next = await store.askPrompt({
          title: 'Edit message',
          defaultValue: last.content,
          confirmLabel: 'Save'
        })
        if (next === null) return
        await window.deepPink.messages.update(last.id, { content: next })
        await store.selectThread(store.activeThreadId)
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
      id: 'tagModel.picker',
      label: 'Choose the tagging model',
      group: 'Model',
      run: () => store.setOverlay('tagModel')
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

    // Tags
    {
      id: 'tags.add',
      label: 'Add a tag to this thread',
      group: 'Tags',
      run: requireThread(async (id) => {
        const name = await store.askPrompt({
          title: 'Add a tag',
          body: 'Tags are shared between threads and searchable from anywhere.',
          placeholder: 'Tag name',
          confirmLabel: 'Add tag'
        })
        if (name?.trim()) await store.addTag(id, name)
      })
    },
    {
      id: 'tags.retag',
      // Works whether or not automatic tagging is on: that switch governs
      // whether it happens by itself, not whether it can be asked for.
      label: 'Re-tag this thread now',
      group: 'Tags',
      run: requireThread((id) => void store.retagThread(id))
    },
    {
      id: 'tags.tagAll',
      label: 'Tag every untagged thread',
      group: 'Tags',
      run: () => void store.tagAllUntagged()
    },
    {
      id: 'tags.search',
      label: 'Search by tag',
      group: 'Tags',
      run: () => store.openSearch('tag:')
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
    {
      id: 'view.sortEdited',
      label: 'Order threads by when they were last edited',
      group: 'View',
      run: () => store.setThreadSort('edited')
    },
    {
      id: 'view.sortCreated',
      label: 'Order threads by when they were created',
      group: 'View',
      run: () => store.setThreadSort('created')
    },
    {
      id: 'view.sortTags',
      label: 'Show threads as tag folders',
      group: 'View',
      run: () => store.setThreadSort('tags')
    },
    { id: 'view.zoomIn', label: 'Zoom in', group: 'View', hidden: true, run: () => zoom('in') },
    { id: 'view.zoomOut', label: 'Zoom out', group: 'View', hidden: true, run: () => zoom('out') },
    { id: 'view.zoomReset', label: 'Reset zoom', group: 'View', hidden: true, run: () => zoom('reset') }
  ]
}
