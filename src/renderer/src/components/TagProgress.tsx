import { useStore } from '../store'

/**
 * A small card in the corner while one thread is being re-tagged.
 *
 * Re-tagging is a single request, so there is nothing to count — the honest
 * shape for it is an indeterminate bar that says which thread is being looked
 * at. It sits over the corner rather than taking the window, because the app
 * stays usable throughout: the request is not blocking anything.
 */
export function TagProgress(): React.JSX.Element | null {
  const threadId = useStore((s) => s.taggingThreadId)
  const threads = useStore((s) => s.threads)

  if (!threadId) return null

  const thread = threads.find((t) => t.id === threadId)

  return (
    <div className="tagpopup" role="status">
      <div className="tagpopup__label">
        Tagging <strong>{thread?.title || 'this thread'}</strong>…
      </div>
      <div className="meter meter--indeterminate">
        <div className="meter__fill" />
      </div>
    </div>
  )
}
