import { useEffect, useLayoutEffect, useRef, useState } from 'react'

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
  /** Shown right-aligned, e.g. the keyboard shortcut for the same action. */
  hint?: string
  danger?: boolean
  onSelect: () => void
}

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
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

export function ContextMenu({ x, y, items, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })
  const [cursor, setCursor] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPosition(fit(x, y, width, height))
  }, [x, y])

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
        style={{ left: position.x, top: position.y }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {items.map((item, index) => (
          <button
            key={item.id}
            className="context-menu__item"
            data-active={index === cursor}
            data-danger={item.danger ?? false}
            role="menuitem"
            type="button"
            onMouseEnter={() => setCursor(index)}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            <span className="context-menu__label">{item.label}</span>
            {item.hint && <span className="context-menu__hint">{item.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
