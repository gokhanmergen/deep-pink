import { useStore } from './store'

/**
 * Every failure the app knows about, said where the reader is looking.
 *
 * The app was good at reporting the errors somebody was waiting on — a send
 * that failed, a key that would not save, an export that fell over — because
 * each of those had a `catch` next to the button that caused it. Everything
 * else went to the console: a background sweep that threw, a picture that
 * could not be stored, a promise nobody awaited, a render that crashed. The
 * console is a place developers look. Nobody running the built app has it
 * open, so from the window's point of view those failures simply did not
 * happen — the thing you asked for quietly did not occur and nothing said so.
 *
 * Three sources, one destination:
 *
 *   - the main process, over `app:problem`, for what happened out of reach;
 *   - `error`, for a throw that escaped a handler or a component;
 *   - `unhandledrejection`, which is where almost every one of these actually
 *     lands, because a call that is fired and not awaited — `void api.x()` —
 *     is how the renderer asks for most things.
 *
 * The toaster does the rest: identical messages collapse with a count, so a
 * failure that repeats every tick is one line that climbs rather than a wall.
 */

/**
 * Electron's wrapper, removed.
 *
 * A rejected `ipcMain.handle` arrives as `Error invoking remote method
 * 'settings:save': Error: no keyring available` — the first half names an
 * internal channel and the second says the thing twice. What is true and
 * worth reading is the end of it.
 */
function readable(problem: unknown): string {
  const raw =
    problem instanceof Error ? problem.message : typeof problem === 'string' ? problem : String(problem)

  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:Uncaught\s+)?Error:\s*/, '')
    .trim()
}

/**
 * Noise that is not a failure.
 *
 * `ResizeObserver loop completed with undelivered notifications` is Chromium
 * saying a layout pass ran twice, which happens in any app that resizes
 * something in response to a resize — here, the composer growing with what is
 * typed into it. Nothing is broken and nobody can act on it.
 *
 * An aborted request is the other one: stopping a reply is a button, and the
 * fetch it cancels reports itself as a failure because from its own point of
 * view it is one.
 */
function worthSaying(message: string): boolean {
  if (!message) return false
  if (message.startsWith('ResizeObserver loop')) return false
  if (/\baborted\b/i.test(message) && /\b(fetch|request|operation)\b/i.test(message)) return false
  return true
}

/** Starts listening. Returns the function that stops. */
export function watchProblems(): () => void {
  const say = (problem: unknown): void => {
    const message = readable(problem)
    if (!worthSaying(message)) return
    useStore.getState().showToast(message, 'error')
  }

  const onError = (event: ErrorEvent): void => say(event.error ?? event.message)
  const onRejection = (event: PromiseRejectionEvent): void => say(event.reason)

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  const stopListeningToMain = window.deepPink.onProblem(say)

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    stopListeningToMain()
  }
}
