import logoUrl from '../assets/logo.png'

/**
 * The app's own icon, drawn as the tile it is.
 *
 * One component rather than an `<img>` in two places, because the two places
 * are the first thing seen on a cold start and the thing sitting in the corner
 * for the rest of the session — and a mark that is not identical in both is a
 * mark nobody recognises.
 *
 * `alt` is deliberately empty: the word "Deep Pink" is beside it in both
 * places, and a screen reader announcing "Deep Pink logo, Deep Pink" is the
 * image being described twice.
 */
export function Logo({ size, className }: { size: number; className?: string }): React.JSX.Element {
  return (
    <img
      className={className ? `logo ${className}` : 'logo'}
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      // It is a mark, not a picture: dragging it out of the window into
      // something else is never what anybody meant.
      draggable={false}
    />
  )
}
