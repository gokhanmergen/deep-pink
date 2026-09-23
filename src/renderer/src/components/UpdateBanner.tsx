import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { ICON } from '../icons'
import { isNewer, howToUpdate, updateCommand, type UpdateStatus } from '@shared/updates'
import { useStore } from '../store'

/**
 * A line saying there is a newer Deep Pink, and the one command that gets it.
 *
 * Shown rather than acted on, because on most Linux machines this copy is not
 * the app's to replace: it came from pacman or apt or a Nix configuration,
 * and something else owns the files. An app that overwrote itself in `/opt`
 * would be lying to the package manager that put it there.
 *
 * So it says the command for the way this copy was actually installed, which
 * the main process works out from where the binary is running. That is the
 * whole value of the thing: not "an update exists" — the releases page says
 * that — but "here is the line to paste, for you, today".
 *
 * Dismissable, and dismissal is remembered against the version. Saying it
 * once is a service; saying it every launch until you comply is nagging, and
 * the reader may have good reasons to stay where they are.
 */

/** Versions already waved away, so a dismissal survives a restart. */
const IGNORED = 'deep-pink:update-dismissed'

export function UpdateBanner(): React.JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(() => localStorage.getItem(IGNORED))
  const showToast = useStore((s) => s.showToast)

  useEffect(() => {
    void window.deepPink.updates.status().then(setStatus)
    return window.deepPink.updates.onChanged(setStatus)
  }, [])

  if (!status?.latestVersion) return null
  if (!isNewer(status.latestVersion, status.currentVersion)) return null
  if (dismissed === status.latestVersion) return null

  const command = updateCommand(status.installKind)

  return (
    <div className="updateline" role="status">
      <Download className="icon" {...ICON} />
      <span className="updateline__what">
        <strong>Deep Pink {status.latestVersion}</strong> is out — you have {status.currentVersion}.
      </span>

      <span className="updateline__how">{howToUpdate(status.installKind)}</span>

      {command && (
        <button
          className="updateline__cmd"
          type="button"
          title="Copy this command"
          onClick={() => {
            void navigator.clipboard.writeText(command)
            showToast('Command copied')
          }}
        >
          <code>{command}</code>
        </button>
      )}

      {status.releaseUrl && (
        <button
          className="btn btn--ghost"
          type="button"
          onClick={() => void window.deepPink.shell.openExternal(status.releaseUrl as string)}
        >
          What changed
        </button>
      )}

      <button
        className="btn btn--ghost updateline__close"
        type="button"
        aria-label="Dismiss until the next version"
        title="Dismiss until the next version"
        onClick={() => {
          localStorage.setItem(IGNORED, status.latestVersion as string)
          setDismissed(status.latestVersion)
        }}
      >
        <X {...ICON} />
      </button>
    </div>
  )
}
