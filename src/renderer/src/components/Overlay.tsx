import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { ICON } from '../icons'

interface Props {
  title?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  center?: boolean
  /** Replaces the header entirely — used by the search-first palettes. */
  header?: ReactNode
  className?: string
}

export function Overlay({
  title,
  onClose,
  children,
  footer,
  wide,
  center,
  header,
  className
}: Props): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className={`overlay${center ? ' overlay--center' : ''}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={`panel${wide ? ' panel--wide' : ''}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        {header ?? (
          <div className="panel__head">
            <span className="panel__title">{title}</span>
            <div style={{ flex: 1 }} />
            <button className="btn btn--ghost" onClick={onClose} type="button" aria-label="Close">
              <X {...ICON} />
            </button>
          </div>
        )}
        {children}
        {footer && <div className="panel__foot">{footer}</div>}
      </div>
    </div>
  )
}
