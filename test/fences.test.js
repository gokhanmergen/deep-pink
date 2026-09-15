const path = require('node:path')
const { suite } = require('./support/harness')

/**
 * Finding the code in a message without rendering it.
 *
 * This exists so a thread's code can be highlighted before the thread is
 * opened — the highlighter keys what it has worked out on the code itself, so
 * warming it means producing the same strings `react-markdown` will, ahead of
 * time and from the raw markdown.
 *
 * The consequence of getting it wrong is mild and invisible, which is exactly
 * why it is worth checking here: a block whose text comes out a character
 * different is not a bug anybody will ever see, it is simply a block that
 * quietly goes back to being highlighted late.
 *
 * Checked once against the real thing as well — every fenced block in a
 * library of 4,291, compared with what remark produces — which is where the
 * indentation rule below comes from. That check found 110 blocks missed
 * because they sat inside a numbered list, which is how a model writes
 * instructions, and is not a case anybody would have thought to write down.
 */
global.window = { deepPink: { platform: 'linux' } }

suite('fences — the code in a message, before it is rendered', async ({ check, section }) => {
  const { fencedCode } = require(path.join(__dirname, '..', '.test-build', 'store.js'))

  const only = (markdown) => fencedCode(markdown)[0] ?? null

  section('the ordinary case')
  check(
    'a fenced block gives its language and its text',
    JSON.stringify(only('```js\nconst a = 1\n```')) ===
      JSON.stringify({ code: 'const a = 1', lang: 'js' })
  )
  check('a fence with no language is text', only('```\nplain\n```')?.lang === 'text')
  check('tildes fence too', only('~~~py\nx = 1\n~~~')?.code === 'x = 1')
  check(
    'the info string is only its first word',
    only('```ts title="a.ts"\nx\n```')?.lang === 'ts'
  )
  check('two blocks are two blocks', fencedCode('```\na\n```\ntext\n```\nb\n```').length === 2)
  check(
    'and they do not run into each other',
    fencedCode('```\na\n```\ntext\n```\nb\n```')
      .map((b) => b.code)
      .join('|') === 'a|b'
  )

  section('indentation, which is where this gets interesting')
  // The case the real library turned up: a fence inside a numbered list is
  // indented to the item's content column, and the item's indentation comes
  // off the code with it.
  check(
    'a block inside a list item is found, without its list indentation',
    only('1.  **Do this:**\n    ```bash\n    mkdir -p ~/x\n    ```')?.code === 'mkdir -p ~/x'
  )
  check(
    'inner indentation inside such a block is kept',
    only('1.  x\n    ```py\n    def f():\n        return 1\n    ```')?.code ===
      'def f():\n    return 1'
  )
  check(
    'a closing fence may be indented differently from its opening',
    only('  ```\na\n  ```')?.code === 'a'
  )

  section('the awkward ones')
  check('an unclosed fence runs to the end', only('```js\nconst a = 1')?.code === 'const a = 1')
  check('an empty block is an empty block', only('```js\n```')?.code === '')
  check(
    'a longer fence closes a shorter one, but not the reverse',
    only('````\n```\ninner\n```\n````')?.code === '```\ninner\n```'
  )
  // Not "finds nothing": the trailing ``` then opens a fence of its own that
  // never closes, which is what remark makes of it too. What matters is that
  // the prose did not become code.
  check(
    'a backtick in the info string does not open a fence',
    fencedCode('```a`b\nnot code\n```').every((block) => block.code !== 'not code')
  )
  check('nothing in prose with no fences', fencedCode('just words\nand more').length === 0)
  check('nothing in an empty message', fencedCode('').length === 0)
})
