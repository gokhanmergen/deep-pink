import { useEffect, useState } from 'react'

/**
 * Who wrote the model, as their own mark.
 *
 * A model id is `author/model`, and at this size the author is the only part
 * that reads — you are not identifying a version from sixteen pixels, you are
 * noticing that this conversation is a Claude one and the one under it is not.
 *
 * The marks come from OpenRouter, which has no mark for several large authors:
 * xAI, NVIDIA and Z-AI among the ones I checked. So the lettered badge below
 * is not an error state, it is the answer perhaps a third of the time, and it
 * is drawn to look like a choice rather than like something that failed to
 * load.
 */

/**
 * One request per author for the life of the window.
 *
 * Every row in the sidebar asks, and a library has one author per twenty
 * threads — so without this, opening the sidebar would be two hundred IPC
 * calls to learn a dozen answers. The promise is cached rather than the
 * result, which is what makes the rows that ask simultaneously share one.
 */
const asked = new Map<string, Promise<string | null>>()

function authorOf(modelId: string): string {
  const slash = modelId.indexOf('/')
  return (slash === -1 ? modelId : modelId.slice(0, slash)).toLowerCase()
}

function iconFor(modelId: string): Promise<string | null> {
  const author = authorOf(modelId)
  let pending = asked.get(author)
  if (!pending) {
    pending = window.deepPink.icons.author(modelId)
    asked.set(author, pending)
  }
  return pending
}

/** The letter to fall back to: the first of the author, not of the model. */
function initialOf(modelId: string): string {
  return (authorOf(modelId).replace(/[^a-z0-9]/gi, '')[0] ?? '?').toUpperCase()
}

export function ModelIcon({
  model,
  size = 14,
  className
}: {
  model: string | null | undefined
  size?: number
  className?: string
}): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!model) return
    let cancelled = false
    void iconFor(model).then((found) => {
      if (!cancelled) setUrl(found)
    })
    return () => {
      cancelled = true
    }
  }, [model])

  if (!model) return null

  const classes = className ? `model-icon ${className}` : 'model-icon'

  // Until the answer arrives, and for ever where there is no mark. Rendered
  // rather than left empty so nothing moves when one resolves and the other
  // does not.
  if (!url) {
    return (
      <span className={`${classes} model-icon--letter`} style={{ width: size, height: size }} title={model}>
        {initialOf(model)}
      </span>
    )
  }

  return (
    <img
      className={classes}
      src={url}
      width={size}
      height={size}
      alt=""
      title={model}
      draggable={false}
    />
  )
}
