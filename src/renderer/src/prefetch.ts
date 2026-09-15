import { highlight } from './highlight'
import { fencedCode } from './fences'
import { placeOf, transcriptPageSize, useStore } from './store'

/**
 * Reading a thread, and highlighting the code in it, before it is opened.
 *
 * Opening a conversation is fast now up to the point where the code in it
 * turns colour. Measured on a real library (2026-09-14): a heavy thread put
 * its text on screen in ~85ms and the last of its sixteen blocks came back
 * from the worker at ~215ms — and for almost all of that gap the main thread
 * is idle, because the work is happening on the worker. Hovering the row for a
 * moment first brought the last block back at ~88ms, in the same commit as the
 * text, so the transcript arrives already coloured.
 *
 * That is the shape of a thing worth doing early: the worker has nothing to do
 * while a pointer rests on a row, `highlight` keeps whatever it works out, and
 * `CodeBlock` starts from `highlightedAlready` — so a block warmed during the
 * hover paints coloured in the frame it mounts in, with no plain-text flash.
 *
 * Nothing here changes what is shown. If a prefetch never runs, never
 * finishes, or warms text that turns out not to match, the transcript takes
 * exactly the path it takes today.
 *
 * This imports the store rather than living in it, and deliberately: the store
 * is bundled on its own for its tests, and a store that reached the
 * highlighter would pull the whole of shiki into that bundle.
 */

/**
 * The most blocks one prefetch will warm.
 *
 * A bound rather than a tuning: what is being warmed is one screenful of
 * conversation, so this is only reached by something pathological, and the
 * cache it fills holds four hundred entries for the whole session.
 */
const MOST_BLOCKS = 40

/** Past this, a block is not what anybody is about to read. */
const TOO_BIG = 200_000

/**
 * Threads already handed to the highlighter.
 *
 * Ids only, and never cleared: what this guards is doing the work twice, and a
 * thread whose blocks are in the highlighter's cache would only find them
 * there anyway. Eight hundred short strings is not a memory question.
 */
const done = new Set<string>()
let busy = false

/**
 * The one request that arrived while another was running.
 *
 * Without this, a hover during the read of somebody else's thread would simply
 * be dropped — and the thing most likely to be running is the read of a
 * neighbour, started because a thread was opened, which is exactly what the
 * reader is doing when they go looking for the next one. One slot, because
 * what is wanted is the thread under the pointer now and not the four it
 * crossed on the way.
 */
let queued: string | null = null

/** Hands every block in some text to the highlighter, and forgets about it. */
function warmCodeBlocks(contents: string[], theme: string): void {
  let warmed = 0
  for (const content of contents) {
    if (!content.includes('```') && !content.includes('~~~')) continue
    for (const { code, lang } of fencedCode(content)) {
      if (!code || code.length > TOO_BIG) continue
      if (warmed++ >= MOST_BLOCKS) return
      void highlight(code, lang, theme)
    }
  }
}

/**
 * Reads a thread early and highlights what is in it.
 *
 * One at a time, and never the same thread twice. A pointer crossing the
 * sidebar passes over a great many rows, and this reads a screenful of
 * conversation and then hands every code block in it to the worker — doing
 * that for thirty threads because the pointer travelled through them would be
 * spending the idle worker on the one thread nobody asked for. The id is
 * marked before the read rather than after, so a second call during the read
 * does not start another.
 */
export async function prefetchThread(id: string | null): Promise<void> {
  if (!id || id === useStore.getState().activeThreadId || done.has(id)) return
  if (busy) {
    queued = id
    return
  }

  busy = true
  done.add(id)

  try {
    // The same read the open will make, from the same place — a page warmed
    // from the end of a thread the reader left in the middle is a page they
    // are not about to see.
    const place = placeOf(id)
    const { page } = await window.deepPink.messages.open(
      id,
      transcriptPageSize(),
      place && !place.atBottom ? place.startSeq : null
    )
    const theme = useStore.getState().settings?.ui.codeTheme
    if (theme) {
      warmCodeBlocks(
        page.messages.map((message) => message.content),
        theme
      )
    }
  } catch {
    // A thread deleted since the pointer touched it, or a read that failed.
    // This is an optimisation; there is nothing here worth reporting.
  } finally {
    busy = false
    const next = queued
    queued = null
    if (next) void prefetchThread(next)
  }
}
