import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { Overlay } from './Overlay'
import { ModelIcon } from './ModelIcon'
import { matchesQuery, wordsOf } from '../modelSearch'
import { formatTokens, modelShortName } from '../format'

interface Props {
  /**
   * 'chat' sets the model for the open thread, 'default' sets the one new
   * threads start with, 'title' sets the model that names threads once they
   * have been answered, and 'pregenTitle' the one that names them from the
   * question while the answer is still arriving.
   */
  mode: 'chat' | 'title' | 'pregenTitle' | 'default' | 'keyPoint'
  onClose: () => void
}

/** Rows built before the panel is shown; the rest follow immediately after. */
const FIRST_FRAME = 60

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
  const [drawsOnly, setDrawsOnly] = useState(false)
  /*
   * How many rows are built for the first frame.
   *
   * The whole cost of opening this was building rows. Measured (2026-09-22),
   * median of eight: three hundred rows took 106ms, fifty took 20ms — a
   * little under half a millisecond each, and nothing else in here is worth
   * measuring beside it.
   *
   * A screenful is about a dozen. Sixty is several screens of scrolling, and
   * the rest arrive a tick later — before anyone has read the first one, and
   * before the keyboard can walk that far.
   */
  const [built, setBuilt] = useState(FIRST_FRAME)
  const listRef = useRef<HTMLDivElement>(null)

  const thread = threads.find((t) => t.id === activeThreadId) ?? null
  const current =
    mode === 'keyPoint'
      ? settings?.keyPointModel
      : mode === 'title'
        ? settings?.titleModel
        : mode === 'pregenTitle'
          ? settings?.titlePregenModel
          : mode === 'default'
            ? settings?.defaultModel
            : thread?.config.model ?? settings?.defaultModel

  const filtered = useMemo(() => {
    // Every word somewhere in the id or the name, rather than the whole
    // phrase in a row — see `modelSearch` for what that was costing.
    const words = wordsOf(query)
    return models
      .filter((m) => !toolsOnly || m.supportsTools)
      .filter((m) => !drawsOnly || m.outputModalities.includes('image'))
      .filter((m) => matchesQuery(m, words))
      .slice(0, 300)
  }, [models, query, toolsOnly, drawsOnly])

  useEffect(() => setCursor(0), [query, toolsOnly, drawsOnly])

  /*
   * The rest of the list, once the first frame is on screen.
   *
   * A timeout rather than an effect body, because an effect still runs before
   * the browser paints — setting the full count there would put every row in
   * the same frame and buy nothing. Reset whenever the filter changes, so a
   * search is as quick to show as the first open.
   */
  useEffect(() => setBuilt(FIRST_FRAME), [query, toolsOnly, drawsOnly])
  useEffect(() => {
    if (built >= filtered.length) return
    const soon = setTimeout(() => setBuilt(filtered.length), 0)
    return () => clearTimeout(soon)
  }, [built, filtered.length])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const choose = async (modelId: string): Promise<void> => {
    if (mode === 'keyPoint') {
      await saveSettings({ keyPointModel: modelId })
      showToast(`Key sentences will be picked by ${modelShortName(modelId)}`)
    } else if (mode === 'title') {
      await saveSettings({ titleModel: modelId })
      showToast(`Thread names will use ${modelShortName(modelId)}`)
    } else if (mode === 'pregenTitle') {
      await saveSettings({ titlePregenModel: modelId })
      showToast(`First names will use ${modelShortName(modelId)}`)
    } else if (mode === 'default') {
      // Deliberately does not touch the open thread: this is the model new
      // threads start with, which is a different question from what this one
      // is using.
      await saveSettings({ defaultModel: modelId })
      showToast(`New threads will use ${modelShortName(modelId)}`)
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
              mode === 'title'
                ? 'Model for generating thread names…'
                : mode === 'pregenTitle'
                  ? 'Model for the first name, written from the question…'
                  : mode === 'default'
                    ? 'Model that new threads start with…'
                    : 'Search models…'
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
          {/*
            * A filter of its own, because there are eleven of these among four
            * hundred and forty-four models and no amount of scrolling finds
            * them. They are not a separate kind of thing to the app — an image
            * model is a chat model that answers with a picture — but they are
            * a separate thing to look for.
            */}
          <label className="switch" style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={drawsOnly}
              onChange={(event) => setDrawsOnly(event.target.checked)}
            />
            Can draw images
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
        {filtered.slice(0, built).map((model, index) => (
          <button
            key={model.id}
            className="cmditem"
            data-active={index === cursor}
            onMouseEnter={() => setCursor(index)}
            onClick={() => void choose(model.id)}
            type="button"
          >
            {/* Whose model it is, ahead of the name. Here the mark leads
                rather than trails, because a list of four hundred models is
                scanned by house first — you are looking for the Anthropic
                block, then for one within it. */}
            <ModelIcon model={model.id} size={16} />
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
              {model.outputModalities.includes('image') && (
                <span
                  className="chip chip--accent"
                  /*
                   * The price is on the chip because it is the one the
                   * headline pair does not tell you and the one that
                   * dominates. A single 1024px picture from
                   * gemini-2.5-flash-image came back as 1,290 image tokens
                   * (measured 2026-09-22) — four cents, on a model whose
                   * prompt and completion prices read as a rounding error.
                   */
                  title={`Answers with pictures. Image output is ${pricePerMillion(
                    model.pricing.imageOutput
                  )} image tokens — one 1024px picture is roughly 1,300 of them.`}
                >
                  images {model.pricing.imageOutput ? pricePerMillion(model.pricing.imageOutput) : ''}
                </span>
              )}
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
