import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Text fields whose value is persisted asynchronously.
 *
 * A fully controlled input backed by an async store re-renders with the *old*
 * value before the write lands, and the browser responds by putting the caret
 * at the end — so editing anywhere but the end of a long prompt is impossible.
 *
 * These keep the keystrokes local, commit after a pause (and on blur), and only
 * accept a value from outside while the field is untouched.
 */
function useDebouncedValue(
  value: string,
  onCommit: (next: string) => void,
  delay: number
): {
  local: string
  onChange: (next: string) => void
  flush: () => void
} {
  const [local, setLocal] = useState(value)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitRef = useRef(onCommit)

  commitRef.current = onCommit

  // Adopt outside changes only when the user is not mid-edit, so a slow write
  // coming back cannot yank the caret.
  useEffect(() => {
    if (!dirty.current) setLocal(value)
  }, [value])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const onChange = useCallback(
    (next: string) => {
      dirty.current = true
      setLocal(next)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        dirty.current = false
        commitRef.current(next)
      }, delay)
    },
    [delay]
  )

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!dirty.current) return
    dirty.current = false
    commitRef.current(local)
  }, [local])

  return { local, onChange, flush }
}

interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string
  onCommit: (next: string) => void
  delay?: number
}

export function DebouncedTextarea({
  value,
  onCommit,
  delay = 400,
  ...rest
}: TextareaProps): React.JSX.Element {
  const { local, onChange, flush } = useDebouncedValue(value, onCommit, delay)
  return (
    <textarea
      {...rest}
      value={local}
      onChange={(event) => onChange(event.target.value)}
      onBlur={(event) => {
        flush()
        rest.onBlur?.(event)
      }}
    />
  )
}

interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  value: string
  onCommit: (next: string) => void
  delay?: number
}

export function DebouncedInput({
  value,
  onCommit,
  delay = 400,
  ...rest
}: InputProps): React.JSX.Element {
  const { local, onChange, flush } = useDebouncedValue(value, onCommit, delay)
  return (
    <input
      {...rest}
      value={local}
      onChange={(event) => onChange(event.target.value)}
      onBlur={(event) => {
        flush()
        rest.onBlur?.(event)
      }}
    />
  )
}
