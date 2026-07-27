import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { Overlay } from './Overlay'
import { formatTokens } from '../format'

interface Props {
  /** 'chat' sets the thread's model; 'title' sets the thread-naming model. */
  mode: 'chat' | 'title'
  onClose: () => void
}

function pricePerMillion(value: number): string {
  if (!value) return 'free'
  return `$${(value * 1_000_000).toFixed(2)}/M`
}

export function ModelPicker({ mode, onClose }: Props): React.JSX.Element {
  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const threads = useStore((s) => s.threads)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const updateThread = useStore((s) => s.updateThread)
  const saveSettings = useStore((s) => s.saveSettings)
  const refreshModels = useStore((s) => s.refreshModels)
  const showToast = useStore((s) => s.showToast)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [toolsOnly, setToolsOnly] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const thread = threads.find((t) => t.id === activeThreadId) ?? null
  const current =
    mode === 'title' ? settings?.titleModel : thread?.config.model ?? settings?.defaultModel

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return models
      .filter((m) => !toolsOnly || m.supportsTools)
      .filter(
        (m) =>
          !needle ||
          m.id.toLowerCase().includes(needle) ||
          m.name.toLowerCase().includes(needle)
      )
      .slice(0, 300)
  }, [models, query, toolsOnly])

  useEffect(() => setCursor(0), [query, toolsOnly])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const choose = async (modelId: string): Promise<void> => {
    if (mode === 'title') {
      await saveSettings({ titleModel: modelId })
      showToast(`Thread names will use ${modelId}`)
    } else if (thread) {
      await updateThread(thread.id, { config: { model: modelId } })
    } else {
      await saveSettings({ defaultModel: modelId })
    }
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((c) => Math.min(c + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const model = filtered[cursor]
      if (model) void choose(model.id)
    }
  }

  return (
    <Overlay
      onClose={onClose}
      header={
        <div className="panel__head" style={{ padding: 0 }}>
          <input
            className="panel__search"
            placeholder={
              mode === 'title' ? 'Model for generating thread names…' : 'Search models…'
            }
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      }
      footer={
        <>
          <label className="switch" style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={toolsOnly}
              onChange={(event) => setToolsOnly(event.target.checked)}
            />
            Tool-capable only
          </label>
          <div style={{ flex: 1 }} />
          <span>{filtered.length} models</span>
          <button
            className="btn btn--ghost"
            onClick={() => {
              void refreshModels(true)
              showToast('Refreshing model catalogue…')
            }}
            type="button"
          >
            Refresh
          </button>
        </>
      }
      wide
    >
      <div className="cmdlist" ref={listRef} style={{ maxHeight: '60vh' }}>
        {filtered.length === 0 && (
          <div className="empty" style={{ height: 160 }}>
            {models.length === 0
              ? 'No catalogue yet — add an API key in Settings, then refresh.'
              : 'No models match that search.'}
          </div>
        )}
        {filtered.map((model, index) => (
          <button
            key={model.id}
            className="cmditem"
            data-active={index === cursor}
            onMouseEnter={() => setCursor(index)}
            onClick={() => void choose(model.id)}
            type="button"
          >
            <span style={{ minWidth: 0, flex: 1 }}>
              <span className="cmditem__label" style={{ display: 'block' }}>
                {model.name}
                {model.id === current && (
                  <span className="chip chip--accent" style={{ marginLeft: 8 }}>
                    current
                  </span>
                )}
              </span>
              <span className="cmditem__sub">{model.id}</span>
            </span>
            <span className="row" style={{ gap: 6, flex: 'none' }}>
              {model.supportsTools && <span className="chip">tools</span>}
              {model.supportsReasoning && <span className="chip">reasoning</span>}
              <span className="chip" title="Context window">
                {formatTokens(model.contextLength)}
              </span>
              <span className="chip" title="Input / output price per million tokens">
                {pricePerMillion(model.pricing.prompt)} · {pricePerMillion(model.pricing.completion)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Overlay>
  )
}
