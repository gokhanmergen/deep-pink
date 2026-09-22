/**
 * The mark on a feature that is newer than the app around it.
 *
 * Saying so is not a disclaimer — it is the difference between a setting you
 * can lean on and one you should look at again after an update.
 *
 * Two weights, and the choice between them is about where the reader is. In a
 * list it is a dot, because there is no room for a word beside "Appearance"
 * and because what a list is for is finding the section. On the thing itself
 * it is the word, because that is where somebody is about to switch it on.
 *
 * Lifted out of the settings dialog when MCP wanted the same mark and has no
 * tab of its own — it is reached from the sidebar and opens its own panel, so
 * the word has to travel to it.
 */
export function Experimental(): React.JSX.Element {
  return (
    <span className="chip chip--experimental" title="Newer than the rest, and still moving">
      Experimental
    </span>
  )
}

/** The same thing where there is only room for a mark. */
export function ExperimentalDot(): React.JSX.Element {
  return <span className="tab__experimental" aria-hidden="true" />
}
