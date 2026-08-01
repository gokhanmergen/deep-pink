const fs = require('node:fs')
const path = require('node:path')
const { suite } = require('./support/harness')

/**
 * ChatGPT stores each conversation as a TREE — every edit or regenerate adds a
 * sibling branch — and `current_node` marks the branch that was on screen. These
 * fixtures mirror the shapes a real export contains.
 */
const t = (n) => 1700000000 + n

function conversation(overrides = {}) {
  return {
    id: 'conv-1',
    conversation_id: 'conv-1',
    title: 'Rust borrow checker',
    create_time: t(0),
    update_time: t(90),
    current_node: 'n4',
    mapping: {
      root: { id: 'root', parent: null, children: ['n0'], message: null },
      // The hidden custom-instructions block ChatGPT injects.
      n0: {
        id: 'n0', parent: 'root', children: ['n1'],
        message: {
          author: { role: 'system' }, create_time: t(1),
          content: { content_type: 'text', parts: ['You are ChatGPT.'] },
          metadata: { is_visually_hidden_from_conversation: true }, recipient: 'all'
        }
      },
      n1: {
        id: 'n1', parent: 'n0', children: ['n2', 'n2b'],
        message: {
          author: { role: 'user' }, create_time: t(10),
          content: { content_type: 'text', parts: ['explain borrowing'] }, recipient: 'all'
        }
      },
      // An abandoned regenerate. It must NOT be imported.
      n2b: {
        id: 'n2b', parent: 'n1', children: [],
        message: {
          author: { role: 'assistant' }, create_time: t(20),
          content: { content_type: 'text', parts: ['DISCARDED BRANCH'] },
          metadata: { model_slug: 'gpt-4' }, recipient: 'all'
        }
      },
      n2: {
        id: 'n2', parent: 'n1', children: ['n3'],
        message: {
          author: { role: 'assistant' }, create_time: t(30),
          content: { content_type: 'text', parts: ['Borrowing is…'] },
          metadata: { model_slug: 'gpt-4o' }, recipient: 'all'
        }
      },
      // A tool call: recipient is the tool, not `all`.
      n3: {
        id: 'n3', parent: 'n2', children: ['n4'],
        message: {
          author: { role: 'assistant' }, create_time: t(40),
          content: { content_type: 'code', text: 'print(1)' }, recipient: 'python'
        }
      },
      n4: {
        id: 'n4', parent: 'n3', children: [],
        message: {
          author: { role: 'user' }, create_time: t(50),
          content: {
            content_type: 'multimodal_text',
            parts: [
              { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-ABC123' },
              'what is this?'
            ]
          },
          recipient: 'all'
        }
      }
    },
    ...overrides
  }
}

suite('import — ChatGPT data export', async ({ check, section, subject, tmpDir }) => {
  const { getDb, repo, chatgpt, importer } = subject
  getDb()

  section('reconstructing the conversation from its tree')
  const report = chatgpt.parseExport([conversation()])
  check('the conversation is read', report.conversations.length === 1, report.skipped)

  const conv = report.conversations[0]
  const roles = conv.messages.map((m) => m.role).join(',')
  const texts = conv.messages.map((m) => m.content)

  check('the title is kept', conv.title === 'Rust borrow checker', conv.title)
  check('timestamps become milliseconds', conv.createdAt === t(0) * 1000, conv.createdAt)
  check('only the visible branch is imported', roles === 'user,assistant,user', roles)
  check('the abandoned regenerate is dropped', !texts.some((c) => c.includes('DISCARDED')), texts)
  check('the hidden system prompt is dropped', report.skipped.hiddenOrSystem === 1, report.skipped)
  check('tool traffic is dropped', report.skipped.toolTraffic === 1, report.skipped)
  check('the model is recorded', conv.messages[1].model === 'gpt-4o', conv.messages[1].model)
  check('multimodal text survives alongside its image', texts[2] === 'what is this?', texts[2])
  check('the image asset is referenced', conv.messages[2].assets[0] === 'file-ABC123', conv.messages[2].assets)

  section('content shapes')
  const code = chatgpt.extractContent({
    content: { content_type: 'code', text: 'x = 1' }
  })
  check('code becomes a fenced block', code.text.includes('```python\nx = 1'), code.text)
  const out = chatgpt.extractContent({
    content: { content_type: 'execution_output', text: '42' }
  })
  check('execution output is fenced', out.text.includes('```\n42'), out.text)
  check(
    'an empty message yields nothing',
    chatgpt.extractContent({ content: { content_type: 'text', parts: [''] } }).text === ''
  )

  section('malformed input is survived, not thrown on')
  check('a non-array file yields nothing', chatgpt.parseExport({ nope: true }).conversations.length === 0)
  check('junk entries are counted', chatgpt.parseExport([null, 5, 'x']).skipped.unreadableConversations === 3)
  check(
    'a conversation with no mapping is skipped',
    chatgpt.parseExport([{ id: 'a' }]).skipped.unreadableConversations === 1
  )
  check('a cyclic mapping terminates', chatgpt.parseExport([{
    id: 'cyc', conversation_id: 'cyc', current_node: 'a',
    mapping: {
      a: { id: 'a', parent: 'b', children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['hi'] }, recipient: 'all' } },
      b: { id: 'b', parent: 'a', children: ['a'], message: null }
    }
  }]).conversations.length === 1)
  const noCurrent = chatgpt.parseExport([{
    id: 'nocur', conversation_id: 'nocur',
    mapping: {
      a: { id: 'a', parent: null, children: ['b'], message: { author: { role: 'user' }, create_time: t(1), content: { content_type: 'text', parts: ['q'] }, recipient: 'all' } },
      b: { id: 'b', parent: 'a', children: [], message: { author: { role: 'assistant' }, create_time: t(2), content: { content_type: 'text', parts: ['a'] }, recipient: 'all' } }
    }
  }])
  check(
    'a missing current_node falls back to the deepest leaf',
    noCurrent.conversations[0]?.messages.map((m) => m.content).join('|') === 'q|a',
    noCurrent.conversations[0]?.messages
  )

  section('asset pointers')
  check('a scheme-prefixed pointer yields the id, not the scheme',
    chatgpt.assetIdFrom('file-service://file-ABC123XYZ') === 'file-ABC123XYZ',
    chatgpt.assetIdFrom('file-service://file-ABC123XYZ'))
  check('an archive filename yields the id',
    chatgpt.assetIdFrom('file-ABC123XYZ-screenshot.png') === 'file-ABC123XYZ')
  check('a bare id is returned unchanged',
    chatgpt.assetIdFrom('file-ABC123XYZ') === 'file-ABC123XYZ')
  check('something with no id yields null', chatgpt.assetIdFrom('notes.txt') === null)

  section('importing into the database')
  const file = path.join(tmpDir, 'conversations.json')
  fs.writeFileSync(file, JSON.stringify([conversation()]))

  const pre = importer.preview(file)
  check('preview counts the conversations', pre.conversations === 1, pre)
  check('preview writes nothing', repo.listThreads().length === 0, repo.listThreads().length)

  const result = importer.importFile(file)
  check('a thread is created', result.threadsCreated === 1, result)
  check('its messages are created', result.messagesCreated === 3, result)

  const threads = repo.listThreads()
  check('the thread is listed', threads.length === 1 && threads[0].title === 'Rust borrow checker')
  check('its timestamps come from the export', threads[0].createdAt === t(0) * 1000, threads[0].createdAt)

  const imported = repo.getMessages(threads[0].id)
  check('messages are in order', imported.map((m) => m.role).join(',') === 'user,assistant,user')
  check(
    'no cost was invented for them',
    imported.every((m) => m.usage === null) && repo.getGlobalStats().costUsd === 0,
    repo.getGlobalStats().costUsd
  )
  check('the image was referenced but is absent from a bare json', result.imagesMissing === 1, result)

  section('re-importing the same export changes nothing')
  const again = importer.importFile(file)
  check('no duplicate threads', again.threadsCreated === 0, again)
  check('still one thread', repo.listThreads().length === 1)
  check('it reports what it skipped', again.alreadyImported === 1, again.alreadyImported)
})
