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
  const mcpListeners = []
  let persisted = []

  const thread = {
    id: 't1',
    title: 'Fixture',
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    archived: false,
    config: { disabledPromptSegments: [] }
  }

  // Stand in for the preload bridge, which the store reads at module scope.
  global.window = {
    deepPink: {
      platform: 'linux',
      settings: { get: async () => ({ ui: {}, keybinds: {}, web: {}, compaction: {} }) },
      threads: { list: async () => [thread] },
      messages: { list: async () => persisted },
      models: { list: async () => [] },
      chat: {
        isGenerating: async () => false,
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
  check('the active thread was selected', state().activeThreadId === 't1')

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

  disposeStore()
  check('disposing removes the listeners', chatListeners.length === 0)
})
