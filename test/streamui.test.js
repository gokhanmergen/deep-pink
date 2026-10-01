const { suite, settle, openThread } = require('./support/harness')

suite('reply rendering — streamed text and resize updates stay bounded', async ({ check, section, subject, getWindow }) => {
  const { repo } = subject
  repo.setSetting('settings', {
    titleGenerationEnabled: false,
    keyPointEnabled: false,
    hideExperimental: false
  })
  const thread = repo.createThread('Stream rendering fixture', { model: 'test/model' })
  repo.insertMessage({ threadId: thread.id, role: 'user', content: 'Explain the result.' })
  const assistant = repo.insertMessage({ threadId: thread.id, role: 'assistant', content: '', status: 'streaming' })
  const other = repo.createThread('Stream rendering detour')
  repo.insertMessage({ threadId: other.id, role: 'user', content: 'detour' })
  // Seed every sidebar fixture before the renderer loads its thread list.
  // Repository writes alone do not notify the running renderer of a new thread.
  const toolThread = repo.createThread('Tool cursor fixture', { model: 'test/model' })
  repo.insertMessage({ threadId: toolThread.id, role: 'user', content: 'Look up the result.' })
  const call = { id: 'cursor-search', name: 'web_search', arguments: '{"query":"result"}' }
  repo.insertMessage({ threadId: toolThread.id, role: 'assistant', content: 'Let me check.',
    toolCalls: [call], status: 'complete' })
  repo.insertMessage({ threadId: toolThread.id, role: 'tool', content: 'Found the result.',
    toolResult: { toolCallId: call.id, name: call.name, content: 'Found the result.',
      isError: false, durationMs: 12 } })
  const continuation = repo.insertMessage({ threadId: toolThread.id, role: 'assistant',
    content: '', status: 'streaming' })
  const win = getWindow()
  check('the window exists', Boolean(win))
  if (!win) return
  await settle(6000)
  check('the fixture opens', await openThread(win, 'Stream rendering fixture'))
  const run = (js) => win.webContents.executeJavaScript(js)
  await run(`window.__streamRenderingErrors = [];
    window.addEventListener('error', (event) => window.__streamRenderingErrors.push(event.message));
    window.addEventListener('unhandledrejection', (event) => window.__streamRenderingErrors.push(String(event.reason))); true`)

  section('reasoning, paragraphs and partial code arrive together')
  win.webContents.send('chat:event', { type: 'start', threadId: thread.id, messageId: assistant.id })
  let content = ''
  let reasoning = ''
  for (let i = 0; i < 80; i++) {
    const thought = 'Checking the result. '
    const text = `Paragraph ${i}: the result remains readable as the reply grows.\n\n`
    reasoning += thought
    content += text
    win.webContents.send('chat:event', { type: 'reasoning', messageId: assistant.id, delta: thought })
    win.webContents.send('chat:event', { type: 'content', messageId: assistant.id, delta: text })
    await settle(20)
  }
  const code = '```js\nconst result = 42\n```\n'
  for (const delta of ['```js\n', 'const result = ', '42\n', '```\n']) {
    win.webContents.send('chat:event', { type: 'content', messageId: assistant.id, delta })
    await settle(60)
  }
  content += code
  repo.updateMessage(assistant.id, { content, reasoning, status: 'complete' })
  win.webContents.send('chat:event', {
    type: 'done', messageId: assistant.id, message: repo.getMessage(assistant.id)
  })
  await settle(800)

  section('the completed reply is marked and resized')
  repo.setKeyPoints(assistant.id, ['Paragraph 79: the result remains readable as the reply grows.'])
  // Opening another thread and returning reads the mark the main process saved.
  check('the detour opens', await openThread(win, 'Stream rendering detour'))
  check('the completed fixture reopens', await openThread(win, 'Stream rendering fixture'))
  check('the saved key point is drawn', await run(`!!document.querySelector('.ink__stroke')`))
  const [width, height] = win.getSize()
  for (let i = 0; i < 12; i++) {
    win.setSize(width + (i % 2) * 20, height)
    await settle(60)
  }
  win.setSize(width, height)
  await settle(800)
  const errors = await run('window.__streamRenderingErrors')
  check('no repeated-update error appears while streaming or resizing',
    !errors.some((error) => /Maximum update depth|Minified React error #185/.test(error)), errors)
  check('the final streamed paragraph remains on screen', await run(`document.body.textContent.includes('Paragraph 79:')`))
  check('the composer is still usable', await run(`(() => {
    const input = document.querySelector('.composer textarea')
    input?.focus()
    return !!input && document.activeElement === input
  })()`))

  section('a tool round shares one cursor with its empty continuation')
  const opened = await openThread(win, 'Tool cursor fixture')
  check('the tool fixture opens', opened)
  if (!opened) return
  const checkCursors = async (name, expected) => {
    const count = await run(`document.querySelectorAll('.transcript .caret').length`)
    check(name, count === expected, count)
  }
  await checkCursors('earlier text and an empty continuation show one cursor', 1)
  win.webContents.send('chat:event', { type: 'start', threadId: toolThread.id, messageId: continuation.id })
  win.webContents.send('chat:event', { type: 'reasoning', messageId: continuation.id, delta: 'Checking the source.' })
  await settle(200)
  await checkCursors('reasoning after the tool still shows one cursor', 1)
  win.webContents.send('chat:event', { type: 'content', messageId: continuation.id, delta: 'Here is the result.' })
  await settle(200)
  await checkCursors('the resumed reply keeps one cursor', 1)
  repo.updateMessage(continuation.id, { content: 'Here is the result.', reasoning: 'Checking the source.', status: 'complete' })
  win.webContents.send('chat:event', { type: 'done', messageId: continuation.id, message: repo.getMessage(continuation.id) })
  await settle(200)
  await checkCursors('finishing removes the cursor', 0)

  const cancelled = repo.insertMessage({ threadId: toolThread.id, role: 'assistant', content: '', status: 'streaming' })
  win.webContents.send('chat:event', { type: 'start', threadId: toolThread.id, messageId: cancelled.id })
  await settle(300)
  await checkCursors('a new continuation starts with one cursor', 1)
  repo.deleteMessage(cancelled.id)
  win.webContents.send('chat:event', { type: 'aborted', threadId: toolThread.id, messageId: cancelled.id })
  await settle(200)
  await checkCursors('stopping removes the cursor too', 0)
}, { bootApp: true })
