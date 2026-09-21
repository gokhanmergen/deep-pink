const path = require('node:path')
const { suite, settle, message } = require('./support/harness')

/**
 * Regression cover for replies duplicating.
 *
 * `init()` subscribed to the main process without a guard, and React's
 * StrictMode invokes effects twice — so two listeners each applied every
 * streamed delta. Replies arrived as "11.. Install Install via via Mason
 * Mason", above a stack of empty assistant bubbles, one per extra listener.
 */
suite('renderer streaming — one subscription, one bubble per turn', async ({ check, section }) => {
  const chatListeners = []
  /** Threads the main process would admit to working on. */
  const reallyGenerating = new Set()
  /** What each `chat.send` was asked to regenerate from. */
  const askedFrom = []
  const mcpListeners = []
  const syncListeners = []
  const syncStateListeners = []
  const syncProgressListeners = []
  let persisted = []
  let liveStreams = []
  // Stands in for the folders table, so the store's optimism can be checked
  // against what the main process would actually have come back with.
  const storedFolders = []
  // Threads besides the fixture, for the "leave an empty one behind" checks.
  const extraThreads = []
  const removed = []
  /** Every `messages.open`, so the tests can say where a thread was read from. */
  const opened = []
  /** Every `messages.keyPoint`, so the tests can say what was sent with it. */
  const keyPointAsks = []
  let createdCount = 0

  const thread = {
    id: 't1',
    title: 'Fixture',
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    archived: false,
    folderId: null,
    config: { disabledPromptSegments: [] }
  }

  // Stand in for the preload bridge, which the store reads at module scope.
  global.window = {
    deepPink: {
      platform: 'linux',
      settings: { get: async () => ({ ui: {}, keybinds: {}, web: {}, compaction: {} }) },
      threads: {
        list: async () => extraThreads.concat([thread]).map((t) => ({ ...t })),
        create: async () => {
          // Counted, not derived from the list's length: a deleted thread would
          // otherwise hand its id to the next one, and "was this deleted?" would
          // answer for the wrong conversation.
          const made = {
            ...thread,
            id: `made-${++createdCount}`,
            title: '',
            messageCount: 0,
            temporary: false
          }
          extraThreads.push(made)
          return { ...made }
        },
        makeTemporary: async (id) => {
          const one = extraThreads.find((t) => t.id === id)
          // The main process refuses a thread that has been spoken in, and the
          // store has to believe it.
          if (!one || one.messageCount > 0) return null
          one.temporary = true
          return { ...one }
        },
        keep: async (id) => {
          const one = extraThreads.find((t) => t.id === id)
          if (!one) return null
          one.temporary = false
          return { ...one }
        },
        remove: async (id) => {
          removed.push(id)
          const at = extraThreads.findIndex((t) => t.id === id)
          if (at >= 0) extraThreads.splice(at, 1)
        },
        setFolder: async (id, folderId) => {
          if (id !== thread.id) return null
          if (folderId !== null && !storedFolders.some((f) => f.id === folderId)) return null
          thread.folderId = folderId
          return { ...thread }
        }
      },
      folders: {
        list: async () => storedFolders.map((f) => ({ ...f })),
        create: async (name) => {
          if (!name.trim()) return null
          const folder = { id: `f${storedFolders.length + 1}`, name: name.trim(), createdAt: 0, pinned: false }
          storedFolders.push(folder)
          return { ...folder }
        },
        update: async (id, patch) => {
          const folder = storedFolders.find((f) => f.id === id)
          if (!folder) return null
          Object.assign(folder, patch)
          return { ...folder }
        },
        remove: async (id) => {
          const at = storedFolders.findIndex((f) => f.id === id)
          if (at >= 0) storedFolders.splice(at, 1)
          if (thread.folderId === id) thread.folderId = null
        }
      },
      // Only the fixture thread has a transcript; the rest are as empty as the
      // database would report them.
      //
      // The transcript arrives a page at a time, so the stub answers in pages.
      // The fixture is short enough to be one, which is the ordinary case and
      // keeps these tests about streaming rather than about paging.
      messages: {
        list: async (id) => (id === thread.id ? persisted : []),
        page: async (id) => ({
          messages: id === thread.id ? persisted : [],
          startSeq: id === thread.id && persisted.length ? 0 : null,
          hasOlder: false
        }),
        from: async (id) => ({
          messages: id === thread.id ? persisted : [],
          startSeq: id === thread.id && persisted.length ? 0 : null,
          hasOlder: false
        }),
        totals: async () => ({ costUsd: 0, totalTokens: 0 }),
        keyPoint: async (messageId, question, reply, candidates) => {
          keyPointAsks.push({ messageId, question, reply, candidates })
          return null
        },
        /**
         * How a thread is actually opened — one crossing carrying all four
         * answers. `opened` records what it was asked for, because *where* a
         * thread is read back from is the whole of reopening it in its place.
         */
        open: async (id, _limit, from = null) => {
          opened.push({ id, from })
          return {
            page: {
              messages: id === thread.id ? persisted : [],
              startSeq: id === thread.id && persisted.length ? 0 : null,
              hasOlder: false
            },
            totals: { costUsd: 0, totalTokens: 0 },
            generating: false,
            live: liveStreams
          }
        }
      },
      attachments: { images: async () => [] },
      models: { list: async () => [] },
      chat: {
        isGenerating: async () => false,
        // What the main process would say is really running. The store checks
        // itself against this, so a suite without it strands the check.
        generating: async () => [...reallyGenerating],
        liveStreams: async () => liveStreams,
        /** Every turn asked for, so a shortcut can be checked by what it sent. */
        send: async (req) => {
          askedFrom.push(req.regenerateFromMessageId ?? null)
        },
        onEvent: (fn) => {
          chatListeners.push(fn)
          return () => chatListeners.splice(chatListeners.indexOf(fn), 1)
        }
      },
      mcp: {
        statuses: async () => [],
        onStatus: (fn) => {
          mcpListeners.push(fn)
          return () => mcpListeners.splice(mcpListeners.indexOf(fn), 1)
        }
      },
      sync: {
        state: async () => ({
          config: { enabled: false, scopes: { conversations: true, settings: true } },
          hasKey: false,
          ready: false,
          running: false,
          lastSyncedAt: null,
          lastError: null,
          lastResult: null
        }),
        onState: (fn) => {
          syncStateListeners.push(fn)
          return () => syncStateListeners.splice(syncStateListeners.indexOf(fn), 1)
        },
        onProgress: (fn) => {
          syncProgressListeners.push(fn)
          return () => syncProgressListeners.splice(syncProgressListeners.indexOf(fn), 1)
        },
        onChanged: (fn) => {
          syncListeners.push(fn)
          return () => syncListeners.splice(syncListeners.indexOf(fn), 1)
        }
      }
    }
  }

  const { useStore, disposeStore } = require(
    path.join(__dirname, '..', '.test-build', 'store.js')
  )

  const emit = (event) => chatListeners.slice().forEach((fn) => fn(event))
  const state = () => useStore.getState()

  section('subscriptions')
  await state().init()
  await state().init() // what StrictMode does
  await state().init()

  check('the chat stream is subscribed to exactly once', chatListeners.length === 1, chatListeners.length)
  check('MCP status is subscribed to exactly once', mcpListeners.length === 1, mcpListeners.length)
  /*
   * Starting the app opens a blank chat, not whatever was open last.
   *
   * It used to select the first thread in the list — pinned first, then most
   * recently touched — which dropped you into the middle of a conversation you
   * were not thinking about. `made-1` is the stub's first creation, so seeing
   * it here is seeing that a thread was made rather than chosen.
   */
  check(
    'starting up opens a new chat rather than the last one used',
    state().activeThreadId === 'made-1',
    state().activeThreadId
  )

  // Everything below is about the conversation in `t1`, so go there — which
  // also sweeps the blank one, since leaving an untouched thread deletes it.
  await state().selectThread('t1')
  check('the active thread was selected', state().activeThreadId === 't1')
  check(
    'and the blank one it started in did not survive being left',
    !state().threads.some((t) => t.id === 'made-1'),
    state().threads.map((t) => t.id)
  )

  section('a single turn')
  const userRow = message({ id: 'u1', threadId: 't1', role: 'user', content: 'hi' })
  const assistantRow = message({
    id: 'a1',
    threadId: 't1',
    role: 'assistant',
    content: '',
    status: 'streaming'
  })

  // The main process writes both rows before it emits, as the engine does.
  persisted = [userRow, assistantRow]
  emit({ type: 'start', messageId: 'a1', threadId: 't1' })
  await settle(60)

  emit({ type: 'content', messageId: 'a1', delta: '1. Install ' })
  emit({ type: 'content', messageId: 'a1', delta: 'via Mason' })

  const painted = state().messages
  check('exactly one assistant bubble exists', painted.filter((m) => m.id === 'a1').length === 1,
    painted.map((m) => m.id))
  check(
    'the streamed text is not doubled',
    painted.find((m) => m.id === 'a1').content === '1. Install via Mason',
    painted.find((m) => m.id === 'a1').content
  )
  check(
    'the reply follows the message it answers',
    painted.findIndex((m) => m.id === 'u1') < painted.findIndex((m) => m.id === 'a1'),
    painted.map((m) => m.id)
  )

  section('a repeated start event is ignored')
  emit({ type: 'start', messageId: 'a1', threadId: 't1' })
  await settle(60)
  check(
    'no second bubble appears for the same turn',
    state().messages.filter((m) => m.id === 'a1').length === 1,
    state().messages.map((m) => m.id)
  )
  check(
    'the text already streamed survives',
    state().messages.find((m) => m.id === 'a1').content === '1. Install via Mason',
    state().messages.find((m) => m.id === 'a1').content
  )

  section('a turn that produced nothing is withdrawn')
  persisted = [userRow, assistantRow, message({ id: 'a2', threadId: 't1', role: 'assistant', status: 'streaming' })]
  emit({ type: 'start', messageId: 'a2', threadId: 't1' })
  await settle(60)
  check('the new turn is on screen', state().messages.some((m) => m.id === 'a2'))

  emit({ type: 'aborted', messageId: 'a2', threadId: 't1' })
  check('an aborted empty turn leaves no bubble', !state().messages.some((m) => m.id === 'a2'),
    state().messages.map((m) => m.id))
  check('generating is cleared', state().generating === false)

  section('events for other threads are ignored')
  const before = state().messages.length
  emit({ type: 'start', messageId: 'other', threadId: 'some-other-thread' })
  await settle(30)
  check('a different thread does not paint here', state().messages.length === before,
    state().messages.map((m) => m.id))

  /**
   * Away and back again, which is what reopening means now.
   *
   * Asking for the thread you are already in does nothing — it used to re-read
   * the transcript and throw away your place in it. So a suite that wants the
   * transcript read again has to leave first, exactly as a reader would.
   */
  const reopen = async (id) => {
    await state().selectThread(null)
    await state().selectThread(id)
  }

  section('leaving a thread mid-reply and coming back')
  // The reply so far lives in the main process, not in whichever window was
  // showing it, so reopening the thread must show all of it — not just what
  // arrived after the return.
  const partial = message({ id: 'a9', threadId: 't1', role: 'assistant', content: '', status: 'streaming' })
  persisted = [userRow, partial]
  liveStreams = [{ threadId: 't1', messageId: 'a9', content: 'The first half', reasoning: '' }]

  await reopen('t1')
  const reopened = state().messages.find((m) => m.id === 'a9')
  check('the text streamed while away is restored', reopened.content === 'The first half', reopened.content)
  check('and it is still shown as streaming', reopened.status === 'streaming', reopened.status)

  emit({ type: 'content', messageId: 'a9', delta: ' and the second half.' })
  check(
    'further deltas continue from there rather than replacing it',
    state().messages.find((m) => m.id === 'a9').content === 'The first half and the second half.',
    state().messages.find((m) => m.id === 'a9').content
  )

  // Nothing in flight: the stored row is authoritative and must not be clobbered.
  liveStreams = []
  persisted = [userRow, message({ id: 'a9', threadId: 't1', role: 'assistant', content: 'The whole reply.', status: 'complete' })]
  await reopen('t1')
  check(
    'a finished reply loads whole from storage',
    state().messages.find((m) => m.id === 'a9').content === 'The whole reply.',
    state().messages.find((m) => m.id === 'a9').content
  )

  section('tool rounds read as one turn')
  const { groupIntoTurns } = require(path.join(__dirname, '..', '.test-build', 'store.js'))

  const turnRows = [
    message({ id: 'u', role: 'user', content: 'search for it' }),
    message({ id: 'a', role: 'assistant', content: 'Let me look.', model: 'm',
      toolCalls: [{ id: 'c1', name: 'web_search', arguments: '{}' }] }),
    message({ id: 't', role: 'tool', content: 'results',
      toolResult: { toolCallId: 'c1', name: 'web_search', content: 'results', isError: false, durationMs: 9 } }),
    message({ id: 'a2', role: 'assistant', content: 'Here is the answer.', model: 'm' }),
    message({ id: 'u2', role: 'user', content: 'thanks' })
  ]
  const blocks = groupIntoTurns(turnRows)

  check('a tool round does not split the reply apart', blocks.length === 3, blocks.map((b) => b.kind))
  check('the user message stands alone', blocks[0].kind === 'message' && blocks[0].id === 'u')
  check(
    'the reply, its tool call and its conclusion are one turn',
    blocks[1].kind === 'turn' && blocks[1].messages.map((m) => m.id).join() === 'a,t,a2',
    blocks[1].kind === 'turn' ? blocks[1].messages.map((m) => m.id) : blocks[1]
  )
  check('the following user message starts a new block', blocks[2].id === 'u2')

  check(
    'title-cost markers are never shown',
    groupIntoTurns([message({ id: 'x', role: 'system', content: '', compactedInto: 'title' })]).length === 0
  )
  check(
    'a turn of nothing but empty placeholders is dropped',
    groupIntoTurns([
      message({ id: 'e1', role: 'assistant', content: '', status: 'aborted' }),
      message({ id: 'e2', role: 'assistant', content: '', status: 'error' })
    ]).length === 0
  )
  check(
    'a streaming placeholder is still shown',
    groupIntoTurns([message({ id: 's', role: 'assistant', content: '', status: 'streaming' })]).length === 1
  )

  section('leaving a thread nobody used')
  const blank = {
    id: 'blank',
    title: '',
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    archived: false,
    folderId: null,
    messageCount: 0,
    config: { disabledPromptSegments: [] }
  }
  extraThreads.push(blank)
  await state().refreshThreads()
  await state().selectThread('blank')
  check('the empty thread can be opened', state().activeThreadId === 'blank')

  await state().selectThread('t1')
  check('leaving it deletes it', removed.includes('blank'), removed)
  check(
    'and it goes from the list on the spot',
    !state().threads.some((t) => t.id === 'blank'),
    state().threads.map((t) => t.id)
  )
  check('while the thread moved to is untouched', state().activeThreadId === 't1')

  const kept = [
    { ...blank, id: 'named', title: 'Has a name' },
    { ...blank, id: 'pinned', pinned: true },
    { ...blank, id: 'filed', folderId: 'f1' },
    { ...blank, id: 'spoken', messageCount: 2 }
  ]
  for (const one of kept) {
    extraThreads.push(one)
    await state().refreshThreads()
    await state().selectThread(one.id)
    await state().selectThread('t1')
  }
  check(
    'a named, pinned, filed or used thread is left alone',
    kept.every((one) => !removed.includes(one.id)),
    removed
  )

  section('a temporary chat does not survive being left')
  // Started as an ordinary chat and turned into one, which is the only way
  // there is: a chat is made temporary before it is used, not instead of
  // being made.
  const ephemeral = await state().createThread()
  check('it opens as the active thread', state().activeThreadId === ephemeral.id, ephemeral)
  check('converting it is allowed while it is empty',
    (await state().makeThreadTemporary(ephemeral.id)) === true)
  check(
    'and it is marked temporary',
    state().threads.find((t) => t.id === ephemeral.id)?.temporary === true,
    state().threads.find((t) => t.id === ephemeral.id)
  )

  await state().selectThread('t1')
  check('leaving it deletes it, empty or not', removed.includes(ephemeral.id), removed)
  check(
    'and it goes from the list on the spot',
    !state().threads.some((t) => t.id === ephemeral.id),
    state().threads.map((t) => t.id)
  )

  // The one thing that has to be true of a chat that was spoken in: leaving it
  // still ends it. The abandoned-thread sweep above would have kept this one.
  const usedUp = await state().createThread()
  await state().makeThreadTemporary(usedUp.id)
  extraThreads.find((t) => t.id === usedUp.id).messageCount = 3
  await state().refreshThreads()
  await state().selectThread('t1')
  check('one that was spoken in goes too', removed.includes(usedUp.id), removed)

  section('a chat that has been used cannot be made temporary')
  const alreadyUsed = await state().createThread()
  extraThreads.find((t) => t.id === alreadyUsed.id).messageCount = 4
  await state().refreshThreads()
  check('the store reports the refusal',
    (await state().makeThreadTemporary(alreadyUsed.id)) === false)
  check(
    'and the thread is left alone',
    state().threads.find((t) => t.id === alreadyUsed.id)?.temporary === false
  )
  await state().selectThread('t1')
  check('so leaving it does not delete it', !removed.includes(alreadyUsed.id), removed)

  const rescued = await state().createThread()
  await state().makeThreadTemporary(rescued.id)
  // Spoken in, so the abandoned-empty-thread sweep has nothing to say about it
  // and only the temporary rule is under test.
  extraThreads.find((t) => t.id === rescued.id).messageCount = 2
  await state().keepThread(rescued.id)
  check(
    'keeping it stops it being temporary',
    state().threads.find((t) => t.id === rescued.id)?.temporary === false,
    state().threads.find((t) => t.id === rescued.id)
  )
  await state().selectThread('t1')
  check('and then leaving it leaves it alone', !removed.includes(rescued.id), removed)

  section('a row cannot be left saying a reply is still coming')
  /*
   * The sidebar's idea of which threads are working is assembled from events,
   * and an assembled idea can be wrong in one direction forever. A turn whose
   * ending never arrives, or arrives naming a message this window never saw
   * start, used to leave the row lit and its name shimmering for the rest of
   * the session — there was nothing that ever went back and checked.
   */
  reallyGenerating.clear()
  emit({ type: 'start', messageId: 'stuck-1', threadId: 't1' })
  check('the row lights up when a turn starts', state().generatingThreadIds.includes('t1'))

  // A failure the renderer cannot match to anything it has seen.
  emit({ type: 'error', messageId: 'a-message-from-another-life', error: 'boom' })
  check(
    'an error it cannot place leaves it lit, for now',
    state().generatingThreadIds.includes('t1')
  )

  // Four seconds is the interval; this gives it one turn of the wheel.
  await settle(5200)
  check(
    'but the main process is asked, and it goes out',
    !state().generatingThreadIds.includes('t1'),
    state().generatingThreadIds
  )

  // And the reverse: a turn that really is running is left alone.
  reallyGenerating.add('t1')
  emit({ type: 'start', messageId: 'live-1', threadId: 't1' })
  await settle(5200)
  check(
    'a turn that really is running stays lit',
    state().generatingThreadIds.includes('t1'),
    state().generatingThreadIds
  )
  reallyGenerating.clear()
  emit({ type: 'done', messageId: 'live-1', message: message({ id: 'live-1', threadId: 't1', role: 'assistant', content: 'done' }) })

  section('regenerating, when there is nothing to regenerate')
  /*
   * A turn stopped before it produced anything leaves no assistant message at
   * all — the empty one is withdrawn — so the last thing in the conversation
   * is the question, and the transcript offers "Ask again". The shortcut for
   * the same thing looked for the newest assistant message and did nothing
   * when there was none: the button worked and the keystroke silently did
   * not.
   *
   * And in a thread with history it was worse than nothing. The newest
   * assistant message was then one from an earlier exchange, and regenerating
   * that throws away everything after it — including the question nobody had
   * answered.
   */
  const pressRegenerate = async (messages) => {
    askedFrom.length = 0
    useStore.setState({ activeThreadId: 't1', messages })
    buildActions(state()).find((a) => a.id === 'message.regenerate').run()
    await settle(40)
    return askedFrom[0] ?? null
  }

  const q1 = message({ id: 'q1', threadId: 't1', role: 'user', content: 'first' })
  const a1 = message({ id: 'a1', threadId: 't1', role: 'assistant', content: 'answered' })
  const q2 = message({ id: 'q2', threadId: 't1', role: 'user', content: 'second' })

  check(
    'a reply at the end is regenerated',
    (await pressRegenerate([q1, a1])) === 'q1'
  )
  check(
    'a question nobody answered is asked again',
    (await pressRegenerate([q1])) === 'q1'
  )
  check(
    'and after an earlier exchange it is that question, not the old reply',
    (await pressRegenerate([q1, a1, q2])) === 'q2'
  )
  check('an empty thread asks for nothing', (await pressRegenerate([])) === null)

  section('a thread reopens where it was left')
  const { rememberPlace, placeOf, forgetPlace } = require(
    path.join(__dirname, '..', '.test-build', 'store.js')
  )

  await state().selectThread(null)
  opened.length = 0
  await state().selectThread('t1')
  check(
    'a thread never read before is read from its end',
    opened.at(-1)?.from === null,
    opened.at(-1)
  )

  // Scrolled back six pages and left there. Only the transcript knows the
  // offset; what the store has to carry is which part of the conversation was
  // loaded, because an offset means nothing against a different range.
  rememberPlace('t1', { startSeq: 120, scrollTop: 2400, atBottom: false })
  check('the place is kept', placeOf('t1')?.startSeq === 120, placeOf('t1'))

  opened.length = 0
  await state().selectThread('somewhere-else')
  await state().selectThread('t1')
  check(
    'and coming back reads from there rather than from the end',
    opened.at(-1)?.from === 120,
    opened
  )

  // Left at the end, and the end is not somewhere: whatever range happened to
  // be loaded on the way down is not worth reading in again.
  rememberPlace('t1', { startSeq: 120, scrollTop: 99999, atBottom: true })
  opened.length = 0
  await state().selectThread('somewhere-else')
  await state().selectThread('t1')
  check(
    'a thread left at the end opens at the end, not at the range it had loaded',
    opened.at(-1)?.from === null,
    opened.at(-1)
  )

  forgetPlace('t1')
  check('a thread can be forgotten', placeOf('t1') === null)
  opened.length = 0
  await state().selectThread('somewhere-else')
  await state().selectThread('t1')
  check('after which it opens at the end again', opened.at(-1)?.from === null, opened.at(-1))

  section('folders')
  const created = await state().createFolder('Reading')
  check('creating a folder returns it', created?.name === 'Reading', created)
  check('it joins the list', state().folders.length === 1, state().folders)
  check(
    'and opens, so an empty folder is visibly there',
    state().openFolderIds.includes(created.id),
    state().openFolderIds
  )
  check('an empty name creates nothing', (await state().createFolder('   ')) === null)

  state().toggleFolder(created.id)
  check('toggling shuts it', state().openFolderIds.length === 0, state().openFolderIds)

  await state().moveThreadToFolder('t1', created.id)
  check(
    'filing a thread records the folder on it',
    state().threads.find((t) => t.id === 't1').folderId === created.id
  )
  check(
    'and opens the folder it went into, so it is not seen to vanish',
    state().openFolderIds.includes(created.id),
    state().openFolderIds
  )

  await state().moveThreadToFolder('t1', 'gone')
  check(
    'a drop onto a folder that no longer exists does not strand the thread',
    state().threads.find((t) => t.id === 't1').folderId === created.id,
    state().threads.find((t) => t.id === 't1').folderId
  )

  await state().moveThreadToFolder('t1', null)
  check('taking it out clears the folder', state().threads.find((t) => t.id === 't1').folderId === null)

  await state().moveThreadToFolder('t1', created.id)
  await state().renameFolder(created.id, 'Later')
  check('renaming lands on the folder', state().folders[0].name === 'Later')
  await state().setFolderPinned(created.id, true)
  check('pinning lands on the folder', state().folders[0].pinned === true)

  state().closeAllFolders()
  check('closing them all leaves none open', state().openFolderIds.length === 0)

  await state().deleteFolder(created.id)
  check('deleting removes the folder', state().folders.length === 0, state().folders)
  check(
    'and the thread it held is still here, now loose',
    state().threads.find((t) => t.id === 't1')?.folderId === null,
    state().threads
  )

  section('zoom shortcuts match the keys people actually press')
  const { matchesBinding } = require(path.join(__dirname, '..', '.test-build', 'store.js'))
  // The stub reports platform 'linux', so `mod` is Ctrl here.
  const press = (key, mods = {}) => ({
    key,
    ctrlKey: Boolean(mods.ctrl),
    metaKey: Boolean(mods.meta),
    shiftKey: Boolean(mods.shift),
    altKey: Boolean(mods.alt)
  })

  check("ctrl+= zooms in", matchesBinding(press('=', { ctrl: true }), 'mod+='))
  check(
    "ctrl+shift+= zooms in, because that is the '+' on the keycap",
    matchesBinding(press('+', { ctrl: true, shift: true }), 'mod+=')
  )
  check('ctrl+- zooms out', matchesBinding(press('-', { ctrl: true }), 'mod+-'))
  check(
    "ctrl+shift+- zooms out, because that is '_'",
    matchesBinding(press('_', { ctrl: true, shift: true }), 'mod+-')
  )
  check('ctrl+0 resets zoom', matchesBinding(press('0', { ctrl: true }), 'mod+0'))

  check('a bare = does not zoom without the modifier', !matchesBinding(press('='), 'mod+='))
  check(
    'shift is still significant for ordinary keys',
    matchesBinding(press('k', { ctrl: true }), 'mod+k') &&
      !matchesBinding(press('k', { ctrl: true, shift: true }), 'mod+k')
  )
  check(
    'and a shift binding still requires shift',
    matchesBinding(press('m', { ctrl: true, shift: true }), 'mod+shift+m') &&
      !matchesBinding(press('m', { ctrl: true }), 'mod+shift+m')
  )

  section('the question a reply is marked against')
  /*
   * Which sentence of a reply matters is not a property of the reply.
   *
   * Asked to mark the key points of an answer on its own, a model marks what
   * the answer emphasises — a reply to five questions came back with seven
   * marks and a reply to one came back with the sentence that set it up. So
   * the question goes with it, and the store is where it comes from, because
   * the store is the only place that holds the turn the reply belongs to.
   */
  const askedWith = async (messages, messageId) => {
    keyPointAsks.length = 0
    useStore.setState({ activeThreadId: 't1', messages })
    await state().findKeyPoint(messageId, 'a reply', ['one sentence.', 'another sentence.'])
    return keyPointAsks[0] ?? null
  }

  const kq1 = message({ id: 'kq1', threadId: 't1', role: 'user', content: 'what is a closure?' })
  const ka1 = message({ id: 'ka1', threadId: 't1', role: 'assistant', content: 'a reply' })
  const kq2 = message({ id: 'kq2', threadId: 't1', role: 'user', content: 'and why does var break it?' })
  const ka2 = message({ id: 'ka2', threadId: 't1', role: 'assistant', content: 'a second reply' })

  check(
    'the question above the reply travels with it',
    (await askedWith([kq1, ka1], 'ka1'))?.question === 'what is a closure?'
  )
  // The wrong question is worse than none: it renames what the reply is about,
  // and the count of marks follows it.
  check(
    'and in a thread with history it is that turn, not the first',
    (await askedWith([kq1, ka1, kq2, ka2], 'ka2'))?.question === 'and why does var break it?',
    await askedWith([kq1, ka1, kq2, ka2], 'ka2')
  )
  check(
    'a reply with nothing above it asks anyway, with no question',
    (await askedWith([ka1], 'ka1'))?.question === ''
  )
  check(
    'and the reply and its sentences still go',
    (await askedWith([kq1, ka1], 'ka1'))?.candidates.length === 2
  )
  // Null is an answer — it is what a reply with nothing worth marking gets —
  // and it has to leave the message with no marks rather than untouched.
  check(
    'nothing worth marking leaves the message unmarked',
    state().messages.find((m) => m.id === 'ka1')?.keyPoints.length === 0,
    state().messages.find((m) => m.id === 'ka1')
  )

  section('a sync that brought something in refreshes the window')
  check('the store subscribed to it', syncListeners.length === 1, syncListeners.length)
  check('and to what a run is doing', syncStateListeners.length === 1 && syncProgressListeners.length === 1)

  // Progress arrives far more often than anything else, so it must land in the
  // store without dragging the rest of the window through a render.
  syncProgressListeners[0]({ phase: 'sending', detail: 'handing over', done: 3, total: 9, pushed: 3, pulled: 0, deleted: 0 })
  check('progress is kept', state().syncProgress?.done === 3, state().syncProgress)

  syncStateListeners[0]({ ...(await window.deepPink.sync.state()), running: false, lastError: 'nope' })
  check('so is the state a run left behind', state().sync?.lastError === 'nope', state().sync)
  check('and the progress of a finished run is cleared', state().syncProgress === null)

  // What a pull looks like from in here: the database changed underneath, and
  // nothing on screen knows until the event says so.
  thread.title = 'Renamed on another machine'
  persisted.push(
    message({ id: 'from-elsewhere', threadId: 't1', role: 'user', content: 'said on the laptop' })
  )
  syncListeners.slice().forEach((fn) => fn())
  await settle(60)

  check(
    'the thread list catches up',
    state().threads.find((t) => t.id === 't1')?.title === 'Renamed on another machine',
    state().threads
  )
  check(
    'and so does the open transcript',
    state().messages.some((m) => m.id === 'from-elsewhere'),
    state().messages.map((m) => m.id)
  )

  disposeStore()
  check('an alt+digit binding matches', matchesBinding(press('1', { alt: true }), 'alt+1'))
  check(
    'and still does where the option key rewrote the character',
    matchesBinding({ ...press('\u00a1', { alt: true }), code: 'Digit1' }, 'alt+1'),
    'macOS Option+1'
  )
  check('a bare 1 does not match it', !matchesBinding(press('1'), 'alt+1'))

  check('disposing removes the listeners', chatListeners.length === 0)
  check(
    'every one of them',
    syncListeners.length === 0 &&
      mcpListeners.length === 0 &&
      syncStateListeners.length === 0 &&
      syncProgressListeners.length === 0
  )
})
