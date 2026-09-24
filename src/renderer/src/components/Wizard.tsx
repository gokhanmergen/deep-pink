import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, KeyRound, Cpu, FlaskConical, Upload } from 'lucide-react'
import { ICON } from '../icons'
import { Overlay } from './Overlay'
import { modelShortName } from '../format'
import { useStore } from '../store'

/**
 * The four questions worth asking before the first conversation.
 *
 * Everything here can be found in Settings, and for a year that was the
 * answer: the app opened, said nothing, and waited to be configured by
 * somebody who did not yet know what it could do. What that cost is not
 * discoverability — it is the first ten minutes, spent in a settings dialog
 * with eleven tabs rather than in a conversation.
 *
 * So: the key, because nothing works without it; the model, because the
 * default is a guess about somebody the app has not met; whether they want
 * the unfinished parts; and whether they are arriving from somewhere else
 * with a library to bring. Four, and none of them is asked twice.
 *
 * Every step is skippable and nothing here is a gate. A wizard that cannot
 * be walked past is a wizard that has to be right about what you want.
 */

/** Remembered here rather than in the database: it is about this machine. */
const SEEN = 'deep-pink:wizard-seen'

export function wizardSeen(): boolean {
  return localStorage.getItem(SEEN) === 'yes'
}

/**
 * A few models worth suggesting, rather than the four hundred in the picker.
 *
 * The picker is the right tool for somebody who knows what they want, and
 * the wrong one for somebody who has never used the app: four hundred and
 * fifty rows is not a choice, it is a reason to close the window. These are
 * one good answer per shape of question, and the picker is one click away for
 * anybody who disagrees.
 */
const SUGGESTED = [
  { id: 'anthropic/claude-sonnet-4.5', why: 'A strong all-rounder' },
  { id: 'openai/gpt-5.1', why: 'OpenAI, for most things' },
  { id: 'google/gemini-3-pro', why: 'Long documents and images' },
  { id: 'anthropic/claude-haiku-4.5', why: 'Quick and inexpensive' },
  { id: 'deepseek/deepseek-v3.2', why: 'Cheapest of these, by a lot' }
]

type Step = 'key' | 'model' | 'experimental' | 'import'
const STEPS: Step[] = ['key', 'model', 'experimental', 'import']

export function Wizard({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const showToast = useStore((s) => s.showToast)
  const setOverlay = useStore((s) => s.setOverlay)

  const [at, setAt] = useState(0)
  const [key, setKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [importing, setImporting] = useState(false)

  const step = STEPS[at]
  const last = at === STEPS.length - 1

  // Whatever happens, it is not asked again. Closing by any route — finishing,
  // escaping, the X — is an answer.
  useEffect(() => () => localStorage.setItem(SEEN, 'yes'), [])

  const done = (): void => {
    localStorage.setItem(SEEN, 'yes')
    onClose()
  }

  const saveKey = async (): Promise<void> => {
    const trimmed = key.trim()
    if (!trimmed) return
    setSavingKey(true)
    try {
      await window.deepPink.settings.setApiKey(trimmed)
      setKey('')
      showToast('Key saved')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <Overlay
      title={
        <>
          Welcome to Deep Pink
          <span className="wizard__of">
            {at + 1} of {STEPS.length}
          </span>
        </>
      }
      onClose={done}
      footer={
        <>
          <button className="btn btn--ghost" onClick={done} type="button">
            {last ? 'Close' : 'Skip the rest'}
          </button>
          <div style={{ flex: 1 }} />
          {at > 0 && (
            <button className="btn" onClick={() => setAt(at - 1)} type="button">
              <ArrowLeft {...ICON} />
              Back
            </button>
          )}
          <button
            className="btn btn--primary"
            onClick={() => (last ? done() : setAt(at + 1))}
            type="button"
          >
            {last ? 'Start using it' : 'Next'}
            {last ? <Check {...ICON} /> : <ArrowRight {...ICON} />}
          </button>
        </>
      }
    >
      <div className="panel__body wizard">
        {step === 'key' && (
          <>
            <div className="section-title">
              <KeyRound {...ICON} /> Your OpenRouter key
            </div>
            <p className="field__hint">
              Deep Pink talks to OpenRouter and nothing else. The key is kept on this
              machine, encrypted by your keyring, and never leaves it except to OpenRouter.
            </p>
            {settings?.hasApiKey ? (
              <p className="wizard__done">
                <Check {...ICON} /> A key is already set. You can replace it in Settings.
              </p>
            ) : (
              <div className="row">
                <input
                  className="input"
                  type="password"
                  placeholder="sk-or-…"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveKey()
                  }}
                />
                <button
                  className="btn btn--primary"
                  disabled={!key.trim() || savingKey}
                  onClick={() => void saveKey()}
                  type="button"
                >
                  {savingKey ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
            <button
              className="btn btn--ghost"
              onClick={() =>
                void window.deepPink.shell.openExternal('https://openrouter.ai/keys')
              }
              type="button"
            >
              Get a key ↗
            </button>
          </>
        )}

        {step === 'model' && (
          <>
            <div className="section-title">
              <Cpu {...ICON} /> Which model to start with
            </div>
            <p className="field__hint">
              What new conversations use. Any thread can be switched to something else at
              any time, and this can be changed later in Settings.
            </p>
            <div className="wizard__choices">
              {SUGGESTED.map((model) => (
                <button
                  key={model.id}
                  className="wizard__choice"
                  data-chosen={settings?.defaultModel === model.id || undefined}
                  onClick={() => void saveSettings({ defaultModel: model.id })}
                  type="button"
                >
                  <span className="wizard__choiceName">{modelShortName(model.id)}</span>
                  <span className="wizard__choiceWhy">{model.why}</span>
                </button>
              ))}
            </div>
            <p className="field__hint">
              Currently <strong>{modelShortName(settings?.defaultModel ?? '')}</strong>.
            </p>
            <button
              className="btn btn--ghost"
              onClick={() => setOverlay('defaultModel', 'wizard')}
              type="button"
            >
              Choose from all models…
            </button>
          </>
        )}

        {step === 'experimental' && (
          <>
            <div className="section-title">
              <FlaskConical {...ICON} /> The unfinished parts
            </div>
            <p className="field__hint">
              Web access, charts, marking the key sentence,
              MCP servers, reading a code repository, and syncing to a bucket. They work,
              and they move about more than the rest of the app.
            </p>
            <label className="switch">
              <input
                type="checkbox"
                checked={!(settings?.hideExperimental ?? true)}
                onChange={(event) =>
                  void saveSettings({ hideExperimental: !event.target.checked })
                }
              />
              <span>Show me the experimental features</span>
            </label>
            <p className="field__hint">
              Off, they are hidden and switched off rather than merely greyed out. You can
              turn this on later under Appearance without losing anything.
            </p>
          </>
        )}

        {step === 'import' && (
          <>
            <div className="section-title">
              <Upload {...ICON} /> Bringing a library with you
            </div>
            <p className="field__hint">
              A ChatGPT export, or threads exported from another copy of Deep Pink.
              Everything is read locally; nothing is uploaded.
            </p>
            <button
              className="btn"
              disabled={importing}
              onClick={async () => {
                const path = await window.deepPink.import.choose()
                if (!path) return
                setImporting(true)
                try {
                  const result = await window.deepPink.import.run(path)
                  await useStore.getState().refreshThreads()
                  showToast(
                    `Imported ${result.threadsCreated} conversation${
                      result.threadsCreated === 1 ? '' : 's'
                    }`
                  )
                } catch (err) {
                  showToast(err instanceof Error ? err.message : String(err), 'error')
                } finally {
                  setImporting(false)
                }
              }}
              type="button"
            >
              {importing ? 'Importing…' : 'Choose an export…'}
            </button>
            <p className="field__hint">
              Or skip this — Settings → Data has the same thing whenever you want it.
            </p>
          </>
        )}
      </div>
    </Overlay>
  )
}
