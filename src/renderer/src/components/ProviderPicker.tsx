import { useEffect, useState } from 'react'
import type { ModelEndpoint, ProviderRouting } from '@shared/types'
import { useStore } from '../store'
import { Overlay } from './Overlay'
import { formatTokens, modelShortName } from '../format'

interface Props {
  onClose: () => void
}

const BLANK: ProviderRouting = {
  order: [],
  allowFallbacks: true,
  only: [],
  ignore: [],
  sort: null,
  requireParameters: false,
  dataCollection: 'deny'
}

function price(value: number): string {
  return value ? `$${(value * 1_000_000).toFixed(2)}/M` : 'free'
}

/**
 * Chooses which upstream provider serves a model. Pinning writes `only` +
 * `allow_fallbacks: false`, which is what actually forces OpenRouter's hand.
 */
export function ProviderPicker({ onClose }: Props): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const threads = useStore((s) => s.threads)
  const activeThreadId = useStore((s) => s.activeThreadId)
  const updateThread = useStore((s) => s.updateThread)
  const saveSettings = useStore((s) => s.saveSettings)
  const showToast = useStore((s) => s.showToast)

  const thread = threads.find((t) => t.id === activeThreadId) ?? null
  const model = thread?.config.model ?? settings?.defaultModel ?? ''

  const [scope, setScope] = useState<'thread' | 'model'>('thread')
  const [endpoints, setEndpoints] = useState<ModelEndpoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const effective: ProviderRouting =
    (scope === 'thread' ? thread?.config.providerRouting : null) ??
    settings?.modelProviderRouting[model] ??
    settings?.defaultProviderRouting ??
    BLANK

  useEffect(() => {
    if (!model) return
    let cancelled = false
    setEndpoints(null)
    setError(null)
    window.deepPink.models
      .endpoints(model)
      .then((list) => {
        if (!cancelled) setEndpoints(list)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [model])

  const apply = async (routing: ProviderRouting | null): Promise<void> => {
    if (scope === 'thread') {
      if (!thread) return
      await updateThread(thread.id, { config: { providerRouting: routing } })
    } else {
      const next = { ...(settings?.modelProviderRouting ?? {}) }
      if (routing) next[model] = routing
      else delete next[model]
      await saveSettings({ modelProviderRouting: next })
    }
    showToast(
      routing?.only.length
        ? `Pinned to ${routing.only[0]}`
        : routing
          ? 'Routing preference saved'
          : 'Back to automatic routing'
    )
  }

  const pin = (providerTag: string): Promise<void> =>
    apply({ ...effective, only: [providerTag], order: [providerTag], allowFallbacks: false })

  const isPinned = (tag: string): boolean => effective.only.includes(tag)

  return (
    <Overlay
      title={`Provider routing — ${modelShortName(model)}`}
      onClose={onClose}
      wide
      footer={
        <>
          <span>
            {effective.only.length
              ? `Pinned to ${effective.only.join(', ')}`
              : effective.order.length
                ? `Preferring ${effective.order.join(' → ')}`
                : 'Automatic — OpenRouter picks'}
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => void apply(null)} type="button">
            Reset to automatic
          </button>
        </>
      }
    >
      <div className="panel__body">
        <div className="row" style={{ marginBottom: 14 }}>
          <span className="field__label">Applies to</span>
          <button
            className="btn"
            data-on={scope === 'thread'}
            onClick={() => setScope('thread')}
            type="button"
            disabled={!thread}
          >
            This thread
          </button>
          <button
            className="btn"
            data-on={scope === 'model'}
            onClick={() => setScope('model')}
            type="button"
          >
            Every use of {modelShortName(model)}
          </button>
        </div>

        <div className="section-title">Providers serving this model</div>

        {error && <div className="message__error">{error}</div>}
        {!endpoints && !error && <p className="dim">Loading providers…</p>}
        {endpoints?.length === 0 && <p className="dim">No provider information available.</p>}

        {endpoints?.map((endpoint) => (
          <div className="list-card" key={`${endpoint.providerName}:${endpoint.tag}`}>
            <div className="spread">
              <div style={{ minWidth: 0 }}>
                <div className="row">
                  <strong>{endpoint.providerName}</strong>
                  {isPinned(endpoint.tag) && <span className="chip chip--accent">pinned</span>}
                  {endpoint.quantization && <span className="chip">{endpoint.quantization}</span>}
                </div>
                <div className="row row--wrap dim" style={{ fontSize: 12, marginTop: 4 }}>
                  <span>in {price(endpoint.pricing.prompt)}</span>
                  <span>out {price(endpoint.pricing.completion)}</span>
                  {endpoint.contextLength && <span>{formatTokens(endpoint.contextLength)} ctx</span>}
                  {endpoint.maxCompletionTokens && (
                    <span>max out {formatTokens(endpoint.maxCompletionTokens)}</span>
                  )}
                  {endpoint.uptimeLast30m != null && (
                    <span>{endpoint.uptimeLast30m.toFixed(1)}% uptime</span>
                  )}
                </div>
              </div>
              <button
                className={isPinned(endpoint.tag) ? 'btn btn--primary' : 'btn'}
                onClick={() => void pin(endpoint.tag)}
                type="button"
              >
                {isPinned(endpoint.tag) ? 'Pinned' : 'Use only this'}
              </button>
            </div>
          </div>
        ))}

        <div className="section-title">Routing options</div>

        <label className="switch" style={{ marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={effective.allowFallbacks}
            onChange={(event) => void apply({ ...effective, allowFallbacks: event.target.checked })}
          />
          <span>
            Allow fallbacks
            <span className="field__hint">
              With this off and a provider pinned, a request fails rather than silently moving
              elsewhere.
            </span>
          </span>
        </label>

        <label className="switch" style={{ marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={effective.dataCollection === 'deny'}
            onChange={(event) =>
              void apply({
                ...effective,
                dataCollection: event.target.checked ? 'deny' : 'allow'
              })
            }
          />
          <span>
            Only providers that do not train on your data
            <span className="field__hint">Sends `data_collection: deny` with every request.</span>
          </span>
        </label>

        <label className="switch" style={{ marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={effective.requireParameters}
            onChange={(event) =>
              void apply({ ...effective, requireParameters: event.target.checked })
            }
          />
          <span>
            Require full parameter support
            <span className="field__hint">
              Skips providers that would silently drop options such as tools or temperature.
            </span>
          </span>
        </label>

        <div className="field">
          <span className="field__label">Sort remaining providers by</span>
          <select
            className="select"
            value={effective.sort ?? ''}
            onChange={(event) =>
              void apply({
                ...effective,
                sort: (event.target.value || null) as ProviderRouting['sort']
              })
            }
          >
            <option value="">Default (balanced)</option>
            <option value="price">Lowest price</option>
            <option value="throughput">Highest throughput</option>
            <option value="latency">Lowest latency</option>
          </select>
        </div>
      </div>
    </Overlay>
  )
}
