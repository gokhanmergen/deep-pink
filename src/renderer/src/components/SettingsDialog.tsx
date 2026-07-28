import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Overlay } from './Overlay'
import { KEYBIND_GROUPS, formatBinding } from '../keybinds'
import { DEFAULT_KEYBINDS } from '@shared/defaults'
import { modelShortName } from '../format'
import { DebouncedInput, DebouncedTextarea } from './DebouncedField'

type Tab = 'account' | 'models' | 'prompts' | 'web' | 'context' | 'appearance' | 'keys' | 'data'

const TABS: { id: Tab; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'models', label: 'Models' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'web', label: 'Web access' },
  { id: 'context', label: 'Context' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'keys', label: 'Keyboard' },
  { id: 'data', label: 'Data' }
]

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
  const [capturing, setCapturing] = useState<string | null>(null)

  useEffect(() => {
    void window.deepPink.data.path().then(setDbLocation)
    void window.deepPink.settings.encryptionAvailable().then(setEncryption)
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
        <>
          <div className="panel__head">
            <span className="panel__title">Settings</span>
            <div style={{ flex: 1 }} />
            <button className="btn btn--ghost" onClick={onClose} type="button" aria-label="Close">
              ✕
            </button>
          </div>
          <div className="tabs">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                className="tab"
                data-active={tab === entry.id}
                onClick={() => setTab(entry.id)}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
        </>
      }
    >
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
                  Off by default. When on, requests carry the app name and repository URL, which is
                  what puts an app on OpenRouter's public leaderboards.
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
                <button className="btn" onClick={() => setOverlay('models')} type="button">
                  {modelShortName(settings.defaultModel)}
                </button>
                <span className="field__hint">Used by new threads.</span>
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
                <button className="btn" onClick={() => setOverlay('titleModel')} type="button">
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
                  onClick={() => void saveSettings({ ui: { accent: '#ff1493' } })}
                  type="button"
                >
                  Reset to Deep Pink
                </button>
              </div>
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

            <div className="section-title">Danger zone</div>
            <div className="field">
              <span className="field__hint">
                Deletes every thread, message and usage record. Settings, keys and MCP servers are
                kept.
              </span>
              <div className="row">
                <button
                  className="btn btn--danger"
                  onClick={async () => {
                    if (!window.confirm('Delete all threads, messages and statistics?')) return
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
            <p className="dim" style={{ fontSize: 13 }}>
              Deep Pink 0.1.0 — MIT licensed, open source.
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
    </Overlay>
  )
}
