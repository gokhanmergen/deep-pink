import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Info, X } from 'lucide-react'
import { ICON } from '../icons'
import { useStore } from '../store'

/**
 * The stack of things the app has just said.
 *
 * The store announces one at a time — `showToast` is a single slot, and the
 * next confirmation replaced the last one mid-sentence. How many are on
 * screen, for how long, and what happens when the same thing is said twice
 * are questions about the screen rather than about the app, so they live
 * here.
 *
 * What that buys, in order of how often it matters:
 *
 * Nothing is lost. Copying three things used to show one message; now it
 * shows one message that says three.
 *
 * Nothing vanishes while you are reading it. The timer stops while the
 * pointer is over the stack, because the one toast you want to read is the
 * one you moved towards.
 *
 * And anything can be dismissed, which matters most for the ones that are
 * not confirmations: an error you have read is an error you want gone, and
 * waiting out a timer to clear a message about a failure is the app making
 * you watch it twice.
 */

/** How long a message stays, when nothing is holding it. */
const STAYS_FOR = 4500

/**
 * How many are drawn before the rest are counted instead.
 *
 * Three is about a glance. Past that a stack stops being a list and starts
 * being a wall, and the ones underneath are older than your attention.
 */
const SHOW_AT_MOST = 3

interface Shown {
  id: number
  message: string
  tone: 'info' | 'error'
  /** How many times this same thing has been said in a row. */
  count: number
  at: number
}

let nextId = 1

export function Toaster(): React.JSX.Element | null {
  const announced = useStore((s) => s.toast)
  const [shown, setShown] = useState<Shown[]>([])
  const [held, setHeld] = useState(false)
  // The last announcement taken, so a re-render cannot take it twice.
  const taken = useRef<unknown>(null)

  useEffect(() => {
    if (!announced || announced === taken.current) return
    taken.current = announced

    setShown((was) => {
      /*
       * The same thing said again is the same toast, counted.
       *
       * Only against the newest: two identical messages either side of a
       * different one are two moments, and collapsing them would reorder
       * what happened.
       */
      const newest = was[0]
      if (newest && newest.message === announced.message && newest.tone === announced.tone) {
        return [{ ...newest, count: newest.count + 1, at: Date.now() }, ...was.slice(1)]
      }
      return [
        { id: nextId++, message: announced.message, tone: announced.tone, count: 1, at: Date.now() },
        ...was
      ]
    })
  }, [announced])

  /*
   * One timer for the whole stack rather than one each.
   *
   * What expires is always the oldest, so a single sweep is enough — and a
   * timer per toast is a timer per toast to cancel when the pointer arrives.
   */
  useEffect(() => {
    if (!shown.length || held) return
    const sweep = setInterval(() => {
      const now = Date.now()
      // The same array back when nothing has expired, which is almost every
      // tick. A new one is a state change to React, so returning one
      // unconditionally re-rendered the window four times a second for as
      // long as anything was on screen.
      setShown((was) => {
        const left = was.filter((t) => now - t.at < STAYS_FOR)
        return left.length === was.length ? was : left
      })
    }, 250)
    return () => clearInterval(sweep)
  }, [shown.length, held])

  if (!shown.length) return null

  const visible = shown.slice(0, SHOW_AT_MOST)
  const hidden = shown.length - visible.length

  return (
    <div
      className="toaster"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => {
        setHeld(false)
        // Everything gets its full time back, rather than expiring the
        // instant the pointer leaves because its clock ran on underneath.
        const now = Date.now()
        setShown((was) => was.map((t) => ({ ...t, at: now })))
      }}
    >
      {hidden > 0 && (
        <button
          className="toaster__more"
          type="button"
          onClick={() => setShown([])}
          title="Dismiss all"
        >
          {hidden} more — clear all
        </button>
      )}

      {[...visible].reverse().map((toast, indexFromBack) => (
        <div
          key={toast.id}
          className="toast"
          data-tone={toast.tone}
          /* Depth, so a stack reads as a stack: the ones behind sit back a
             little and dim, the way a pile of cards does. */
          style={{ '--depth': visible.length - 1 - indexFromBack } as React.CSSProperties}
          role={toast.tone === 'error' ? 'alert' : 'status'}
        >
          <span className="toast__icon" aria-hidden="true">
            {toast.tone === 'error' ? (
              <AlertTriangle {...ICON} />
            ) : /^(copied|saved|renamed|removed|added|kept)/i.test(toast.message) ? (
              <Check {...ICON} />
            ) : (
              <Info {...ICON} />
            )}
          </span>

          <span className="toast__message">{toast.message}</span>

          {/* Said more than once, said once — with the number. */}
          {toast.count > 1 && <span className="toast__count">{toast.count}</span>}

          <button
            className="toast__close"
            type="button"
            aria-label="Dismiss"
            onClick={() => setShown((was) => was.filter((t) => t.id !== toast.id))}
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  )
}
