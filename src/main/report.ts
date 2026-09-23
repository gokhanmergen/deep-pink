import { BrowserWindow } from 'electron'

/**
 * Saying, in the window, what used to be said only to the terminal.
 *
 * Almost everything that goes wrong in this app goes wrong in the main
 * process: the request, the database, the keyring, the file being imported.
 * The renderer hears about the ones it asked for — an `invoke` that rejects
 * comes back to the `await` that made it — and hears nothing at all about the
 * rest. An image that could not be stored, a name that could not be
 * generated, a background sweep that threw: each of those printed a line to a
 * console nobody running the packaged app has open, and the window carried on
 * as though the thing had worked.
 *
 * So there is one way to say it, and it says it twice: to the log, where it
 * has always gone and where a developer will look for it, and to every open
 * window, where the person it happened to will see it.
 *
 * Not every message — only the ones that are a failure. Housekeeping notices
 * ("removed 3 empty threads") stay in the log, because a toast is an
 * interruption and being told that routine maintenance happened is not worth
 * one.
 */

const PROBLEM_EVENT = 'app:problem'

export function reportProblem(problem: unknown, context?: string): void {
  const said = problem instanceof Error ? problem.message : String(problem)
  const message = context ? `${context}: ${said}` : said

  console.error(message)
  for (const win of BrowserWindow.getAllWindows()) {
    // A window mid-teardown will refuse the send and throw from inside a
    // catch block somewhere upstream; this is the last place an error can be
    // reported, so it must not be a place one can be raised.
    try {
      if (!win.isDestroyed()) win.webContents.send(PROBLEM_EVENT, message)
    } catch {
      /* nothing left to report it to */
    }
  }
}

/**
 * The failures nobody caught.
 *
 * A throw from a callback, or a promise nobody awaited, used to land in
 * Electron's default handler: a stack trace on stderr, and for an
 * `unhandledRejection` a process that in newer Node would end there. Neither
 * of those is a thing the app can do in front of somebody mid-conversation.
 *
 * Installed once, at startup, before anything that might fail.
 */
export function reportUncaught(): void {
  process.on('uncaughtException', (err) => reportProblem(err))
  process.on('unhandledRejection', (reason) => reportProblem(reason))
}
