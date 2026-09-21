import { Fragment, useEffect, useState, type ReactNode } from 'react'
import {
  BarChart3,
  Database,
  FileText,
  Pause,
  Play,
  RefreshCw,
  Globe,
  Highlighter,
  KeyRound,
  Keyboard,
  Layers,
  MessageSquareText,
  Palette,
  Cpu,
  Undo2,
  X
} from 'lucide-react'
import { ICON } from '../icons'
import { useStore, type SettingsTab as Tab } from '../store'
import { Overlay } from './Overlay'
import { KEYBIND_GROUPS, formatBinding } from '../keybinds'
import { DEFAULT_KEYBINDS, DEFAULT_SETTINGS } from '@shared/defaults'
import { formatRelative, modelShortName } from '../format'
import { DebouncedInput, DebouncedTextarea } from './DebouncedField'
import type {
  AppInfo,
  Settings,
  SettingsPatch,
  ImportPreview,
  ImportResult,
  SyncDirection,
  SyncScopes
} from '@shared/types'
import { CHARTS_PROMPT } from '@shared/charts'
import { DOCS_PROMPT } from '@shared/docs'

interface TabDef {
  id: Tab
  label: string
  icon: ReactNode
  /** Newer than the rest, and saying so. See `Experimental`. */
  experimental?: boolean
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
      { id: 'web', label: 'Web access', icon: <Globe {...ICON} />, experimental: true },
      { id: 'charts', label: 'Charts', icon: <BarChart3 {...ICON} />, experimental: true },
      { id: 'docs', label: 'Documents', icon: <FileText {...ICON} />, experimental: true },
      { id: 'keyPoint', label: 'Key point', icon: <Highlighter {...ICON} />, experimental: true },
      { id: 'context', label: 'Context', icon: <Layers {...ICON} /> }
    ]
  },
  {
    title: 'The app',
    tabs: [
      { id: 'appearance', label: 'Appearance', icon: <Palette {...ICON} /> },
      { id: 'keys', label: 'Keyboard', icon: <Keyboard {...ICON} /> },
      { id: 'data', label: 'Data', icon: <Database {...ICON} /> },
      { id: 'sync', label: 'Sync', icon: <RefreshCw {...ICON} />, experimental: true }
    ]
  }
]

/**
 * Says a section is not as settled as the rest of the app.
 *
 * Four of them are newer than the app around them and still moving: the ones
 * that reach the network on their own, the two that let a reply decide how it
 * is drawn, and the one that copies the library to a bucket. Saying so is not
 * a disclaimer — it is the difference between a setting you can lean on and
 * one you should look at again after an update.
 *
 * Shown in two weights. In the list down the side it is a mark, because there
 * is no room for a word beside "Appearance" and because what the list is for
 * is finding the section; here in the panel it is the word, because this is
 * where somebody is about to switch the thing on.
 */
function Experimental(): React.JSX.Element {
  return (
    <span className="chip chip--experimental" title="Newer than the rest, and still moving">
      Experimental
    </span>
  )
}

/*
 * Putting one setting back, and only one.
 *
 * Every panel of this size accumulates settings somebody changed once, for a
 * reason they no longer remember, and then lives with — because the only way
 * back is to know what the value used to be. Nothing in the app knew that
 * either; it knew the current value and a file of defaults nobody reads.
 *
 * So the defaults are brought to where the setting is. The control appears
 * only when there is something to undo, which means a panel with nothing out
 * of place looks exactly as it did before — and a panel with three of these
 * showing is answering "what have I changed here?" without being asked.
 */

type Path = string

/**
 * A dotted path, cut where the shape actually has joints.
 *
 * Neither "split at every dot" nor "split at the first" is right, because two
 * of these paths disagree about what a dot means. `keybinds` holds keys that
 * are themselves dotted — `thread.new`, `message.send` — so splitting further
 * would look for `settings.keybinds.thread` and find nothing. `ui.replyChips.cost`
 * is three real levels, so not splitting further would look for a key called
 * `replyChips.cost` and find nothing either. The first version did the latter
 * and the chip switches never showed a Revert at all.
 *
 * So the defaults are asked. At each level, if what is left is a key here, it
 * is the last segment; otherwise cut at the next dot and go in. The defaults
 * have every key by definition, which is what makes them the right thing to
 * ask.
 */
function segmentsOf(path: Path): string[] {
  const out: string[] = []
  let node: unknown = DEFAULT_SETTINGS
  let rest = path

  for (;;) {
    const here = node as Record<string, unknown> | null | undefined
    if (here && typeof here === 'object' && rest in here) {
      out.push(rest)
      return out
    }
    const dot = rest.indexOf('.')
    if (dot === -1) {
      out.push(rest)
      return out
    }
    const head = rest.slice(0, dot)
    out.push(head)
    node = here?.[head]
    rest = rest.slice(dot + 1)
  }
}

function valueAt(source: Settings, path: Path): unknown {
  let node: unknown = source
  for (const key of segmentsOf(path)) {
    const here = node as Record<string, unknown> | null | undefined
    if (!here || typeof here !== 'object') return undefined
    node = here[key]
  }
  return node
}

/** The patch that writes one back, in the shape `saveSettings` merges. */
function patchFor(path: Path, value: unknown): SettingsPatch {
  // Built from the inside out, so three levels nest as three levels.
  const segments = segmentsOf(path)
  let patch: unknown = value
  for (const key of [...segments].reverse()) patch = { [key]: patch }
  return patch as SettingsPatch
}

/*
 * Values here are numbers, strings, booleans, nulls and the odd array of
 * domains — no cycles and nothing exotic — so the cheap comparison is the
 * correct one. Key order comes from the same literal on both sides, since the
 * current value was written from a patch built out of the defaults.
 */
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The default, said the way a person would say it.
 *
 * A confirmation that reads "It goes back to false" is a confirmation nobody
 * can act on, and one that quotes six hundred words of prompt at you is worse.
 */
function describe(value: unknown): string {
  if (value === null || value === undefined) return 'the provider default'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'empty'
  const text = String(value)
  if (!text.trim()) return 'empty'
  if (text.length > 60) return 'the wording it shipped with'
  return `“${text}”`
}

/**
 * Undo for a single setting, shown only once there is something to undo.
 *
 * `what` is the setting named as a sentence can name it, because it is read
 * back in the confirmation — "Revert the temperature?" — where the label above
 * the field is no longer on screen to supply the context.
 */
function Revert({
  path,
  what,
  format = describe
}: {
  path: Path
  what: string
  /** How to read the default aloud, when `describe` does not know the shape. */
  format?: (value: unknown) => string
}): React.JSX.Element | null {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const askConfirm = useStore((s) => s.askConfirm)
  const showToast = useStore((s) => s.showToast)

  if (!settings) return null
  const fallback = valueAt(DEFAULT_SETTINGS, path)
  if (same(valueAt(settings, path), fallback)) return null

  const revert = async (event: React.MouseEvent): Promise<void> => {
    /*
     * Several of these sit inside the `<label>` of a switch, where a click on
     * anything at all is forwarded to the checkbox the label is for. Without
     * this, asking to revert a toggle would also flip it.
     */
    event.preventDefault()
    event.stopPropagation()

    const ok = await askConfirm({
      title: `Revert ${what}?`,
      body: `It goes back to ${format(fallback)}. Nothing else in Settings changes.`,
      confirmLabel: 'Revert'
    })
    if (!ok) return
    await saveSettings(patchFor(path, fallback))
    showToast('Reverted to the default')
  }

  return (
    <button
      className="revert"
      onClick={(event) => void revert(event)}
      title={`Changed from the default — put ${what} back`}
      type="button"
    >
      <Undo2 size={12} strokeWidth={2} />
      Revert
    </button>
  )
}

/**
 * A field's label with its undo beside it.
 *
 * The button goes to the far end of the row rather than next to the words: it
 * is the same distance from the left edge in every field that has one, so a
 * column of them is scannable, and it never pushes a label around when it
 * appears.
 */
function FieldLabel({
  path,
  what,
  children
}: {
  path: Path
  what: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <span className="field__label">
      {children}
      <Revert path={path} what={what} />
    </span>
  )
}

/** Nine in the morning, tomorrow — which is what "until tomorrow" means. */
function tomorrowMorning(): number {
  const at = new Date()
  at.setDate(at.getDate() + 1)
  at.setHours(9, 0, 0, 0)
  return at.getTime()
}

/**
 * Which way one scope travels.
 *
 * Sync used to be two-way and say nothing about it, which is fine until two
 * machines disagree: the one edited last silently won, and there was no way to
 * say "this desktop decides" or "this laptop only follows". Last-write-wins is
 * still what happens inside a direction — this chooses whether this machine is
 * writing at all.
 */
function DirectionField({
  what,
  value,
  onChange
}: {
  what: 'conversations' | 'settings'
  value: SyncDirection
  onChange: (direction: SyncDirection) => void
}): React.JSX.Element {
  return (
    <div className="field field--indent">
      <span className="field__label">Which way {what} travel</span>
      <select
        className="select"
        value={value}
        onChange={(event) => onChange(event.target.value as SyncDirection)}
      >
        <option value="two-way">Both ways</option>
        <option value="push">Only send from this machine</option>
        <option value="pull">Only receive onto this machine</option>
      </select>
    </div>
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const refreshSettings = useStore((s) => s.refreshSettings)
  const setOverlay = useStore((s) => s.setOverlay)
  const showToast = useStore((s) => s.showToast)
  const askConfirm = useStore((s) => s.askConfirm)

  /*
   * Which section is showing, kept in the store rather than here.
   *
   * A caller with somewhere in mind says so — the sync line means Sync, the
   * shortcut sheet means Keyboard. With nobody having said, it is where this
   * was last left, and on the very first opening the first thing worth doing:
   * the key if there is not one, and the models if there is.
   */
  const chosen = useStore((s) => s.settingsTab)
  const setTab = useStore((s) => s.setSettingsTab)
  const tab: Tab = chosen ?? (settings?.hasApiKey ? 'models' : 'account')
  const [apiKey, setApiKey] = useState('')
  const [dbLocation, setDbLocation] = useState('')
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

  /** Patches one part of what travels, leaving the rest of the choices alone. */
  const saveScopes = async (patch: Partial<SyncScopes>): Promise<void> => {
    if (!sync) return
    useStore.setState({
      sync: await window.deepPink.sync.save({ scopes: { ...sync.config.scopes, ...patch } })
    })
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
                  title={entry.experimental ? `${entry.label} — experimental` : entry.label}
                  aria-label={entry.experimental ? `${entry.label}, experimental` : entry.label}
                  aria-current={tab === entry.id ? 'page' : undefined}
                  type="button"
                >
                  {entry.icon}
                  <span className="tab__label">{entry.label}</span>
                  {/* A mark rather than the word: the word does not fit beside
                      the longer labels, and a row of tags down a list of
                      eleven would be a column of its own. What it says is on
                      the button's title, and in full inside the section. */}
                  {entry.experimental && <span className="tab__experimental" aria-hidden="true" />}
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
              <span>Identify Deep Pink to OpenRouter</span>
              <Revert path="sendAppAttribution" what="the attribution header" />
            </label>
          </>
        )}

        {tab === 'models' && (
          <>
            <div className="section-title">
              Default model
              <Revert path="defaultModel" what="the default model" />
            </div>
            <div className="field">
              <div className="row">
                <button
                  className="btn"
                  onClick={() => setOverlay('defaultModel', 'settings')}
                  type="button"
                >
                  {modelShortName(settings.defaultModel)}
                </button>
              </div>
            </div>

            <div className="section-title">Thread names</div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.titleGenerationEnabled}
                onChange={(event) =>
                  void saveSettings({ titleGenerationEnabled: event.target.checked })
                }
              />
              <span>
                Name threads automatically
              </span>
              <Revert path="titleGenerationEnabled" what="automatic naming" />
            </label>

            <div className="field">
              <FieldLabel path="titleModel" what="the naming model">Model used to generate thread names</FieldLabel>
              <div className="row">
                <button
                  className="btn"
                  onClick={() => setOverlay('titleModel', 'settings')}
                  type="button"
                >
                  {modelShortName(settings.titleModel)}
                </button>
              </div>
            </div>

            <label className="switch">
              <input
                type="checkbox"
                disabled={!settings.titleGenerationEnabled}
                checked={settings.titlePregenEnabled}
                onChange={(event) =>
                  void saveSettings({ titlePregenEnabled: event.target.checked })
                }
              />
              <span>
                Name it before the reply arrives
              </span>
              <Revert path="titlePregenEnabled" what="naming before the reply" />
            </label>
            {settings.titlePregenEnabled && (
              <div className="field">
                <FieldLabel path="titlePregenModel" what="the model for the first name">
                  Model used for that first name
                </FieldLabel>
                <div className="row">
                  <button
                    className="btn"
                    onClick={() => setOverlay('pregenTitleModel', 'settings')}
                    type="button"
                  >
                    {modelShortName(settings.titlePregenModel || settings.titleModel)}
                  </button>
                </div>
              </div>
            )}

            <div className="field">
              <FieldLabel path="titlePrompt" what="the naming prompt">Naming prompt</FieldLabel>
              <DebouncedTextarea
                className="textarea"
                rows={6}
                value={settings.titlePrompt}
                onCommit={(next) => void saveSettings({ titlePrompt: next })}
              />
            </div>

            <div className="section-title">Generation</div>
            <div className="field">
              <FieldLabel path="temperature" what="the temperature">
                Temperature — {settings.temperature.toFixed(2)}
              </FieldLabel>
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
              <FieldLabel path="maxTokens" what="the output limit">Maximum output tokens</FieldLabel>
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
              <Revert path="streamReasoning" what="reasoning traces" />
            </label>
          </>
        )}

        {tab === 'prompts' && (
          <>
            <div className="section-title">
              Base system prompt
              <Revert path="baseSystemPrompt" what="the system prompt" />
            </div>
            <div className="field">
              <DebouncedTextarea
                className="textarea"
                rows={10}
                value={settings.baseSystemPrompt}
                onCommit={(next) => void saveSettings({ baseSystemPrompt: next })}
              />
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
              </span>
              <Revert path="includeDateTimeInPrompt" what="the date and time line" />
            </label>
          </>
        )}

        {tab === 'web' && (
          <>
            <div className="section-title">
              Web access
              <Experimental />
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.web.enabled}
                onChange={(event) => void saveSettings({ web: { enabled: event.target.checked } })}
              />
              <span>
                Enable web search and fetch by default
              </span>
              <Revert path="web.enabled" what="web access" />
            </label>

            <div className="field">
              <FieldLabel path="web.engine" what="the search backend">Search backend</FieldLabel>
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
            </div>

            {settings.web.engine === 'searxng' && (
              <div className="field">
                <FieldLabel path="web.searxngUrl" what="the SearXNG URL">SearXNG URL</FieldLabel>
                <DebouncedInput
                  className="input mono"
                  value={settings.web.searxngUrl}
                  onCommit={(next) => void saveSettings({ web: { searxngUrl: next } })}
                />
              </div>
            )}

            <div className="field">
              <FieldLabel path="web.maxResults" what="results per search">Results per search</FieldLabel>
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
              <FieldLabel path="web.fetchCharLimit" what="the page limit">Characters kept per fetched page</FieldLabel>
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
              <FieldLabel path="web.blockedDomains" what="the blocked domains">Blocked domains</FieldLabel>
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
            </div>
          </>
        )}

        {tab === 'charts' && (
          <>
            <div className="section-title">
              Charts in replies
              <Experimental />
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.chartsEnabled}
                onChange={(event) => void saveSettings({ chartsEnabled: event.target.checked })}
              />
              <span>
                Let replies draw charts
              </span>
              <Revert path="chartsEnabled" what="charts" />
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

        {tab === 'keyPoint' && (
          <>
            <div className="section-title">
              The line worth reading first
              <Experimental />
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.keyPointEnabled}
                onChange={(event) => void saveSettings({ keyPointEnabled: event.target.checked })}
              />
              <span>Mark the most important sentence of a reply</span>
              <Revert path="keyPointEnabled" what="marking the key sentence" />
            </label>
            {settings.keyPointEnabled && (
              <>
                <div className="field">
                  <FieldLabel path="keyPointSource" what="who picks the sentence">
                    Who picks it
                  </FieldLabel>
                  <select
                    className="input"
                    value={settings.keyPointSource}
                    onChange={(event) =>
                      void saveSettings({
                        keyPointSource: event.target.value as Settings['keyPointSource']
                      })
                    }
                  >
                    <option value="jev">Jev, a decision model</option>
                    <option value="model">A model of my choosing</option>
                    <option value="self">The model that wrote the reply</option>
                  </select>
                </div>

                <div className="field">
                  <FieldLabel path="keyPointMost" what="how many sentences">
                    How many
                  </FieldLabel>
                  <select
                    className="input"
                    value={String(settings.keyPointMost)}
                    onChange={(event) =>
                      void saveSettings({ keyPointMost: Number(event.target.value) })
                    }
                  >
                    <option value="1">One sentence</option>
                    <option value="2">Up to two</option>
                    <option value="3">Up to three</option>
                  </select>
                </div>

                {/*
                  * Worth saying because it is not a volume knob: allowing a
                  * second sentence changes what a tie means. Asked for one,
                  * two sentences neck and neck are a reason to mark neither;
                  * asked for two, they are the answer.
                  */}
                {settings.keyPointMost > 1 && (
                  <p className="field__hint">
                    Fewer is still better — a reply with half of it marked has nothing
                    marked. Allowing a second also means two sentences of equal weight are
                    both marked, where asking for one would have marked neither.
                  </p>
                )}

                {/*
                  * One line each, kept where the rest of the commentary in
                  * here went, and for the same reason the sync panel keeps
                  * its one line: none of these is an explanation of the
                  * control, they are where the reply goes, what it costs, and
                  * what each choice is worse at. None of it is guessable from
                  * a list of three names, and one of the three sends every
                  * reply to a second company.
                  */}
                {settings.keyPointSource === 'jev' && (
                  <p className="field__hint">
                    Sends each finished reply to Jev, from TypeSafe — not the model that
                    wrote it. About $0.00006 a reply. Alone of the three it scores every
                    sentence, so it can say nothing stands out, and often does.
                  </p>
                )}

                {settings.keyPointSource === 'model' && (
                  <>
                    <div className="field">
                      <FieldLabel path="keyPointModel" what="the model that picks">
                        Model
                      </FieldLabel>
                      <div className="row">
                        <button
                          className="btn"
                          onClick={() => setOverlay('keyPointModel', 'settings')}
                          type="button"
                        >
                          {modelShortName(settings.keyPointModel)}
                        </button>
                      </div>
                    </div>
                    <p className="field__hint">
                      A second request per reply, priced by whichever model you pick. It
                      answers with a number and nothing else, so unlike Jev there is no way
                      to tell a confident choice from a shrug — expect it to mark something
                      in almost every reply.
                    </p>
                  </>
                )}

                {settings.keyPointSource === 'self' && (
                  <p className="field__hint">
                    No second request and no second model: a line is added to the system
                    prompt asking for the sentence, and the reply names its own. Costs a
                    few tokens a turn instead, and a model that ignores the instruction
                    simply marks nothing.
                  </p>
                )}
              </>
            )}
          </>
        )}

        {tab === 'docs' && (
          <>
            <div className="section-title">
              Replies of several documents
              <Experimental />
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.docsEnabled}
                onChange={(event) => void saveSettings({ docsEnabled: event.target.checked })}
              />
              <span>
                Let a reply be a set of documents
              </span>
              <Revert path="docsEnabled" what="documents" />
            </label>
            <details className="disclosure">
              <summary className="disclosure__summary">
                <span className="chip">system prompt</span>
                <span>
                  What the model is told — about{' '}
                  {Math.ceil(DOCS_PROMPT.length / 4).toLocaleString()} tokens per turn
                </span>
              </summary>
              <div className="disclosure__content">
                <pre>{DOCS_PROMPT}</pre>
              </div>
            </details>
          </>
        )}

        {tab === 'sync' && sync && (
          <>
            <div className="section-title">
              Sync
              <Experimental />
            </div>
            <label className="switch">
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
              </span>
            </label>
            {sync.config.enabled && sync.ready && (
              <div className="field">
                <span className="field__label">
                  {sync.paused ? 'Paused' : 'Automatic syncing'}
                </span>
                {/* State, not an explanation: when a pause lifts is a fact
                    about right now and it is said nowhere else in the panel.
                    What syncing does when it is not paused went with the rest
                    of the commentary. */}
                {sync.paused && (
                  <span className="field__hint">
                    {sync.config.pause?.until
                      ? `Until ${new Date(sync.config.pause.until).toLocaleString([], {
                          weekday: 'short',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}. Sync now still works.`
                      : 'Until you resume. Sync now still works.'}
                  </span>
                )}
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
                  The only thing that can decrypt this bucket. Nobody can recover it for you.
                  Write it down.
                </span>
              </div>
            ) : (
              <div className="field">
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
            <div className="field">
              <span className="field__label">Endpoint</span>
              <DebouncedInput
                className="input mono"
                placeholder="https://<account>.r2.cloudflarestorage.com — leave empty for AWS"
                value={sync.config.endpoint}
                onCommit={async (next) => useStore.setState({ sync: await window.deepPink.sync.save({ endpoint: next }) })}
              />
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
            </div>

            <div className="field">
              <span className="field__label">Prefix</span>
              <DebouncedInput
                className="input mono"
                value={sync.config.prefix}
                onCommit={async (next) => useStore.setState({ sync: await window.deepPink.sync.save({ prefix: next }) })}
              />
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
                onChange={(event) => void saveScopes({ conversations: event.target.checked })}
              />
              <span>
                Conversations
              </span>
            </label>
            {sync.config.scopes.conversations && (
              <DirectionField
                what="conversations"
                value={sync.config.scopes.conversationsDirection}
                onChange={(direction) => void saveScopes({ conversationsDirection: direction })}
              />
            )}

            <label className="switch">
              <input
                type="checkbox"
                checked={sync.config.scopes.settings}
                onChange={(event) => void saveScopes({ settings: event.target.checked })}
              />
              {/*
                * The one sentence of explanation left in here on purpose.
                *
                * All the commentary under these settings went, because it
                * belonged on a wiki page rather than on the screen. This is
                * not commentary: it is a promise about where a secret goes,
                * made at the moment of switching on the thing that would send
                * it. Somebody weighing whether to sync their settings to a
                * bucket is owed it here, not in a document.
                */}
              <span>
                Settings and MCP servers — never the OpenRouter key
              </span>
            </label>
            {sync.config.scopes.settings && (
              <DirectionField
                what="settings"
                value={sync.config.scopes.settingsDirection}
                onChange={(direction) => void saveScopes({ settingsDirection: direction })}
              />
            )}

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
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.compaction.enabled}
                onChange={(event) =>
                  void saveSettings({ compaction: { enabled: event.target.checked } })
                }
              />
              <span>
                Compact long threads
              </span>
              <Revert path="compaction.enabled" what="compaction" />
            </label>

            <label className="switch">
              <input
                type="checkbox"
                checked={settings.compaction.requireConfirmation}
                onChange={(event) =>
                  void saveSettings({ compaction: { requireConfirmation: event.target.checked } })
                }
              />
              <span>
                Only compact when I ask
              </span>
              <Revert path="compaction.requireConfirmation" what="asking first" />
            </label>

            <div className="field">
              <FieldLabel path="compaction.triggerRatio" what="the trigger point">
                Trigger at {Math.round(settings.compaction.triggerRatio * 100)}% of the context
                window
              </FieldLabel>
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
              <FieldLabel path="compaction.keepRecentMessages" what="how many are kept">Messages always kept verbatim</FieldLabel>
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
              <FieldLabel path="compaction.prompt" what="the summarisation prompt">Summarisation prompt</FieldLabel>
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
              <FieldLabel path="ui.accent" what="the accent colour">Accent colour</FieldLabel>
              <div className="row">
                <input
                  type="color"
                  value={settings.ui.accent}
                  onChange={(event) => void saveSettings({ ui: { accent: event.target.value } })}
                  style={{ width: 44, height: 30, background: 'none', border: 'none' }}
                />
              </div>
            </div>

            <div className="field">
              <FieldLabel path="ui.chatWidth" what="the chat width">
                Chat width — {settings.ui.chatWidth}px
                {settings.ui.chatWidth >= 1400 ? ' (as wide as the window)' : ''}
              </FieldLabel>
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
            </div>

            <div className="field">
              <FieldLabel path="ui.fontSize" what="the text size">
                Text size — {settings.ui.fontSize}px
              </FieldLabel>
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
              <FieldLabel path="ui.messageDensity" what="message spacing">Message spacing</FieldLabel>
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
              <FieldLabel path="ui.codeTheme" what="the code theme">Code theme</FieldLabel>
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

            <label className="switch">
              <input
                type="checkbox"
                checked={settings.ui.showReasoningByDefault}
                onChange={(event) =>
                  void saveSettings({ ui: { showReasoningByDefault: event.target.checked } })
                }
              />
              <span>Expand reasoning traces by default</span>
              <Revert path="ui.showReasoningByDefault" what="expanding traces" />
            </label>

            <div className="field">
              <FieldLabel path="ui.pasteAsFileThreshold" what="the paste threshold">Turn a long paste into an attachment</FieldLabel>
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
            </div>

            <label className="switch">
              <input
                type="checkbox"
                checked={settings.ui.sendOnEnter}
                onChange={(event) => void saveSettings({ ui: { sendOnEnter: event.target.checked } })}
              />
              <span>
                Enter sends the message
              </span>
              <Revert path="ui.sendOnEnter" what="Enter sending" />
            </label>

            <label className="switch">
              <input
                type="checkbox"
                checked={settings.ui.animations}
                onChange={(event) => void saveSettings({ ui: { animations: event.target.checked } })}
              />
              <span>
                Animate
              </span>
              <Revert path="ui.animations" what="animation" />
            </label>
            <div className="section-title">Under a reply</div>
            {(
              [
                ['cost', 'What it cost'],
                ['took', 'How long it took'],
                ['speed', 'How fast it wrote'],
                ['start', 'How long before it started'],
                ['sent', 'Tokens sent'],
                ['back', 'Tokens in the reply'],
                ['thinking', 'Tokens spent thinking'],
                ['cached', 'Tokens served from cache']
              ] as const
            ).map(([key, label]) => (
              <label className="switch" key={key}>
                <input
                  type="checkbox"
                  checked={settings.ui.replyChips[key]}
                  onChange={(event) =>
                    void saveSettings({ ui: { replyChips: { [key]: event.target.checked } } })
                  }
                />
                <span>{label}</span>
                <Revert path={`ui.replyChips.${key}`} what={`“${label.toLowerCase()}”`} />
              </label>
            ))}

            <div className="section-title">Loading</div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.ui.loadEverythingAtOnce}
                onChange={(event) =>
                  void saveSettings({ ui: { loadEverythingAtOnce: event.target.checked } })
                }
              />
              <span>
                Load everything at once
              </span>
              <Revert path="ui.loadEverythingAtOnce" what="loading everything at once" />
            </label>
          </>
        )}

        {tab === 'keys' && (
          <>
            <p className="field__hint" style={{ marginBottom: 14 }}>
              Click a shortcut, then press the keys you want. Escape cancels.
            </p>
            {KEYBIND_GROUPS.map((group) => (
              <Fragment key={group.title}>
                <div className="section-title">{group.title}</div>
                {group.actions.map((action) => (
                  <div className="keybind" key={action.id}>
                    <span className="muted">{action.label}</span>
                    <Revert
                      path={`keybinds.${action.id}`}
                      what={`the shortcut for “${action.label}”`}
                      format={(value) => formatBinding(String(value ?? ''))}
                    />
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
              </Fragment>
            ))}
            <div className="row" style={{ marginTop: 18 }}>
              <button
                className="btn"
                onClick={async () => {
                  const ok = await askConfirm({
                    title: 'Restore every shortcut?',
                    body: 'All of them go back to what the app shipped with, including the ones you have not changed.',
                    confirmLabel: 'Restore all'
                  })
                  if (!ok) return
                  await saveSettings({ keybinds: DEFAULT_KEYBINDS })
                  showToast('Shortcuts restored')
                }}
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
              <div className="row">
                <button className="btn" onClick={() => void window.deepPink.data.reveal()} type="button">
                  Show in file manager
                </button>
              </div>
            </div>

            <div className="section-title">Import conversations</div>
            <div className="field">
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
                Every thread, message and usage record. Settings and keys are kept. With sync on,
                this travels to your other machines.
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