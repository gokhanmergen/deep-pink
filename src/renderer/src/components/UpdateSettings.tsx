import { useEffect, useState } from 'react'
import {
  DEFAULT_UPDATE_CONFIG,
  howToUpdate,
  isNewer,
  updateCommand,
  type UpdateConfig,
  type UpdateStatus
} from '@shared/updates'
import { formatRelative } from '../format'

/**
 * Whether to look for a newer Deep Pink, and what this copy could do with one.
 *
 * The second half is why this says more than a switch would. What the app can
 * do about an update is not a preference, it is a fact about how this copy was
 * installed — a package from pacman is not the app's to replace, and saying
 * "install updates automatically" next to a copy that can never do so would be
 * a switch that does nothing, which is worse than no switch.
 *
 * So it reports what it found: which way this one was installed, and the line
 * that updates it.
 */
export function UpdateSettings(): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [config, setConfig] = useState<UpdateConfig>(DEFAULT_UPDATE_CONFIG)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    void window.deepPink.updates.status().then(setStatus)
    void window.deepPink.updates.config().then(setConfig)
    return window.deepPink.updates.onChanged(setStatus)
  }, [])

  const save = async (patch: Partial<UpdateConfig>): Promise<void> => {
    setConfig(await window.deepPink.updates.save(patch))
  }

  const behind = Boolean(
    status?.latestVersion && isNewer(status.latestVersion, status.currentVersion)
  )
  const command = status ? updateCommand(status.installKind) : null

  return (
    <>
      <label className="switch">
        <input
          type="checkbox"
          checked={config.check}
          onChange={(event) => void save({ check: event.target.checked })}
        />
        Check for new versions
      </label>

      {config.check && status?.canSelfInstall && (
        <label className="switch">
          <input
            type="checkbox"
            checked={config.autoInstall}
            onChange={(event) => void save({ autoInstall: event.target.checked })}
          />
          Install them without asking
        </label>
      )}

      <p className="field__hint">
        {!config.check
          ? 'Nothing is asked of GitHub, and the app will not notice a new version.'
          : behind
            ? `Deep Pink ${status?.latestVersion} is out. ${howToUpdate(
                status?.installKind ?? 'unknown'
              )}`
            : status?.error
              ? `Could not check: ${status.error}`
              : status?.latestVersion
                ? `Up to date${status.checkedAt ? `, as of ${formatRelative(status.checkedAt)}` : ''}.`
                : 'Not checked yet.'}
      </p>

      {config.check && command && (
        <p className="field__hint mono" style={{ userSelect: 'text' }}>
          {command}
        </p>
      )}

      {/*
        * Said out loud where it applies, because the alternative is a reader
        * wondering why the app that just told them about a new version will
        * not fetch it. This copy belongs to something else.
        */}
      {config.check && status && !status.canSelfInstall && status.installKind !== 'unknown' && (
        <p className="field__hint">
          {status.installKind === 'mac'
            ? 'Deep Pink cannot replace itself on macOS: that needs an Apple Developer ID signature, and these builds are signed ad-hoc. It will tell you when there is a new one.'
            : 'Deep Pink does not replace itself here — this copy was installed by something else, and overwriting it would put the two out of step.'}
        </p>
      )}

      <div className="row">
        <button
          className="btn btn--ghost"
          type="button"
          disabled={checking || !config.check}
          onClick={async () => {
            setChecking(true)
            try {
              setStatus(await window.deepPink.updates.check())
            } finally {
              setChecking(false)
            }
          }}
        >
          {checking ? 'Checking…' : 'Check now'}
        </button>
        {status?.releaseUrl && (
          <button
            className="btn btn--ghost"
            type="button"
            onClick={() =>
              void window.deepPink.shell.openExternal(status.releaseUrl as string)
            }
          >
            Releases ↗
          </button>
        )}
      </div>
    </>
  )
}
