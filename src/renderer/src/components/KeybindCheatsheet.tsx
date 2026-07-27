import { useStore } from '../store'
import { Overlay } from './Overlay'
import { KEYBIND_GROUPS, formatBinding } from '../keybinds'

export function KeybindCheatsheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const setOverlay = useStore((s) => s.setOverlay)

  return (
    <Overlay
      title="Keyboard shortcuts"
      onClose={onClose}
      wide
      footer={
        <>
          <span>Every action is rebindable.</span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => setOverlay('settings')} type="button">
            Change shortcuts
          </button>
        </>
      }
    >
      <div className="panel__body" style={{ columnCount: 2, columnGap: 28 }}>
        {KEYBIND_GROUPS.map((group) => (
          <div key={group.title} style={{ breakInside: 'avoid', marginBottom: 18 }}>
            <div className="section-title" style={{ marginTop: 0 }}>
              {group.title}
            </div>
            {group.actions.map((action) => (
              <div className="spread" key={action.id} style={{ padding: '3px 0' }}>
                <span className="muted" style={{ fontSize: 13 }}>
                  {action.label}
                </span>
                <span className="kbd">
                  {formatBinding(settings?.keybinds[action.id] ?? '')}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Overlay>
  )
}
