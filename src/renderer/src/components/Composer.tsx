import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { formatBinding, matchesBinding } from '../keybinds'

export const COMPOSER_ID = 'composer-input'

export function Composer(): React.JSX.Element {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const settings = useStore((s) => s.settings)
  const generating = useStore((s) => s.generating)
  const send = useStore((s) => s.send)
  const abort = useStore((s) => s.abort)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const updateThread = useStore((s) => s.updateThread)
  const threads = useStore((s) => s.threads)
  const setOverlay = useStore((s) => s.setOverlay)

  const models = useStore((s) => s.models)

  const thread = threads.find((t) => t.id === activeThreadId) ?? null
  const webOn = thread?.config.webAccessEnabled ?? settings?.web.enabled ?? false

  // Web access works by giving the model tools. A model that cannot call tools
  // will simply ignore them, which looks exactly like search being broken.
  const activeModel = thread?.config.model ?? settings?.defaultModel
  const modelInfo = models.find((m) => m.id === activeModel)
  const toolsUnsupported = webOn && modelInfo != null && !modelInfo.supportsTools

  // Grow with the content, up to the CSS max-height.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  // Opening a thread means you are about to type in it. Don't steal focus from
  // someone who is already typing somewhere else, though — a search box, a
  // settings field, or a message they are editing.
  useEffect(() => {
    if (!activeThreadId) return
    const active = document.activeElement
    const busyElsewhere =
      active instanceof HTMLElement &&
      active !== textareaRef.current &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
    if (busyElsewhere) return

    const frame = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [activeThreadId])

  const submit = (): void => {
    const content = value.trim()
    if (!content || generating) return
    setValue('')
    void send(content)
  }

  const keybinds = settings?.keybinds ?? {}
  const sendBinding = keybinds['message.send'] ?? 'enter'

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const native = event.nativeEvent

    if (matchesBinding(native, keybinds['message.newline'] ?? 'shift+enter')) return

    if (matchesBinding(native, sendBinding)) {
      // With send-on-Enter off, a bare Enter should still insert a newline.
      if (sendBinding === 'enter' && !settings?.ui.sendOnEnter) return
      event.preventDefault()
      submit()
      return
    }

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  const toggleWeb = (): void => {
    if (!activeThreadId) return
    void updateThread(activeThreadId, { config: { webAccessEnabled: !webOn } })
  }

  return (
    <div className="composer">
      <div className="composer__inner">
        {toolsUnsupported && (
          <div className="composer__notice">
            <strong>{modelInfo?.name ?? activeModel}</strong> cannot call tools, so web search and
            MCP will be ignored on this thread. Pick a tool-capable model with{' '}
            <span className="kbd">{formatBinding(keybinds['model.picker'] ?? 'mod+m')}</span>.
          </div>
        )}
        <div className="composer__box">
          <textarea
            id={COMPOSER_ID}
            ref={textareaRef}
            className="composer__textarea"
            placeholder={generating ? 'Generating…' : 'Send a message'}
            value={value}
            rows={1}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="composer__bar">
            <button
              className="btn"
              data-on={webOn}
              onClick={toggleWeb}
              title={`Web search and fetch — ${formatBinding(keybinds['web.toggle'] ?? 'mod+shift+w')}`}
              type="button"
              disabled={!activeThreadId}
            >
              Web {webOn ? 'on' : 'off'}
            </button>

            <button
              className="btn"
              onClick={() => setOverlay('models')}
              title={`Model — ${formatBinding(keybinds['model.picker'] ?? 'mod+m')}`}
              type="button"
            >
              {(thread?.config.model ?? settings?.defaultModel ?? '').split('/').pop() ||
                'Choose model'}
            </button>

            {generating ? (
              <button className="btn btn--danger" onClick={() => void abort()} type="button">
                Stop
              </button>
            ) : (
              <button
                className="btn btn--primary"
                onClick={submit}
                disabled={!value.trim()}
                type="button"
              >
                Send
              </button>
            )}

            <span className="composer__hint">
              <span className="kbd">{formatBinding(sendBinding)}</span> to send ·{' '}
              <span className="kbd">
                {formatBinding(keybinds['message.newline'] ?? 'shift+enter')}
              </span>{' '}
              for a newline
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
