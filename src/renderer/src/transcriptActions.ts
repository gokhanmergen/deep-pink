import { createContext, useContext } from 'react'
import { useStore } from './store'

/**
 * What a message's own buttons do, and to which conversation.
 *
 * A message used to reach into the store for these, which answered for the
 * open thread — the only transcript there was. Side by side there are two on
 * screen and neither is the open thread, so a Retry pressed in either column
 * asked the store to retry in a thread that was not there, and did nothing.
 *
 * So a transcript says what its messages act on, and a message asks it. The
 * ordinary view says nothing and gets the open thread, exactly as before.
 */
export interface TranscriptActions {
  /** Runs the turn again from the message before this reply. */
  regenerate: (messageId: string) => Promise<void>
  /** Answers this message again, dropping everything after it. */
  resendFrom: (messageId: string) => Promise<void>
  /** Re-reads the loaded range in place, after an edit that asked nothing. */
  refresh: () => Promise<void>
  /** Copies the conversation up to this message into a thread of its own. */
  branch: (messageId: string) => Promise<void>
  /**
   * Opens the system prompt inspector, or null where it has nothing to show:
   * it describes the open thread, and a side of a comparison is not that.
   */
  inspectPrompt: (() => void) | null
}

/**
 * Copies a conversation up to a message and opens the copy.
 *
 * Opening it is what closes a comparison, if one was open: the branch is an
 * ordinary thread, and it is shown as one.
 */
export async function branchThread(threadId: string, messageId: string): Promise<void> {
  const store = useStore.getState()
  const thread = await window.deepPink.threads.branch(threadId, messageId)
  if (!thread) return
  await store.refreshThreads()
  await store.selectThread(thread.id)
  store.showToast('Branched into a new thread')
}

/** The open thread's, read from the store at the moment they are used. */
const OPEN_THREAD: TranscriptActions = {
  regenerate: (messageId) => useStore.getState().regenerate(messageId),
  resendFrom: (messageId) => useStore.getState().resendFrom(messageId),
  refresh: () => useStore.getState().refreshTranscript(),
  branch: async (messageId) => {
    const threadId = useStore.getState().activeThreadId
    if (threadId) await branchThread(threadId, messageId)
  },
  inspectPrompt: () => useStore.getState().setOverlay('prompt')
}

export const TranscriptActionsContext = createContext<TranscriptActions | null>(null)

export function useTranscriptActions(): TranscriptActions {
  return useContext(TranscriptActionsContext) ?? OPEN_THREAD
}
