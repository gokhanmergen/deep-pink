import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { shouldShowReleaseNotes } from '@shared/releaseNotes.mjs'
import { useStore } from '../store'
import { latestReleaseNotes, releaseNotesSeenVersion, rememberReleaseNotes } from '../releaseNotes'
import { Overlay } from './Overlay'
import { wizardSeen } from './Wizard'

/** Wait for setup and existing dialogs before announcing a release. */
export function ReleaseNotesPrompt(): null {
  const ready = useStore((s) => s.ready)
  const overlay = useStore((s) => s.overlay)
  const dialog = useStore((s) => s.dialog)
  const approval = useStore((s) => s.pendingApproval)
  const image = useStore((s) => s.imageViewer)
  const prompted = useRef(false)

  useEffect(() => {
    if (!ready || prompted.current || window.deepPink.releaseNotesSuppressed) return
    if (!wizardSeen() && !window.deepPink.wizardSuppressed) return
    const state = useStore.getState()
    if (state.overlay || state.dialog || state.pendingApproval || state.imageViewer) return
    if (!shouldShowReleaseNotes(latestReleaseNotes, __APP_VERSION__, releaseNotesSeenVersion()))
      return
    prompted.current = true
    state.setOverlay('whatsNew')
  }, [ready, overlay, dialog, approval, image])

  return null
}

export function ReleaseNotesPopup({ onClose }: { onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    if (latestReleaseNotes) rememberReleaseNotes()
  }, [])

  return (
    <Overlay
      title="What’s new"
      className="panel--release-notes"
      center
      onClose={onClose}
      footer={
        <button className="btn" type="button" autoFocus onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="panel__body release-notes">
        <p className="release-notes__version">Version {__APP_VERSION__}</p>
        {latestReleaseNotes ? (
          <div className="md">
            <ReactMarkdown
              skipHtml
              allowedElements={['ul', 'li', 'p', 'strong', 'em', 'a', 'code', 'br']}
              components={{
                a({ href, children }) {
                  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>
                  return (
                    <a
                      href={href}
                      onClick={(event) => {
                        event.preventDefault()
                        void window.deepPink.shell.openExternal(href)
                      }}
                    >
                      {children}
                    </a>
                  )
                }
              }}
            >
              {latestReleaseNotes.body}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="dim">Release notes aren’t available for this version yet.</p>
        )}
      </div>
    </Overlay>
  )
}
