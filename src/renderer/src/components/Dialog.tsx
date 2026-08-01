import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../store'

/**
 * The app's own confirm and prompt.
 *
 * Native dialogs are drawn by the OS, ignore the theme entirely, and block the
 * renderer while open. This one is focus-trapped to its own controls, closes on
 * Escape, and submits on Enter — which is what people expect from the originals.
 */
export function Dialog(): React.JSX.Element | null {
  const dialog = useStore((s) => s.dialog)
  const resolveDialog = useStore((s) => s.resolveDialog)

  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Focus what the user is about to act on: the field if there is one, else the
  // confirming button. Done at layout time rather than on an animation frame,
  // which Chromium throttles when the window is not frontmost — the dialog would
  // then open with nothing focused and Enter would do nothing.
  useLayoutEffect(() => {
    if (!dialog) return
    setValue(dialog.defaultValue)
    if (dialog.kind === 'prompt') {
      inputRef.current?.focus()
      inputRef.current?.select()
    } else {
      confirmRef.current?.focus()
    }
  }, [dialog])

  useEffect(() => {
    if (!dialog) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        resolveDialog(null)
      }
    }
    // Capture, so Escape closes this rather than an overlay behind it.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dialog, resolveDialog])

  if (!dialog) return null

  const submit = (): void =>
    resolveDialog(dialog.kind === 'prompt' ? value : 'confirmed')

  return (
    <div
      className="overlay overlay--center dialog__overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) resolveDialog(null)
      }}
    >
      <div className="panel dialog" role="alertdialog" aria-modal="true" aria-label={dialog.title}>
        <div className="dialog__body">
          <div className="dialog__title">{dialog.title}</div>
          {dialog.body && <p className="dialog__text">{dialog.body}</p>}

          {dialog.kind === 'prompt' && (
            <input
              ref={inputRef}
              className="input"
              value={value}
              placeholder={dialog.placeholder}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          )}
        </div>

        <div className="dialog__actions">
          <button className="btn" onClick={() => resolveDialog(null)} type="button">
            {dialog.cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={dialog.danger ? 'btn btn--danger-solid' : 'btn btn--primary'}
            onClick={submit}
            type="button"
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
