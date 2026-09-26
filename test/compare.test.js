const path = require('node:path')
const { suite, settle, message } = require('./support/harness')

/**
 * Side by side: two models asked the same first message, then each carrying
 * on by itself.
 *
 * Two halves. The database half is about what a pair *is* — two ordinary
 * threads pointing at each other — and about the ways a thread can be copied
 * without dragging its partner along. The store half is about what makes it a
 * comparison rather than two chats: one question reaching both, and every
 * event afterwards landing on the side it belongs to and nowhere else.
 */
suite('side by side — one question, two conversations', async ({ check, section, subject }) => {
  const { getDb, repo, archive } = subject
  getDb()

  section('a pair is two threads that know each other')
  const [left, right] = repo.createComparePair('anthropic/one', 'openai/two')
  check('the left side is asked with its model', left.config.model === 'anthropic/one', left.config)
  check('the right side is asked with its', right.config.model === 'openai/two', right.config)
  check('the left points at the right', left.config.compareWith === right.id, left.config)
  check('and the right at the left', right.config.compareWith === left.id, right.config)
  check(
    'both are in the list as ordinary threads',
    repo.listThreads().filter((t) => t.id === left.id || t.id === right.id).length === 2
  )
  check(
    'an ordinary thread is paired with nothing',
    repo.createThread('Alone').config.compareWith === null
  )

  section('a branch of one side is a conversation of its own')
  const asked = repo.insertMessage({ threadId: left.id, role: 'user', content: 'Which is larger?' })
  const branch = repo.branchThread(left.id, asked.id)
  check('the branch exists', Boolean(branch))
  check('it claims no partner', branch.config.compareWith === null, branch.config)
  check('it keeps the model it was branched from', branch.config.model === 'anthropic/one', branch.config)
  check(
    'and the partner still points at the side it was compared with',
    repo.getThread(right.id).config.compareWith === left.id,
    repo.getThread(right.id).config
  )

  section('an archive is one thread, and carries no partner')
  const report = archive.parseArchive({
    format: archive.ARCHIVE_FORMAT,
    version: 1,
    threads: [
      {
        id: 'elsewhere',
        title: 'One side, exported',
        createdAt: 1,
        config: { model: 'anthropic/one', compareWith: right.id },
        messages: [{ role: 'user', content: 'Which is larger?' }]
      }
    ]
  })
  check(
    'the link is dropped on reading, even to a thread that is here',
    report.threads[0].config.compareWith === null,
    report.threads[0].config
  )
  check('the rest of the config survives', report.threads[0].config.model === 'anthropic/one')

  /* ---------------------------------------------------------------- *
   * The store, against a stand-in for the main process
   * ---------------------------------------------------------------- */

  const chatListeners = []
  /** Every `chat.send`, in order. */
  const sent = []
  /** Every `threads.createPair`, in order. */
  const pairsMade = []
  /** Every `chat.approveTool`, in order. */
  const approvals = []
  /** Rows as the database would hold them, by thread. */
  const stored = {}
  const threads = []
  let made = 0
  /** Settings as the main process holds them, and every save made to them. */
  let storedSettings = {
    defaultModel: 'test/default',
    sideBySideLeftModel: '',
    sideBySideRightModel: '',
    ui: {},
    keybinds: {},
    web: {},
    compaction: {}
  }
  const settingsSaves = []

  const threadRow = (id, config = {}) => ({
    id,
    title: '',
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    archived: false,
    folderId: null,
    temporary: false,
    messageCount: 0,
    config: { model: null, compareWith: null, disabledPromptSegments: [], repoPaths: [], ...config }
  })

  const page = (id) => ({
    messages: (stored[id] ?? []).slice(),
    startSeq: stored[id]?.length ? 0 : null,
    hasOlder: false
  })

  global.window = {
    deepPink: {
      platform: 'linux',
      settings: {
        get: async () => ({ ...storedSettings }),
        save: async (patch) => {
          settingsSaves.push(patch)
          storedSettings = { ...storedSettings, ...patch }
          return { ...storedSettings }
        }
      },
      threads: {
        list: async () => threads.map((t) => ({ ...t, config: { ...t.config } })),
        create: async () => {
          const row = threadRow(`made-${++made}`)
          threads.push(row)
          return { ...row }
        },
        createPair: async (leftModel, rightModel) => {
          pairsMade.push([leftModel, rightModel])
          const a = threadRow(`pair-${pairsMade.length}-a`, { model: leftModel })
          const b = threadRow(`pair-${pairsMade.length}-b`, { model: rightModel })
          a.config.compareWith = b.id
          b.config.compareWith = a.id
          threads.push(a, b)
          return [{ ...a }, { ...b }]
        },
        update: async (id, patch) => {
          const row = threads.find((t) => t.id === id)
          if (!row) return null
          if (patch.config) row.config = { ...row.config, ...patch.config }
          return { ...row }
        },
        remove: async (id) => {
          const at = threads.findIndex((t) => t.id === id)
          if (at >= 0) threads.splice(at, 1)
          delete stored[id]
        }
      },
      folders: { list: async () => [] },
      messages: {
        page: async (id) => page(id),
        from: async (id) => page(id),
        totals: async () => ({ costUsd: 0, totalTokens: 0 }),
        open: async (id) => ({
          page: page(id),
          totals: { costUsd: 0, totalTokens: 0 },
          generating: false,
          live: []
        })
      },
      attachments: { images: async () => [] },
      models: { list: async () => [] },
      chat: {
        isGenerating: async () => false,
        generating: async () => [],
        liveStreams: async () => [],
        abort: async () => undefined,
        approveTool: async (id, approved) => {
          approvals.push({ id, approved })
        },
        /**
         * What the engine does first, and all a test needs of it: the
         * question is written down before anything is streamed.
         */
        send: async (req) => {
          sent.push(req)
          if (req.content) {
            stored[req.threadId] = [
              ...(stored[req.threadId] ?? []),
              message({
                id: `u-${req.threadId}-${sent.length}`,
                threadId: req.threadId,
                role: 'user',
                content: req.content
              })
            ]
          }
        },
        onEvent: (fn) => {
          chatListeners.push(fn)
          return () => chatListeners.splice(chatListeners.indexOf(fn), 1)
        }
      },
      mcp: { statuses: async () => [], onStatus: () => () => undefined },
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
        onState: () => () => undefined,
        onProgress: () => () => undefined,
        onChanged: () => () => undefined
      }
    }
  }

  const { useStore, buildActions } = require(path.join(__dirname, '..', '.test-build', 'store.js'))
  const state = () => useStore.getState()
  const emit = (event) => chatListeners.slice().forEach((fn) => fn(event))
  const toasts = () => (state().toast ? [state().toast.message] : [])

  await state().init()

  section('opening it')
  const startedIn = state().activeThreadId
  check('the app starts in an ordinary chat', Boolean(startedIn), startedIn)
  check(
    'from there, the toggle offers it by its name',
    buildActions().find((action) => action.id === 'compare.toggle').label === 'Open side by side'
  )
  await state().openCompare()
  check('side by side is open', state().compare !== null)
  check('and no thread is "the" open one', state().activeThreadId === null, state().activeThreadId)
  check(
    'the empty chat it was opened from did not survive being left',
    !threads.some((t) => t.id === startedIn),
    threads.map((t) => t.id)
  )
  check(
    'the left side starts on the model you were using',
    state().compare[0].model === 'test/default',
    state().compare[0].model
  )
  check('the right side waits to be chosen', state().compare[1].model === null)
  check('neither side has a thread yet', !state().compare[0].threadId && !state().compare[1].threadId)

  section('the first message needs both models')
  await state().startCompare('Which is larger, 9.11 or 9.9?')
  check('nothing is made with a side unchosen', pairsMade.length === 0, pairsMade)
  check('nothing is sent', sent.length === 0, sent)
  check('and it says why', /each side/.test(toasts().join()), toasts())

  await state().setCompareModel(1, 'openai/two')
  check('the right side takes the model chosen', state().compare[1].model === 'openai/two')
  check(
    'and it is remembered for next time',
    storedSettings.sideBySideRightModel === 'openai/two',
    settingsSaves
  )
  check(
    'the left, which was only a guess, is not written down',
    storedSettings.sideBySideLeftModel === '',
    storedSettings.sideBySideLeftModel
  )

  section('one question, asked of both')
  await state().startCompare('Which is larger, 9.11 or 9.9?')
  check('one pair is made', pairsMade.length === 1, pairsMade)
  check(
    'with each side’s model, left then right',
    pairsMade[0][0] === 'test/default' && pairsMade[0][1] === 'openai/two',
    pairsMade[0]
  )
  const [a, b] = [state().compare[0].threadId, state().compare[1].threadId]
  check('each side now has its thread', a === 'pair-1-a' && b === 'pair-1-b', [a, b])
  check('two sends, one per side', sent.length === 2, sent)
  check(
    'to both threads',
    sent.some((r) => r.threadId === a) && sent.some((r) => r.threadId === b),
    sent.map((r) => r.threadId)
  )
  check(
    'with the same words',
    sent.every((r) => r.content === 'Which is larger, 9.11 or 9.9?'),
    sent.map((r) => r.content)
  )
  check(
    'each side shows the question, read back from what was stored',
    state().compare.every(
      (pane) =>
        pane.messages.length === 1 &&
        pane.messages[0].role === 'user' &&
        !pane.messages[0].id.startsWith('optimistic-')
    ),
    state().compare.map((pane) => pane.messages.map((m) => m.id))
  )
  check('the ordinary transcript is untouched', state().messages.length === 0, state().messages)

  section('changing a side’s model once it has begun is that conversation’s business')
  const savesBefore = settingsSaves.length
  await state().setCompareModel(0, 'google/mid-way')
  check(
    'the thread takes it',
    threads.find((t) => t.id === a)?.config.model === 'google/mid-way',
    threads.find((t) => t.id === a)?.config
  )
  check(
    'but what side by side opens with is left alone',
    settingsSaves.length === savesBefore && storedSettings.sideBySideLeftModel === '',
    settingsSaves.slice(savesBefore)
  )

  section('each reply lands on its own side')
  stored[a].push(message({ id: 'ra', threadId: a, role: 'assistant', status: 'streaming' }))
  stored[b].push(message({ id: 'rb', threadId: b, role: 'assistant', status: 'streaming' }))
  emit({ type: 'start', messageId: 'ra', threadId: a })
  emit({ type: 'start', messageId: 'rb', threadId: b })
  await settle(40)

  check('both sides are replying', state().compare.every((pane) => pane.generating))
  check(
    'and so the list says of both threads',
    state().generatingThreadIds.includes(a) && state().generatingThreadIds.includes(b),
    state().generatingThreadIds
  )

  // Interleaved, as two streams arriving at once would be.
  emit({ type: 'content', messageId: 'ra', delta: '9.9 is ' })
  emit({ type: 'content', messageId: 'rb', delta: '9.11 is ' })
  emit({ type: 'content', messageId: 'ra', delta: 'larger.' })
  emit({ type: 'content', messageId: 'rb', delta: 'larger.' })

  const replyOn = (side, id) => state().compare[side].messages.find((m) => m.id === id)
  check('the left side has its own reply', replyOn(0, 'ra')?.content === '9.9 is larger.', replyOn(0, 'ra'))
  check('the right side has its own', replyOn(1, 'rb')?.content === '9.11 is larger.', replyOn(1, 'rb'))
  check('the left never shows the right’s', !replyOn(0, 'rb'))
  check('nor the right the left’s', !replyOn(1, 'ra'))
  check('and none of it reached the ordinary transcript', state().messages.length === 0)

  section('one side finishing leaves the other going')
  const finished = message({ id: 'ra', threadId: a, role: 'assistant', content: '9.9 is larger.' })
  // What the engine has written by the time it says so.
  stored[a] = stored[a].map((m) => (m.id === 'ra' ? finished : m))
  emit({ type: 'done', messageId: 'ra', message: finished })
  check('the left has finished', state().compare[0].generating === false)
  check('the right is still replying', state().compare[1].generating === true)
  check(
    'the left reply is the stored one now',
    replyOn(0, 'ra')?.status === 'complete',
    replyOn(0, 'ra')?.status
  )

  section('a failure is the side’s own')
  emit({ type: 'error', messageId: 'rb', threadId: b, error: 'Rate limited' })
  check('the right side shows it', replyOn(1, 'rb')?.error === 'Rate limited', replyOn(1, 'rb'))
  check('and has stopped', state().compare[1].generating === false)
  check('the left side has no error', !replyOn(0, 'ra')?.error)

  section('two tool calls asking at once are both asked')
  const call = (id) => ({ id, name: 'lookup', arguments: '{}' })
  emit({ type: 'tool-approval-request', messageId: 'ra', toolCall: call('call-a'), serverName: 'S' })
  emit({ type: 'tool-approval-request', messageId: 'rb', toolCall: call('call-b'), serverName: 'S' })
  check(
    'the first is on screen',
    state().pendingApproval?.toolCall.id === 'call-a',
    state().pendingApproval
  )
  await state().approveTool(true)
  check(
    'answering it brings up the second rather than dropping it',
    state().pendingApproval?.toolCall.id === 'call-b',
    state().pendingApproval
  )
  await state().approveTool(false)
  check('then nothing is waiting', state().pendingApproval === null)
  check(
    'and each got its own answer',
    approvals.length === 2 &&
      approvals[0].id === 'call-a' && approvals[0].approved === true &&
      approvals[1].id === 'call-b' && approvals[1].approved === false,
    approvals
  )

  section('after the first message, each side goes its own way')
  const before = sent.length
  const rightBefore = state().compare[1].messages.map((m) => m.id).join()
  await state().sendToPane(0, 'Explain why.')
  check('one send', sent.length === before + 1, sent.slice(before))
  check('to the left thread only', sent[sent.length - 1].threadId === a, sent[sent.length - 1])
  check(
    'the left side has the follow-up',
    state().compare[0].messages.some((m) => m.role === 'user' && m.content === 'Explain why.'),
    state().compare[0].messages.map((m) => m.content)
  )
  check(
    'the right side is exactly as it was',
    state().compare[1].messages.map((m) => m.id).join() === rightBefore
  )

  section('shortcuts that mean "the open thread" say so')
  check(
    'the toggle offers to close it',
    buildActions().find((action) => action.id === 'compare.toggle').label === 'Close side by side'
  )
  buildActions().find((action) => action.id === 'model.picker').run()
  check('changing model does not open the default-model picker', state().overlay === null, state().overlay)
  check('it points at the sides instead', /top of that side/.test(toasts().join()), toasts())

  section('opening a thread closes it')
  await state().selectThread(a)
  check('side by side is closed', state().compare === null)
  check('the thread opened is the open one', state().activeThreadId === a)
  check(
    'and from it, the toggle offers its pair',
    buildActions().find((action) => action.id === 'compare.toggle').label ===
      'Open side by side with its pair'
  )

  section('reopening the pair')
  await buildActions().find((action) => action.id === 'compare.toggle').run()
  check('side by side is open again', state().compare !== null)
  check(
    'with the thread you were in on the left',
    state().compare[0].threadId === a && state().compare[1].threadId === b,
    state().compare?.map((pane) => pane.threadId)
  )
  check(
    'each side read back from its own thread',
    state().compare[0].messages.every((m) => m.threadId === a) &&
      state().compare[1].messages.every((m) => m.threadId === b) &&
      state().compare[0].messages.length > 0 &&
      state().compare[1].messages.length > 0,
    state().compare.map((pane) => pane.messages.map((m) => m.threadId))
  )

  section('carrying on with one side')
  await state().closeCompare(1)
  check('side by side is closed', state().compare === null)
  check('and the side kept is the one open', state().activeThreadId === b, state().activeThreadId)

  section('deleting one side while both are open')
  await state().openCompare([a, b])
  await state().deleteThread(b)
  check('side by side closes', state().compare === null)
  check('leaving the other side open on its own', state().activeThreadId === a, state().activeThreadId)

  section('the next one opens with the same two, without asking')
  await state().openCompare()
  check(
    'the right side has the model chosen last time',
    state().compare[1].model === 'openai/two',
    state().compare[1].model
  )
  check(
    'the left still follows the thread you were in, since none was chosen for it',
    state().compare[0].model === 'google/mid-way',
    state().compare[0].model
  )
  await state().setCompareModel(0, 'anthropic/one')
  check('choosing the left before sending remembers it too', storedSettings.sideBySideLeftModel === 'anthropic/one')

  section('closing before anything was said')
  const madeBefore = made
  await state().closeCompare()
  check('a new chat is opened, since there is nothing to go back to', made === madeBefore + 1)
  check('and it is the open one', state().activeThreadId === `made-${made}`, state().activeThreadId)

  section('chosen from Settings, with side by side closed')
  await state().setCompareModel(1, 'mistral/three')
  check('nothing opens', state().compare === null)
  check('it is remembered', storedSettings.sideBySideRightModel === 'mistral/three', storedSettings)
  await state().openCompare()
  check(
    'and side by side opens with both chosen',
    state().compare[0].model === 'anthropic/one' && state().compare[1].model === 'mistral/three',
    state().compare.map((pane) => pane.model)
  )
})
