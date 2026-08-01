import { useEffect } from 'react'
import { useStore } from './store'
import { buildActions } from './actions'
import { matchesBinding, parseBinding } from './keybinds'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { CommandPalette } from './components/CommandPalette'
import { SearchOverlay } from './components/SearchOverlay'
import { SettingsDialog } from './components/SettingsDialog'
import { ModelPicker } from './components/ModelPicker'
import { ProviderPicker } from './components/ProviderPicker'
import { SystemPromptInspector } from './components/SystemPromptInspector'
import { GlobalStatsPanel, ThreadStatsPanel } from './components/StatsPanels'
import { McpPanel } from './components/McpPanel'
import { KeybindCheatsheet } from './components/KeybindCheatsheet'
import { ToolApprovalDialog } from './components/ToolApprovalDialog'
import { Dialog } from './components/Dialog'

/** Bindings the composer owns; the global handler must not steal them. */
const COMPOSER_OWNED = new Set(['message.send', 'message.newline'])

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

export function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const settings = useStore((s) => s.settings)
  const overlay = useStore((s) => s.overlay)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const toast = useStore((s) => s.toast)
  const setOverlay = useStore((s) => s.setOverlay)
  const closeOverlay = useStore((s) => s.closeOverlay)
  const init = useStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  // Window dragging is a macOS-windowed-mode affair only. Enabling it under a
  // Wayland compositor — or in fullscreen anywhere — breaks click targets
  // elsewhere in the window, including the composer.
  useEffect(() => {
    const apply = (fullscreen: boolean): void => {
      // macOS draws its close/minimise/zoom buttons inside our content area
      // when the title bar is hidden, and hides them in fullscreen. The same
      // condition governs both: where they sit, and where dragging works.
      const overlapping = window.deepPink.platform === 'darwin' && !fullscreen
      document.documentElement.dataset.windowDrag = overlapping ? 'on' : 'off'
      document.documentElement.dataset.trafficLights = overlapping ? 'on' : 'off'
    }
    apply(false)
    return window.deepPink.window.onState((state) => apply(state.fullscreen))
  }, [])

  // Reflect appearance settings onto the document.
  useEffect(() => {
    if (!settings) return
    const root = document.documentElement
    root.style.setProperty('--accent', settings.ui.accent)
    root.style.setProperty('--font-size', `${settings.ui.fontSize}px`)

    // Derive the softer accent variants so a custom colour stays coherent.
    const hex = settings.ui.accent.replace('#', '')
    const r = Number.parseInt(hex.slice(0, 2), 16)
    const g = Number.parseInt(hex.slice(2, 4), 16)
    const b = Number.parseInt(hex.slice(4, 6), 16)
    if ([r, g, b].every(Number.isFinite)) {
      root.style.setProperty('--accent-dim', `rgba(${r}, ${g}, ${b}, 0.16)`)
      root.style.setProperty('--accent-line', `rgba(${r}, ${g}, ${b}, 0.38)`)
      root.style.setProperty(
        '--accent-hover',
        `rgb(${Math.min(r + 30, 255)}, ${Math.min(g + 40, 255)}, ${Math.min(b + 30, 255)})`
      )
    }
    document.body.style.fontSize = `${settings.ui.fontSize}px`
  }, [settings])

  // Global keybinds.
  useEffect(() => {
    if (!settings) return

    const onKeyDown = (event: KeyboardEvent): void => {
      const actions = buildActions()
      const editable = isEditable(event.target)

      for (const action of actions) {
        const binding = settings.keybinds[action.id]
        if (!binding || COMPOSER_OWNED.has(action.id)) continue
        if (!matchesBinding(event, binding)) continue

        // A bare letter shortcut must not fire while the user is typing.
        const parsed = parseBinding(binding)
        const isChorded = parsed.mod || parsed.alt || parsed.ctrl || /^f\d+$/.test(parsed.key)
        if (editable && !isChorded) continue

        event.preventDefault()
        void action.run()
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settings])

  if (!ready || !settings) {
    return (
      <div className="empty">
        <span className="sidebar__brand-mark" />
        <div className="empty__title">Deep Pink</div>
      </div>
    )
  }

  const close = (): void => closeOverlay()

  return (
    <>
      <div className="app" data-sidebar={sidebarVisible ? 'visible' : 'hidden'}>
        {sidebarVisible && <Sidebar />}
        <ChatView />
      </div>

      {!settings.hasApiKey && overlay !== 'settings' && (
        <div className="toast" style={{ bottom: 'auto', top: 18 }}>
          No OpenRouter API key yet —{' '}
          <button
            className="btn btn--ghost"
            style={{ color: 'var(--accent)', padding: '0 4px' }}
            onClick={() => setOverlay('settings')}
            type="button"
          >
            add one in Settings
          </button>
        </div>
      )}

      {overlay === 'palette' && <CommandPalette onClose={close} />}
      {overlay === 'search' && <SearchOverlay onClose={close} />}
      {overlay === 'settings' && <SettingsDialog onClose={close} />}
      {overlay === 'models' && <ModelPicker mode="chat" onClose={close} />}
      {overlay === 'defaultModel' && <ModelPicker mode="default" onClose={close} />}
      {overlay === 'titleModel' && <ModelPicker mode="title" onClose={close} />}
      {overlay === 'providers' && <ProviderPicker onClose={close} />}
      {overlay === 'prompt' && <SystemPromptInspector onClose={close} />}
      {overlay === 'threadStats' && <ThreadStatsPanel onClose={close} />}
      {overlay === 'globalStats' && <GlobalStatsPanel onClose={close} />}
      {overlay === 'mcp' && <McpPanel onClose={close} />}
      {overlay === 'keybinds' && <KeybindCheatsheet onClose={close} />}

      <ToolApprovalDialog />
      <Dialog />

      {toast && (
        <div className="toast" data-tone={toast.tone}>
          {toast.message}
        </div>
      )}
    </>
  )
}
