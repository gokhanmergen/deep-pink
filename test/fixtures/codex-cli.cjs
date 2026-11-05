#!/usr/bin/env node
// Protocol fixture: no login or upstream inference. Tests select edge cases via env.
const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
const mode = process.env.DEEP_PINK_CODEX_TEST_MODE
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const notify = (method, params) => send({ method, params: { threadId: 'test-thread', ...params } })
const complete = () => notify('turn/completed', { turn: { id: 'test-turn', status: 'completed' } })
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  appendFileSync(process.env.DEEP_PINK_CODEX_TEST_LOG, line + '\n')
  const { id, method, params } = message
  if (method === 'initialize') {
    if (mode !== 'hang-initialize') send({ id, result: {} })
  } else if (method === 'thread/start') {
    send({ id, result: { thread: { id: 'test-thread' } } })
  } else if (method === 'turn/start') {
    send({ id, result: { turn: { id: 'test-turn', status: 'inProgress' } } })
    if (mode === 'hang-turn') return
    if (mode === 'failed') {
      notify('turn/completed', { turn: { status: 'failed', error: { message: 'Usage limit reached' } } })
      return
    }
    if (mode === 'dynamic') {
      send({ id: 'tool-request', method: 'item/tool/call', params: { callId: 'dynamic-call', tool: 'load_skill', arguments: { skill: 'charts' } } })
      return
    }
    notify('item/started', { item: { type: 'agentMessage', id: 'comment', phase: 'commentary' } })
    notify('item/agentMessage/delta', { itemId: 'comment', delta: 'Checking sources.' })
    notify('item/completed', { item: { type: 'agentMessage', id: 'comment', phase: 'commentary', text: 'Checking sources.' } })
    notify('item/reasoning/summaryTextDelta', { itemId: 'reason', delta: 'Thinking.' })
    if (mode === 'native') {
      notify('item/started', { item: { type: 'webSearch', id: 'search' } })
      notify('item/completed', { item: { type: 'webSearch', id: 'search', query: 'updated query', action: { type: 'search', queries: ['updated query'] } } })
      notify('item/completed', { item: { type: 'webSearch', id: 'page', action: { type: 'openPage', url: 'https://example.com' } } })
    }
    notify('item/started', { item: { type: 'agentMessage', id: 'answer', phase: 'final_answer' } })
    notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Partial' })
    notify('item/completed', { item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Partial answer.' } })
    notify('item/completed', { item: { type: 'agentMessage', id: 'second', phase: 'final_answer', text: 'Second paragraph.' } })
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, last: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, modelContextWindow: 10000 } })
    complete()
  } else if (method === 'account/usage/read') {
    send({ id, result: { threadUsage: { estimatedUsageUsdMicros: 1200 } } })
  } else if (id === 'tool-request') {
    notify('item/completed', { item: { type: 'agentMessage', id: 'answer', text: message.result.success ? 'Tool succeeded.' : 'Tool failed.' } })
    complete()
  }
})
