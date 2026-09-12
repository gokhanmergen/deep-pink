import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A small menu anchored at the pointer.
 *
 * Kept in the renderer rather than using Electron's native menu so it matches
 * the rest of the interface, and so keyboard navigation behaves the same way as
 * the command palette.
 */

export interface ContextMenuItem {
  id: string
  label: string
  /** Drawn before the label, at the same weight as the rest of the chrome. */
  icon?: ReactNode
  /** Shown right-aligned, e.g. the keyboard shortcut for the same action. */
  hint?: string
  danger?: boolean
  /** Kept visible but unselectable — an action that is already running. */
  disabled?: boolean
  /**
   * A switch that is currently on. Drawn in the accent, because a menu of
   * toggles that all look the same is a menu you have to read to use.
   */
  on?: boolean
  onSelect: () => void
}

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
  /**
   * Treat `y` as the bottom of the menu rather than the top, so it opens
   * upwards from what it belongs to.
   *
   * Clamping alone is not enough for a menu anchored to something at the
   * bottom of the window: it keeps the menu on screen by sliding it up over
   * the button that opened it, which then cannot be seen or clicked. A menu
   * that opens from the composer has to open away from it.
   */
  above?: boolean
  onClose: () => void
}

/** Keeps the menu on screen when opened near an edge. */
function fit(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const margin = 8
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - height - margin))
  }
}

export function ContextMenu({ x, y, items, above = false, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  /**
   * Hidden until measured.
   *
   * Placing a menu above its anchor needs its height, and its height is only
   * known once it is in the document — so it is laid out, measured and moved
   * before the browser paints. Without this it would appear once in the wrong
   * place and once in the right one.
   */
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)

  const [cursor, setCursor] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    // A small gap, so the menu is clearly a thing above the button rather
    // than a thing growing out of it.
    setPosition(fit(x, above ? y - height - 6 : y, width, height))
  }, [x, y, above, items.length])

  useEffect(() => {
    // Anything that moves the menu away from what it points at closes it.
    const close = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCursor((c) => (c + 1) % items.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCursor((c) => (c - 1 + items.length) % items.length)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const item = items[cursor]
        if (item?.disabled) return
        onClose()
        item?.onSelect()
      }
    }

    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    // Capture phase, so a scroll anywhere — including inside the thread list —
    // dismisses rather than leaving the menu floating over nothing.
    window.addEventListener('scroll', close, true)

    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [items, cursor, onClose])

  return (
    <div
      className="context-menu__backdrop"
      onMouseDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div
        className="context-menu"
        ref={ref}
        role="menu"
        style={{
          left: position?.x ?? x,
          top: position?.y ?? y,
          visibility: position ? 'visible' : 'hidden'
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {items.map((item, index) => (
          <button
            key={item.id}
            className="context-menu__item"
            data-active={index === cursor}
            data-danger={item.danger ?? false}
            data-on={item.on ?? false}
            role="menuitem"
            type="button"
            disabled={item.disabled ?? false}
            onMouseEnter={() => setCursor(index)}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.icon}
            <span className="context-menu__label">{item.label}</span>
            {/* Before the shortcut, because it is a fact about the item rather
                than about how to reach it. */}
            {item.on && <span className="context-menu__on">on</span>}
            {item.hint && <span className="context-menu__hint">{item.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
