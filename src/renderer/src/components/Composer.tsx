import { useEffect, useRef, useState } from 'react'
import {
  MAX_COUNT,
  attachableFilesFrom,
  formatBytes,
  stageFiles,
  stageText,
  type StagedFile
} from './attachFiles'
import { useStore } from '../store'
import { formatBinding, matchesBinding } from '../keybinds'

export const COMPOSER_ID = 'composer-input'

export function Composer(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [images, setImages] = useState<StagedFile[]>([])
  const [dragging, setDragging] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
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
  const imagesUnsupported =
    images.some((i) => i.kind === 'image') &&
    modelInfo != null &&
    !modelInfo.inputModalities.includes('image')

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

  const add = async (files: File[]): Promise<void> => {
    if (!files.length) return
    const { staged, rejected } = await stageFiles(files, images.length)
    if (staged.length) setImages((current) => [...current, ...staged])
    if (rejected.length) showToast(rejected[0], 'error')
  }

  const pasteThreshold = settings?.ui.pasteAsFileThreshold ?? 2000

  /**
   * A long paste becomes an attachment rather than burying the composer. The
   * model still receives it as text — this only keeps it readable and removable.
   */
  const capturePastedText = (text: string): boolean => {
    if (!pasteThreshold || text.length < pasteThreshold) return false
    if (images.length >= MAX_COUNT) return false

    const index = images.filter((i) => i.kind === 'text').length + 1
    setImages((current) => [...current, stageText(text, `pasted-text-${index}.txt`)])
    showToast(`Attached ${text.length.toLocaleString()} characters as a file`)
    return true
  }

  const submit = (): void => {
    const content = value.trim()
    // An image on its own is a perfectly good message.
    if ((!content && !images.length) || generating) return
    setValue('')
    setImages([])
    void send(content, images.map(({ mime, filename, data, width, height }) => ({
      mime,
      filename,
      data,
      width,
      height
    })))
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
        {imagesUnsupported && (
          <div className="composer__notice">
            <strong>{modelInfo?.name ?? activeModel}</strong> does not accept images. Attach them to
            a vision-capable model, or they will be dropped with a note.
          </div>
        )}

        <div
          className="composer__box"
          data-dragging={dragging}
          onDragOver={(event) => {
            if (!attachableFilesFrom(event.dataTransfer).length) return
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            const files = attachableFilesFrom(event.dataTransfer)
            setDragging(false)
            if (!files.length) return
            event.preventDefault()
            void add(files)
          }}
        >
          {images.length > 0 && (
            <div className="thumbs">
              {images.map((item) => {
                const remove = (
                  <button
                    className="thumb__remove"
                    onClick={() => setImages((c) => c.filter((i) => i.key !== item.key))}
                    title="Remove"
                    type="button"
                    aria-label={`Remove ${item.filename}`}
                  >
                    ✕
                  </button>
                )

                if (item.kind === 'image') {
                  return (
                    <div className="thumb" key={item.key}>
                      <img src={item.preview ?? ''} alt={item.filename} />
                      {remove}
                      <span className="thumb__meta">{formatBytes(item.bytes)}</span>
                    </div>
                  )
                }

                return (
                  <div className="textchip" key={item.key} title={item.excerpt ?? ''}>
                    {remove}
                    <span className="textchip__name">{item.filename}</span>
                    <span className="textchip__meta">
                      {item.lines?.toLocaleString()} {item.lines === 1 ? 'line' : 'lines'} ·{' '}
                      {formatBytes(item.bytes)} · ~
                      {Math.ceil(item.bytes / 4).toLocaleString()} tokens
                    </span>
                    <pre className="textchip__excerpt">{item.excerpt}</pre>
                  </div>
                )
              })}
            </div>
          )}

          <textarea
            id={COMPOSER_ID}
            ref={textareaRef}
            className="composer__textarea"
            placeholder={
              generating ? 'Generating…' : 'Send a message — paste or drop images to attach'
            }
            value={value}
            rows={1}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const files = attachableFilesFrom(event.clipboardData)
              if (files.length) {
                // Only swallow the paste when it carries something attachable,
                // so pasting ordinary text keeps working normally.
                event.preventDefault()
                void add(files)
                return
              }
              const text = event.clipboardData.getData('text/plain')
              if (text && capturePastedText(text)) event.preventDefault()
            }}
          />
          <div className="composer__bar">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,text/*,.txt,.md,.json,.yaml,.yml,.toml,.csv,.log,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.kt,.c,.h,.cpp,.hpp,.cs,.sh,.sql,.xml,.html,.css,.diff,.patch"
              multiple
              hidden
              onChange={(event) => {
                void add(Array.from(event.target.files ?? []))
                event.target.value = ''
              }}
            />
            <button
              className="btn"
              onClick={() => fileInputRef.current?.click()}
              title={`Attach images or text files (up to ${MAX_COUNT})`}
              type="button"
              disabled={images.length >= MAX_COUNT}
            >
              Attach
            </button>

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
                disabled={!value.trim() && !images.length}
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
