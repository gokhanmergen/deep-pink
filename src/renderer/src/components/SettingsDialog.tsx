import { useEffect, useState, type ReactNode } from 'react'
import {
  BarChart3,
  Database,
  Pause,
  Play,
  RefreshCw,
  Globe,
  KeyRound,
  Keyboard,
  Layers,
  MessageSquareText,
  Palette,
  Cpu,
  X
} from 'lucide-react'
import { ICON } from '../icons'
import { useStore } from '../store'
import { Overlay } from './Overlay'
import { KEYBIND_GROUPS, formatBinding } from '../keybinds'
import { DEFAULT_KEYBINDS, DEFAULT_UI } from '@shared/defaults'
import { modelShortName } from '../format'
import { DebouncedInput, DebouncedTextarea } from './DebouncedField'
import type { AppInfo, ImportPreview, ImportResult } from '@shared/types'
import { formatRelative } from '../format'
import { CHARTS_PROMPT } from '@shared/charts'

type Tab =
  | 'account'
  | 'models'
  | 'prompts'
  | 'web'
  | 'charts'
  | 'context'
  | 'appearance'
  | 'keys'
  | 'data'
  | 'sync'

interface TabDef {
  id: Tab
  label: string
  icon: ReactNode
}

/**
 * The sections, down the side.
 *
 * Grouped because eight entries in one column read as a list to be searched,
 * where three short lists read as a shape you learn once and then aim at.
 */
const TAB_GROUPS: { title?: string; tabs: TabDef[] }[] = [
  {
    tabs: [
      { id: 'account', label: 'Account', icon: <KeyRound {...ICON} /> },
      { id: 'models', label: 'Models', icon: <Cpu {...ICON} /> },
      { id: 'prompts', label: 'Prompts', icon: <MessageSquareText {...ICON} /> }
    ]
  },
  {
    title: 'Capabilities',
    tabs: [
      { id: 'web', label: 'Web access', icon: <Globe {...ICON} /> },
      { id: 'charts', label: 'Charts', icon: <BarChart3 {...ICON} /> },
      { id: 'context', label: 'Context', icon: <Layers {...ICON} /> }
    ]
  },
  {
    title: 'The app',
    tabs: [
      { id: 'appearance', label: 'Appearance', icon: <Palette {...ICON} /> },
      { id: 'keys', label: 'Keyboard', icon: <Keyboard {...ICON} /> },
      { id: 'data', label: 'Data', icon: <Database {...ICON} /> },
      { id: 'sync', label: 'Sync', icon: <RefreshCw {...ICON} /> }
    ]
  }
]

/** Nine in the morning, tomorrow — which is what "until tomorrow" means. */
function tomorrowMorning(): number {
  const at = new Date()
  at.setDate(at.getDate() + 1)
  at.setHours(9, 0, 0, 0)
  return at.getTime()
}

export function SettingsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const refreshSettings = useStore((s) => s.refreshSettings)
  const setOverlay = useStore((s) => s.setOverlay)
  const showToast = useStore((s) => s.showToast)

  const [tab, setTab] = useState<Tab>(settings?.hasApiKey ? 'models' : 'account')
  const [apiKey, setApiKey] = useState('')
  const [dbLocation, setDbLocation] = useState('')
  const [encryption, setEncryption] = useState(true)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [capturing, setCapturing] = useState<string | null>(null)
  const [importPath, setImportPath] = useState<string | null>(null)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [importBusy, setImportBusy] = useState(false)

  const sync = useStore((s) => s.sync)
  const syncProgress = useStore((s) => s.syncProgress)
  const refreshSync = useStore((s) => s.refreshSync)
  const pauseSync = useStore((s) => s.pauseSync)
  const resumeSync = useStore((s) => s.resumeSync)
  const runSync = useStore((s) => s.runSync)
  const [syncBusy, setSyncBusy] = useState('')
  const [revealed, setRevealed] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [secretDraft, setSecretDraft] = useState('')

  // The store keeps this current for the sidebar's line; opening the panel is
  // a reason to be sure it is fresh.
  useEffect(() => {
    void refreshSync()
  }, [refreshSync])

  useEffect(() => {
    void window.deepPink.data.path().then(setDbLocation)
    void window.deepPink.settings.encryptionAvailable().then(setEncryption)
    void window.deepPink.app.info().then(setInfo)
  }, [])

  // While capturing a shortcut, swallow the keystroke and store it.
  useEffect(() => {
    if (!capturing) return
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setCapturing(null)
        return
      }
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return

      const parts: string[] = []
      if (event.metaKey || event.ctrlKey) parts.push('mod')
      if (event.shiftKey) parts.push('shift')
      if (event.altKey) parts.push('alt')

      const key = event.key.toLowerCase()
      parts.push(
        { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', ' ': 'space' }[
          key
        ] ?? key
      )

      void saveSettings({ keybinds: { [capturing]: parts.join('+') } })
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, saveSettings])

  if (!settings) return <Overlay title="Settings" onClose={onClose}><div className="panel__body" /></Overlay>

  const saveKey = async (): Promise<void> => {
    await window.deepPink.settings.setApiKey(apiKey)
    setApiKey('')
    await refreshSettings()
    await useStore.getState().refreshModels(true)
    showToast('API key saved')
  }

  return (
    <Overlay
      title="Settings"
      onClose={onClose}
      wide
      header={
        <div className="panel__head">
          <span className="panel__title">Settings</span>
          <div style={{ flex: 1 }} />
          <button className="btn btn--ghost" onClick={onClose} type="button" aria-label="Close">
            <X {...ICON} />
          </button>
        </div>
      }
    >
      <div className="settings-split">
        <nav className="tabs" aria-label="Settings sections">
          {TAB_GROUPS.map((group, index) => (
            <div className="tabs__group" key={group.title ?? `group-${index}`}>
              {group.title && <div className="tabs__label">{group.title}</div>}
              {group.tabs.map((entry) => (
                <button
                  key={entry.id}
                  className="tab"
                  data-active={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                  title={entry.label}
                  aria-label={entry.label}
                  aria-current={tab === entry.id ? 'page' : undefined}
                  type="button"
                >
                  {entry.icon}
                  <span className="tab__label">{entry.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="panel__body">
        {tab === 'account' && (
          <>
            <div className="section-title">OpenRouter API key</div>
            <div className="field">
              <input
                className="input mono"
                type="password"
                placeholder={settings.hasApiKey ? '•••••••••••••••• (saved)' : 'sk-or-v1-…'}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveKey()
                }}
              />
              <span className="field__hint">
                {encryption
                  ? 'Encrypted with your OS keyring and stored on this machine only.'
                  : 'No system keyring is available, so the key is stored in a file readable only by your user account.'}
              </span>
              <div className="row">
                <button className="btn btn--primary" onClick={() => void saveKey()} disabled={!apiKey.trim()} type="button">
                  Save key
                </button>
                {settings.hasApiKey && (
                  <button
                    className="btn btn--danger"
                    onClick={async () => {
                      await window.deepPink.settings.setApiKey('')
                      await refreshSettings()
                      showToast('API key removed')
                    }}
                    type="button"
                  >
                    Remove key
                  </button>
                )}
                <button
                  className="btn btn--ghost"
                  onClick={() => void window.deepPink.shell.openExternal('https://openrouter.ai/keys')}
                  type="button"
                >
                  Get a key ↗
                </button>
              </div>
            </div>

            <div className="section-title">Attribution</div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.sendAppAttribution}
                onChange={(event) => void saveSettings({ sendAppAttribution: event.target.checked })}
              />
              <span>
                Identify Deep Pink to OpenRouter
                <span className="field__hint">
                  On by default. Requests carry the app name and repository URL — the app is
                  named, you are not — which is what puts a client on OpenRouter's public
                  leaderboards. Turn it off and requests go out anonymously.
                </span>
              </span>
            </label>
          </>
        )}

        {tab === 'models' && (
          <>
            <div className="section-title">Default model</div>
            <div className="field">
              <div className="row">
                <button
                  className="btn"
                  onClick={() => setOverlay('defaultModel', 'settings')}
                  type="button"
                >
                  {modelShortName(settings.defaultModel)}
                </button>
                <span className="field__hint">
                  What new threads start with. Changing it leaves open threads alone — use{' '}
                  <span className="kbd">{formatBinding(settings.keybinds['model.picker'])}</span> for
                  the thread you are in.
                </span>
              </div>
            </div>

            <div className="section-title">Thread names</div>
            <label className="switch" style={{ marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={settings.titleGenerationEnabled}
                onChange={(event) =>
                  void saveSettings({ titleGenerationEnabled: event.target.checked })
                }
              />
              <span>
                Name threads automatically
                <span className="field__hint">
                  Runs once after the first exchange. Its cost is included in your statistics.
                </span>
              </span>
            </label>

            <div className="field">
              <span className="field__label">Model used to generate thread names</span>
              <div className="row">
                <button
                  className="btn"
                  onClick={() => setOverlay('titleModel', 'settings')}
                  type="button"
                >
                  {modelShortName(settings.titleModel)}
                </button>
                <span className="field__hint">A small, cheap model is usually the right call.</span>
              </div>
            </div>

            <div className="field">
              <span className="field__label">Naming prompt</span>
              <DebouncedTextarea
                className="textarea"
                rows={6}
                value={settings.titlePrompt}
                onCommit={(next) => void saveSettings({ titlePrompt: next })}
              />
            </div>

            <div className="section-title">Generation</div>
            <div className="field">
              <span className="field__label">Temperature — {settings.temperature.toFixed(2)}</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={settings.temperature}
                onChange={(event) => void saveSettings({ temperature: Number(event.target.value) })}
              />
            </div>
            <div className="field">
              <span className="field__label">Maximum output tokens</span>
              <DebouncedInput
                className="input"
                type="number"
                min={0}
                placeholder="Provider default"
                value={settings.maxTokens != null ? String(settings.maxTokens) : ''}
                onCommit={(next) =>
                  void saveSettings({ maxTokens: next ? Number(next) : null })
                }
              />
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.streamReasoning}
                onChange={(event) => void saveSettings({ streamReasoning: event.target.checked })}
              />
              <span>Request reasoning traces when the model supports them</span>
            </label>
          </>
        )}

        {tab === 'prompts' && (
          <>
            <div className="section-title">Base system prompt</div>
            <div className="field">
              <DebouncedTextarea
                className="textarea"
                rows={10}
                value={settings.baseSystemPrompt}
                onCommit={(next) => void saveSettings({ baseSystemPrompt: next })}
              />
              <span className="field__hint">
                Sent with every thread unless you switch it off for that thread in the prompt
                inspector.
              </span>
            </div>

            <label className="switch">
              <input
                type="checkbox"
                checked={settings.includeDateTimeInPrompt}
                onChange={(event) =>
                  void saveSettings({ includeDateTimeInPrompt: event.target.checked })
                }
              />
              <span>
                Tell the model the current date and time
                <span className="field__hint">
                  Adds one line to the system prompt. Off by default — it is information about you.
                </span>
              </span>
            </label>
          </>
        )}

        {tab === 'web' && (
          <>
            <div className="section-title">Web access</div>
            <label className="switch" style={{ marginBottom: 14 }}>
              <input
                type="checkbox"
                checked={settings.web.enabled}
                onChange={(event) => void saveSettings({ web: { enabled: event.target.checked } })}
              />
              <span>
                Enable web search and fetch by default
                <span className="field__hint">
                  Can be toggled per thread from the composer. When off, no search or page fetch
                  ever happens.
                </span>
              </span>
            </label>

            <div className="field">
              <span className="field__label">Search backend</span>
              <select
                className="select"
                value={settings.web.engine}
                onChange={(event) =>
                  void saveSettings({
                    web: { engine: event.target.value as typeof settings.web.engine }
                  })
                }
              >
                <option value="duckduckgo">DuckDuckGo (free, no key)</option>
                <option value="searxng">SearXNG (your own instance)</option>
                <option value="openrouter">OpenRouter web plugin (billed per search)</option>
              </select>
              <span className="field__hint">
                DuckDuckGo publishes no API, so this scrapes their HTML endpoint — free, but it
                rate-limits bursts and can break without notice. SearXNG is the dependable free
                option if you run one. The OpenRouter plugin needs no setup but is billed per
                search.
                <br />
                The first two are tools the model chooses to call, so they need a tool-capable
                model. The plugin instead appends `:online` and lets OpenRouter search.
              </span>
            </div>

            {settings.web.engine === 'searxng' && (
              <div className="field">
                <span className="field__label">SearXNG URL</span>
                <DebouncedInput
                  className="input mono"
                  value={settings.web.searxngUrl}
                  onCommit={(next) => void saveSettings({ web: { searxngUrl: next } })}
                />
              </div>
            )}

            <div className="field">
              <span className="field__label">Results per search</span>
              <DebouncedInput
                className="input"
                type="number"
                min={1}
                max={10}
                value={String(settings.web.maxResults)}
                onCommit={(next) => void saveSettings({ web: { maxResults: Number(next) || 1 } })}
              />
            </div>

            <div className="field">
              <span className="field__label">Characters kept per fetched page</span>
              <DebouncedInput
                className="input"
                type="number"
                min={1000}
                step={1000}
                value={String(settings.web.fetchCharLimit)}
                onCommit={(next) =>
                  void saveSettings({ web: { fetchCharLimit: Number(next) || 1000 } })
                }
              />
            </div>

            <div className="field">
              <span className="field__label">Blocked domains</span>
              <DebouncedTextarea
                className="textarea mono"
                rows={3}
                placeholder={'example.com\ninternal.corp'}
                value={settings.web.blockedDomains.join('\n')}
                onCommit={(next) =>
                  void saveSettings({
                    web: {
                      blockedDomains: next.split('\n').map((d) => d.trim()).filter(Boolean)
                    }
                  })
                }
              />
              <span className="field__hint">
                Loopback, link-local and private addresses are always refused.
              </span>
            </div>
          </>
        )}

        {tab === 'charts' && (
          <>
            <div className="section-title">Charts in replies</div>
            <label className="switch" style={{ marginBottom: 14 }}>
              <input
                type="checkbox"
                checked={settings.chartsEnabled}
                onChange={(event) => void saveSettings({ chartsEnabled: event.target.checked })}
              />
              <span>
                Let replies draw charts
                <span className="field__hint">
                  Can be toggled per thread from the composer. When off the model is not told it
                  can draw, and any chart that arrives anyway — from an import, or a model that
                  guessed — is shown as the code it is.
                </span>
              </span>
            </label>

            <div className="field">
              <span className="field__label">What it can draw</span>
              <div className="row row--wrap">
                {['line', 'area', 'bar', 'column', 'scatter'].map((kind) => (
                  <span className="chip mono" key={kind}>
                    {kind}
                  </span>
                ))}
              </div>
              <span className="field__hint">
                A <span className="mono">dp-chart</span> block of JSON, drawn by this app in the
                same palette as the statistics panels: the model chooses the numbers and Deep
                Pink chooses the colours, the scale and the marks. There is no pie, because a
                part-to-whole reads better as a bar.
              </span>
            </div>

            <details className="disclosure">
              <summary className="disclosure__summary">
                <span className="chip">system prompt</span>
                <span>
                  What the model is told — about{' '}
                  {Math.ceil(CHARTS_PROMPT.length / 4).toLocaleString()} tokens per turn
                </span>
              </summary>
              <div className="disclosure__content">
                <pre>{CHARTS_PROMPT}</pre>
              </div>
            </details>
          </>
        )}

        {tab === 'sync' && sync && (
          <>
            <div className="section-title">Sync</div>
            <label className="switch" style={{ marginBottom: 14 }}>
              <input
                type="checkbox"
                checked={sync.config.enabled}
                disabled={!sync.hasKey || !sync.hasSecret}
                onChange={async (event) =>
                  useStore.setState({ sync: await window.deepPink.sync.save({ enabled: event.target.checked }) })
                }
              />
              <span>
                Keep this machine in step with the others
                <span className="field__hint">
                  Your conversations are encrypted here, with a key the storage provider never
                  sees, and only then uploaded. Syncing happens on its own — a few seconds after
                  something changes, and every five minutes for whatever changed elsewhere.
                </span>
              </span>
            </label>

            {sync.config.enabled && sync.ready && (
              <div className="field">
                <span className="field__label">
                  {sync.paused ? 'Paused' : 'Automatic syncing'}
                </span>
                <span className="field__hint">
                  {sync.paused
                    ? sync.config.pause?.until
                      ? `Nothing will sync on its own until ${new Date(
                          sync.config.pause.until
                        ).toLocaleString([], {
                          weekday: 'short',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}. Sync now still works.`
                      : 'Nothing will sync on its own until you resume. Sync now still works.'
                    : 'Runs a few seconds after something changes, and every five minutes for what changed elsewhere.'}
                </span>
                <div className="row row--wrap">
                  {sync.paused ? (
                    <button
                      className="btn btn--primary"
                      onClick={() => void resumeSync()}
                      type="button"
                    >
                      <Play {...ICON} />
                      Resume
                    </button>
                  ) : (
                    <>
                      <button
                        className="btn"
                        onClick={() => void pauseSync(Date.now() + 60 * 60 * 1000)}
                        type="button"
                      >
                        <Pause {...ICON} />
                        Pause for an hour
                      </button>
                      <button
                        className="btn"
                        onClick={() => void pauseSync(tomorrowMorning())}
                        type="button"
                      >
                        Until tomorrow
                      </button>
                      <button className="btn" onClick={() => void pauseSync(null)} type="button">
                        Until I resume
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="section-title">The key</div>
            {sync.hasKey ? (
              <div className="field">
                <div className="row">
                  <span className="chip mono">{sync.keyFingerprint}</span>
                  <span className="field__hint" style={{ margin: 0 }}>
                    Every machine on this bucket must show the same eight characters.
                  </span>
                </div>
                {revealed ? (
                  <>
                    <input className="input mono" readOnly value={revealed} onFocus={(e) => e.target.select()} />
                    <div className="row">
                      <button
                        className="btn"
                        onClick={() => {
                          void navigator.clipboard.writeText(revealed)
                          showToast('Key copied — keep it somewhere safe')
                        }}
                        type="button"
                      >
                        Copy
                      </button>
                      <button className="btn" onClick={() => setRevealed(null)} type="button">
                        Hide
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="row">
                    <button
                      className="btn"
                      onClick={async () => setRevealed(await window.deepPink.sync.revealKey())}
                      type="button"
                    >
                      Show the key
                    </button>
                  </div>
                )}
                <span className="field__hint">
                  This is the only thing that can decrypt what is in the bucket. Nobody can
                  recover it for you — not the storage provider, and not us. Write it down before
                  you need it.
                </span>
              </div>
            ) : (
              <div className="field">
                <span className="field__hint">
                  256 bits of randomness, used to encrypt everything before it leaves this
                  machine. Symmetric, so there is no public key to be broken later: a quantum
                  computer running Grover's algorithm would still face 128 bits, which is beyond
                  reach. Generate one here, then import the same key on your other machines.
                </span>
                <div className="row">
                  <button
                    className="btn btn--primary"
                    onClick={async () => {
                      try {
                        setRevealed(await window.deepPink.sync.createKey())
                        useStore.setState({ sync: await window.deepPink.sync.state() })
                        showToast('Key generated — copy it to your other machines')
                      } catch (err) {
                        showToast(err instanceof Error ? err.message : String(err), 'error')
                      }
                    }}
                    type="button"
                  >
                    Generate a key
                  </button>
                </div>
                <span className="field__label" style={{ marginTop: 10 }}>
                  Or paste the key from another machine
                </span>
                <div className="row">
                  <input
                    className="input mono"
                    placeholder="DPSK1-..."
                    value={keyDraft}
                    onChange={(event) => setKeyDraft(event.target.value)}
                  />
                  <button
                    className="btn"
                    disabled={!keyDraft.trim()}
                    onClick={async () => {
                      try {
                        useStore.setState({ sync: await window.deepPink.sync.importKey(keyDraft) })
                        setKeyDraft('')
                        showToast('Key imported')
                      } catch (err) {
                        showToast(err instanceof Error ? err.message : String(err), 'error')
                      }
                    }}
                    type="button"
                  >
                    Import
                  </button>
                </div>
              </div>
            )}

            <div className="section-title">Where it is kept</div>
            <span className="field__hint" style={{ marginBottom: 10, display: 'block' }}>
              Any S3-compatible bucket: AWS, Cloudflare R2, Backblaze B2, MinIO on your own
              machine. It only ever holds ciphertext under names that give nothing away, so the
              provider learns how much you have and when, and nothing else.
            </span>

            <div className="field">
              <span className="field__label">Endpoint</span>
              <DebouncedInput
                className="input mono"
                placeholder="https://<account>.r2.cloudflarestorage.com — leave empty for AWS"
                value={sync.config.endpoint}
                onCommit={async (next) => useStore.setState({ sync: await window.deepPink.sync.save({ endpoint: next }) })}
              />
              <span className="field__hint">
                The account's S3 URL. Providers often show one with the bucket already on the end
                of it — that form works too.
              </span>
            </div>

            <div className="row">
              <div className="field" style={{ flex: 1 }}>
                <span className="field__label">Bucket</span>
                <DebouncedInput
                  className="input mono"
                  value={sync.config.bucket}
                  onCommit={async (next) => useStore.setState({ sync: await window.deepPink.sync.save({ bucket: next }) })}
                />
              </div>
              <div className="field" style={{ width: 130 }}>
                <span className="field__label">Region</span>
                <DebouncedInput
                  className="input mono"
                  value={sync.config.region}
                  onCommit={async (next) => useStore.setState({ sync: await window.deepPink.sync.save({ region: next }) })}
                />
              </div>
            </div>

            <div className="field">
              <span className="field__label">Access key ID</span>
              <DebouncedInput
                className="input mono"
                value={sync.config.accessKeyId}
                onCommit={async (next) =>
                  useStore.setState({ sync: await window.deepPink.sync.save({ accessKeyId: next }) })
                }
              />
            </div>

            <div className="field">
              <span className="field__label">Secret access key</span>
              <div className="row">
                <input
                  className="input mono"
                  type="password"
                  placeholder={sync.hasSecret ? '•••••••• stored' : 'not set'}
                  value={secretDraft}
                  onChange={(event) => setSecretDraft(event.target.value)}
                />
                <button
                  className="btn"
                  disabled={!secretDraft.trim()}
                  onClick={async () => {
                    useStore.setState({ sync: await window.deepPink.sync.setSecret(secretDraft) })
                    setSecretDraft('')
                    showToast('Secret stored')
                  }}
                  type="button"
                >
                  Save
                </button>
              </div>
              <span className="field__hint">
                Kept in the OS keyring beside your OpenRouter key, and never sent to the window.
              </span>
            </div>

            <div className="field">
              <span className="field__label">Prefix</span>
              <DebouncedInput
                className="input mono"
                value={sync.config.prefix}
                onCommit={async (next) => useStore.setState({ sync: await window.deepPink.sync.save({ prefix: next }) })}
              />
              <span className="field__hint">
                The folder inside the bucket. Two different prefixes are two separate libraries.
              </span>
            </div>

            <div className="row">
              <button
                className="btn"
                disabled={syncBusy === 'test'}
                onClick={async () => {
                  setSyncBusy('test')
                  try {
                    await window.deepPink.sync.test()
                    showToast('The bucket answered — settings look right')
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : String(err), 'error')
                  } finally {
                    setSyncBusy('')
                  }
                }}
                type="button"
              >
                {syncBusy === 'test' ? 'Checking…' : 'Test the connection'}
              </button>
            </div>

            <div className="section-title">What travels</div>
            <label className="switch">
              <input
                type="checkbox"
                checked={sync.config.scopes.conversations}
                onChange={async (event) =>
                  useStore.setState({ sync: await window.deepPink.sync.save({
                      scopes: { ...sync.config.scopes, conversations: event.target.checked }
                    }) })
                }
              />
              <span>
                Conversations
                <span className="field__hint">
                  Threads, messages, folders and every attachment, with their costs.
                </span>
              </span>
            </label>

            <label className="switch">
              <input
                type="checkbox"
                checked={sync.config.scopes.settings}
                onChange={async (event) =>
                  useStore.setState({ sync: await window.deepPink.sync.save({
                      scopes: { ...sync.config.scopes, settings: event.target.checked }
                    }) })
                }
              />
              <span>
                Settings and MCP servers
                <span className="field__hint">
                  Prompts, models, shortcuts, appearance and your configured servers. Your
                  OpenRouter key is never included — it stays on the machine it was entered on.
                </span>
              </span>
            </label>

            <div className="field" style={{ marginTop: 14 }}>
              <span className="field__label">This machine is called</span>
              <DebouncedInput
                className="input"
                value={sync.config.deviceName}
                onCommit={async (next) =>
                  useStore.setState({ sync: await window.deepPink.sync.save({ deviceName: next }) })
                }
              />
            </div>

            <div className="section-title">Status</div>
            <div className="list-card">
              <div className="spread">
                <strong>
                  {sync.running
                    ? 'Syncing…'
                    : sync.paused
                      ? sync.lastSyncedAt
                        ? `Paused — last synced ${formatRelative(sync.lastSyncedAt)}`
                        : 'Paused'
                      : sync.lastSyncedAt
                        ? `Last synced ${formatRelative(sync.lastSyncedAt)}`
                        : 'Not synced yet'}
                </strong>
                <button
                  className="btn"
                  disabled={!sync.ready || !sync.config.enabled || sync.running || syncBusy === 'run'}
                  title={sync.paused ? 'Paused, but this runs one sync now' : 'Sync now'}
                  onClick={async () => {
                    setSyncBusy('run')
                    try {
                      // Through the store, so this panel and the sidebar's
                      // line are reporting the same run.
                      await runSync()
                      await refreshSettings()
                    } finally {
                      setSyncBusy('')
                    }
                  }}
                  type="button"
                >
                  {syncBusy === 'run' ? 'Syncing…' : 'Sync now'}
                </button>
              </div>
              {sync.running && (
                <>
                  <div className="syncphase">
                    <span>{syncProgress?.detail ?? 'starting…'}</span>
                    {syncProgress && syncProgress.total > 1 && (
                      <span className="syncphase__count">
                        {syncProgress.done} of {syncProgress.total}
                      </span>
                    )}
                  </div>
                  <div className="syncbar">
                    <span
                      className="syncbar__fill"
                      data-indeterminate={!syncProgress || syncProgress.total < 1}
                      style={
                        syncProgress && syncProgress.total > 0
                          ? {
                              width: `${Math.min((syncProgress.done / syncProgress.total) * 100, 100)}%`
                            }
                          : undefined
                      }
                    />
                  </div>
                </>
              )}

              <div className="dim" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
                {!sync.hasKey && <>No key yet — generate or import one above.<br /></>}
                {sync.hasKey && !sync.hasSecret && <>No bucket credentials yet.<br /></>}
                {sync.lastResult && (
                  <>
                    {sync.lastResult.devices} machine
                    {sync.lastResult.devices === 1 ? '' : 's'} on this bucket · sent{' '}
                    {sync.lastResult.pushed}, received {sync.lastResult.pulled}
                    {sync.lastResult.deleted > 0 && <>, removed {sync.lastResult.deleted}</>}
                    <br />
                  </>
                )}
                {sync.lastError && <span style={{ color: 'var(--red)' }}>{sync.lastError}</span>}
              </div>
            </div>

            <div className="section-title">Disconnect</div>
            <div className="field">
              <span className="field__hint">
                Forgets the key, the credentials and these settings on this machine. Nothing in
                the bucket is touched, and nothing here is deleted — but without the key this
                machine can no longer read what is up there.
              </span>
              <div className="row">
                <button
                  className="btn btn--danger"
                  onClick={async () => {
                    const ok = await useStore.getState().askConfirm({
                      title: 'Disconnect this machine from sync?',
                      body: 'The key and the bucket credentials are erased from this machine. Make sure the key is written down somewhere first, or what is in the bucket becomes unreadable.',
                      confirmLabel: 'Disconnect',
                      danger: true
                    })
                    if (!ok) return
                    useStore.setState({ sync: await window.deepPink.sync.disconnect() })
                    setRevealed(null)
                    showToast('Disconnected')
                  }}
                  type="button"
                >
                  Disconnect
                </button>
              </div>
            </div>
          </>
        )}

        {tab === 'context' && (
          <>
            <div className="section-title">Compaction</div>
            <label className="switch" style={{ marginBottom: 14 }}>
              <input
                type="checkbox"
                checked={settings.compaction.enabled}
                onChange={(event) =>
                  void saveSettings({ compaction: { enabled: event.target.checked } })
                }
              />
              <span>
                Compact long threads
                <span className="field__hint">
                  Replaces the older part of a conversation with a summary so the thread can keep
                  going. The originals stay in your database.
                </span>
              </span>
            </label>

            <label className="switch" style={{ marginBottom: 14 }}>
              <input
                type="checkbox"
                checked={settings.compaction.requireConfirmation}
                onChange={(event) =>
                  void saveSettings({ compaction: { requireConfirmation: event.target.checked } })
                }
              />
              <span>
                Only compact when I ask
                <span className="field__hint">
                  With this off, compaction runs automatically once the threshold is crossed.
                </span>
              </span>
            </label>

            <div className="field">
              <span className="field__label">
                Trigger at {Math.round(settings.compaction.triggerRatio * 100)}% of the context
                window
              </span>
              <input
                type="range"
                min={0.3}
                max={0.95}
                step={0.05}
                value={settings.compaction.triggerRatio}
                onChange={(event) =>
                  void saveSettings({ compaction: { triggerRatio: Number(event.target.value) } })
                }
              />
            </div>

            <div className="field">
              <span className="field__label">Messages always kept verbatim</span>
              <DebouncedInput
                className="input"
                type="number"
                min={2}
                value={String(settings.compaction.keepRecentMessages)}
                onCommit={(next) =>
                  void saveSettings({ compaction: { keepRecentMessages: Number(next) || 2 } })
                }
              />
            </div>

            <div className="field">
              <span className="field__label">Summarisation prompt</span>
              <DebouncedTextarea
                className="textarea"
                rows={10}
                value={settings.compaction.prompt}
                onCommit={(next) => void saveSettings({ compaction: { prompt: next } })}
              />
            </div>
          </>
        )}

        {tab === 'appearance' && (
          <>
            <div className="section-title">Interface</div>
            <div className="field">
              <span className="field__label">Accent colour</span>
              <div className="row">
                <input
                  type="color"
                  value={settings.ui.accent}
                  onChange={(event) => void saveSettings({ ui: { accent: event.target.value } })}
                  style={{ width: 44, height: 30, background: 'none', border: 'none' }}
                />
                <button
                  className="btn"
                  onClick={() => void saveSettings({ ui: { accent: DEFAULT_UI.accent } })}
                  type="button"
                >
                  Reset to the default
                </button>
                <span className="field__hint">
                  Buttons, the brand mark and the graphs all follow it.
                </span>
              </div>
            </div>

            <div className="field">
              <span className="field__label">
                Chat width — {settings.ui.chatWidth}px
                {settings.ui.chatWidth >= 1400 ? ' (as wide as the window)' : ''}
              </span>
              <input
                type="range"
                min={620}
                max={1400}
                step={20}
                value={settings.ui.chatWidth}
                onChange={(event) =>
                  void saveSettings({ ui: { chatWidth: Number(event.target.value) } })
                }
              />
              <span className="field__hint">
                How wide the transcript and the composer are allowed to get. Wider fits more code
                on a line; narrower keeps prose at a measure the eye can track back from.
              </span>
            </div>

            <div className="field">
              <span className="field__label">Text size — {settings.ui.fontSize}px</span>
              <input
                type="range"
                min={12}
                max={19}
                step={1}
                value={settings.ui.fontSize}
                onChange={(event) =>
                  void saveSettings({ ui: { fontSize: Number(event.target.value) } })
                }
              />
            </div>

            <div className="field">
              <span className="field__label">Message spacing</span>
              <select
                className="select"
                value={settings.ui.messageDensity}
                onChange={(event) =>
                  void saveSettings({
                    ui: { messageDensity: event.target.value as 'comfortable' | 'compact' }
                  })
                }
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </div>

            <div className="field">
              <span className="field__label">Code theme</span>
              <select
                className="select"
                value={settings.ui.codeTheme}
                onChange={(event) => void saveSettings({ ui: { codeTheme: event.target.value } })}
              >
                {[
                  'github-dark-default',
                  'github-dark-dimmed',
                  'one-dark-pro',
                  'nord',
                  'dracula',
                  'vitesse-dark',
                  'catppuccin-mocha',
                  'tokyo-night',
                  'material-theme-darker'
                ].map((theme) => (
                  <option key={theme} value={theme}>
                    {theme}
                  </option>
                ))}
              </select>
            </div>

            <label className="switch" style={{ marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={settings.ui.showReasoningByDefault}
                onChange={(event) =>
                  void saveSettings({ ui: { showReasoningByDefault: event.target.checked } })
                }
              />
              <span>Expand reasoning traces by default</span>
            </label>

            <div className="field">
              <span className="field__label">Turn a long paste into an attachment</span>
              <DebouncedInput
                className="input"
                type="number"
                min={0}
                step={500}
                value={String(settings.ui.pasteAsFileThreshold)}
                onCommit={(next) =>
                  void saveSettings({ ui: { pasteAsFileThreshold: Math.max(Number(next) || 0, 0) } })
                }
              />
              <span className="field__hint">
                Pastes at least this many characters become a removable file chip instead of
                filling the composer. The model still receives them as text — this only keeps
                long input readable. Set to 0 to paste everything inline.
              </span>
            </div>

            <label className="switch">
              <input
                type="checkbox"
                checked={settings.ui.sendOnEnter}
                onChange={(event) => void saveSettings({ ui: { sendOnEnter: event.target.checked } })}
              />
              <span>
                Enter sends the message
                <span className="field__hint">
                  When off, use {formatBinding('mod+enter')} to send and Enter for a newline.
                </span>
              </span>
            </label>
          </>
        )}

        {tab === 'keys' && (
          <>
            <p className="field__hint" style={{ marginBottom: 14 }}>
              Click a shortcut, then press the keys you want. Escape cancels.
            </p>
            {KEYBIND_GROUPS.map((group) => (
              <div key={group.title}>
                <div className="section-title">{group.title}</div>
                {group.actions.map((action) => (
                  <div className="spread" key={action.id} style={{ padding: '5px 0' }}>
                    <span className="muted">{action.label}</span>
                    <button
                      className="btn"
                      data-on={capturing === action.id}
                      onClick={() => setCapturing(action.id)}
                      type="button"
                    >
                      {capturing === action.id
                        ? 'Press keys…'
                        : formatBinding(settings.keybinds[action.id] ?? '')}
                    </button>
                  </div>
                ))}
              </div>
            ))}
            <div className="row" style={{ marginTop: 18 }}>
              <button
                className="btn"
                onClick={() => void saveSettings({ keybinds: DEFAULT_KEYBINDS })}
                type="button"
              >
                Restore defaults
              </button>
            </div>
          </>
        )}

        {tab === 'data' && (
          <>
            <div className="section-title">Where your data lives</div>
            <div className="field">
              <input className="input mono" readOnly value={dbLocation} />
              <span className="field__hint">
                One SQLite file holding every thread, message and statistic. Deep Pink never sends
                it anywhere; the only outbound requests are to OpenRouter, to MCP servers you
                configure, and to the web when you turn web access on.
              </span>
              <div className="row">
                <button className="btn" onClick={() => void window.deepPink.data.reveal()} type="button">
                  Show in file manager
                </button>
              </div>
            </div>

            <div className="section-title">Import conversations</div>
            <div className="field">
              <span className="field__hint">
                Two kinds of file are read here, and which one you chose is worked out from the
                file itself. A thread exported from Deep Pink — its name, its settings, every
                message and what each cost — comes back whole. A ChatGPT export (Settings → Data
                controls → Export data) arrives as a <span className="mono">.zip</span>; choose
                that, or <span className="mono">conversations.json</span> from inside it. Nothing
                is uploaded — the file is read on this machine.
              </span>
              <div className="row">
                <button
                  className="btn"
                  disabled={importBusy}
                  onClick={async () => {
                    const path = await window.deepPink.import.choose()
                    if (!path) return
                    setImportPath(path)
                    setImportResult(null)
                    setImportPreview(null)
                    setImportBusy(true)
                    try {
                      setImportPreview(await window.deepPink.import.preview(path))
                    } catch (err) {
                      showToast(err instanceof Error ? err.message : String(err), 'error')
                    } finally {
                      setImportBusy(false)
                    }
                  }}
                  type="button"
                >
                  Choose an export…
                </button>
              </div>
            </div>

            {importPreview && !importResult && (
              <div className="list-card">
                <div className="spread" style={{ marginBottom: 8 }}>
                  <strong className="mono">{importPreview.filename}</strong>
                  <span className="chip">
                    {importPreview.kind === 'deep-pink' ? 'Deep Pink' : 'ChatGPT'} ·{' '}
                    {importPreview.conversations.toLocaleString()}{' '}
                    {importPreview.conversations === 1 ? 'conversation' : 'conversations'}
                  </span>
                </div>
                <div className="dim" style={{ fontSize: 12, lineHeight: 1.6 }}>
                  {importPreview.messages.toLocaleString()} messages
                  {importPreview.oldest && (
                    <> · {new Date(importPreview.oldest).toLocaleDateString()} to{' '}
                    {new Date(importPreview.newest ?? importPreview.oldest).toLocaleDateString()}</>
                  )}
                  {importPreview.imagesFound > 0 && <> · {importPreview.imagesFound} images</>}
                  {importPreview.alreadyImported > 0 && (
                    <>
                      <br />
                      {importPreview.alreadyImported} already imported — those will be left alone.
                    </>
                  )}
                  {(importPreview.skipped.hiddenOrSystem > 0 ||
                    importPreview.skipped.toolTraffic > 0) && (
                    <>
                      <br />
                      Skipping {importPreview.skipped.hiddenOrSystem} hidden or system messages and{' '}
                      {importPreview.skipped.toolTraffic} tool exchanges, which do not read as
                      conversation.
                    </>
                  )}
                  {importPreview.unavailableModels.length > 0 && (
                    <>
                      <br />
                      OpenRouter is not offering you{' '}
                      <span className="mono">{importPreview.unavailableModels.join(', ')}</span>. A
                      thread set to one of those is imported all the same and follows your default
                      model; what each reply was answered by is left as it was.
                    </>
                  )}
                  <br />
                  {importPreview.kind === 'deep-pink'
                    ? 'Costs recorded in the file are restored with it, so your statistics match the library it came from.'
                    : 'Imported chats carry no cost, so your statistics stay accurate.'}
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    className="btn btn--primary"
                    disabled={
                      importBusy ||
                      importPreview.conversations === importPreview.alreadyImported
                    }
                    onClick={async () => {
                      if (!importPath) return
                      setImportBusy(true)
                      try {
                        const result = await window.deepPink.import.run(importPath)
                        setImportResult(result)
                        await useStore.getState().refreshThreads()
                        showToast(
                          `Imported ${result.threadsCreated.toLocaleString()} conversations`
                        )
                      } catch (err) {
                        showToast(err instanceof Error ? err.message : String(err), 'error')
                      } finally {
                        setImportBusy(false)
                      }
                    }}
                    type="button"
                  >
                    {importBusy ? 'Importing…' : 'Import'}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setImportPreview(null)
                      setImportPath(null)
                    }}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {importResult && (
              <div className="list-card">
                <strong>
                  Imported {importResult.threadsCreated.toLocaleString()} conversations and{' '}
                  {importResult.messagesCreated.toLocaleString()} messages.
                </strong>
                <div className="dim" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
                  {importResult.imagesAttached > 0 && (
                    <>{importResult.imagesAttached} images attached. </>
                  )}
                  {importResult.imagesMissing > 0 && (
                    <>
                      {importResult.imagesMissing} images were referenced but not present in the
                      archive.{' '}
                    </>
                  )}
                  {importResult.modelsCleared > 0 && (
                    <>
                      {importResult.modelsCleared}{' '}
                      {importResult.modelsCleared === 1 ? 'thread' : 'threads'} named a model you do
                      not have and will use your default until you change it.{' '}
                    </>
                  )}
                  {importResult.alreadyImported > 0 && (
                    <>{importResult.alreadyImported} were already imported and left untouched.</>
                  )}
                </div>
              </div>
            )}

            <div className="section-title">Danger zone</div>
            <div className="field">
              <span className="field__hint">
                Deletes every thread, message and usage record. Settings, keys and MCP servers are
                kept. If sync is on, this is a deletion like any other and travels to your other
                machines — take this one out of sync first if you only meant to clear this one.
              </span>
              <div className="row">
                <button
                  className="btn btn--danger"
                  onClick={async () => {
                    const ok = await useStore.getState().askConfirm({
                      title: 'Delete every conversation?',
                      body: 'All threads, messages and usage statistics are removed. Settings, keys and MCP servers are kept. This cannot be undone.',
                      confirmLabel: 'Delete everything',
                      danger: true
                    })
                    if (!ok) return
                    await window.deepPink.data.wipe()
                    await useStore.getState().refreshThreads()
                    await useStore.getState().selectThread(null)
                    showToast('All conversation data deleted')
                  }}
                  type="button"
                >
                  Delete all conversations
                </button>
              </div>
            </div>

            <div className="section-title">About</div>
            <p className="dim" style={{ fontSize: 13, lineHeight: 1.6 }}>
              Deep Pink {info?.version ?? '…'} — MIT licensed, open source.
              {info && (
                <>
                  <br />
                  <span className="mono">
                    Electron {info.electron} · Chromium {info.chromium} · Node {info.node} ·{' '}
                    {info.platform}-{info.arch}
                  </span>
                </>
              )}
            </p>
            <button
              className="btn btn--ghost"
              onClick={() =>
                void window.deepPink.shell.openExternal('https://github.com/gokhanmergen/deep-pink')
              }
              type="button"
            >
              Source code ↗
            </button>
          </>
        )}
        </div>
      </div>
    </Overlay>
  )
}