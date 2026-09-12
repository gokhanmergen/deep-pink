const path = require('node:path')
const { suite } = require('./support/harness')

/**
 * Telling maths from two dollar signs that happened to be in the same message.
 *
 * `remark-math` pairs `$` with `$`, which means a pasted terminal session —
 * where the prompt itself ends in one — becomes a single enormous equation.
 * Measured against a real library of 546 messages containing a dollar sign:
 * 1,557 runs were real and 105 were not, and the largest of the false ones was
 * 1,183 characters of `dmesg` output handed to KaTeX to typeset.
 *
 * The rule that tells them apart is shape, so these are about shape.
 */
/*
 * The renderer bundle reads `window.deepPink` as it loads — the store takes the
 * bridge at module scope and the keybinds read the platform off it — so there
 * has to be a window before it is required, even for a suite that only wants a
 * pure function out of it. Nothing here calls through the bridge, so the
 * shallowest possible stub is the honest one.
 */
global.window = { deepPink: { platform: 'linux' } }

suite('markdown — what is maths and what is a dollar sign', async ({ check, section }) => {
  const {
    isPlausibleMath,
    remarkOnlyPlausibleMath,
    LONGEST_INLINE_MATH,
    LONGEST_BLOCK_MATH
  } = require(path.join(__dirname, '..', '.test-build', 'store.js'))

  const inline = (value) => ({ type: 'inlineMath', value })
  const block = (value) => ({ type: 'math', value })

  section('what is left alone')
  check('an ordinary inline formula', isPlausibleMath(inline('E = mc^2')))
  check('one with braces and subscripts', isPlausibleMath(inline('\\frac{a_1}{b_2} \\cdot x')))
  check('a display formula', isPlausibleMath(block('\\int_0^1 x^2 dx = \\frac{1}{3}')))
  check(
    'a long one, up to the bound',
    isPlausibleMath(inline('x'.repeat(LONGEST_INLINE_MATH)))
  )
  check(
    'display maths may run over several lines, as it really does',
    isPlausibleMath(block('\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}'))
  )
  check('anything that is not maths at all is not this rule’s business',
    isPlausibleMath({ type: 'text', value: 'x'.repeat(5000) }))

  section('what is put back as text')
  // The shape of every false positive in the real library: shell, over lines.
  check(
    'a shell fragment spanning lines, however short',
    !isPlausibleMath(inline("1 == '--' ]]; then shift; break; fi\n  for ((i=1;i<"))
  )
  check(
    'a terminal session, which is what started this',
    !isPlausibleMath(inline("dmesg | grep -iE 'uas|usb-storage'\n[ 0.000000] Kernel command line:"))
  )
  check(
    'an inline run past the bound',
    !isPlausibleMath(inline('x'.repeat(LONGEST_INLINE_MATH + 1)))
  )
  check(
    'a block run past its own, larger bound',
    !isPlausibleMath(block('x'.repeat(LONGEST_BLOCK_MATH + 1)))
  )

  section('and the tree comes back readable')
  const tree = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'before ' },
          inline('E = mc^2'),
          { type: 'text', value: ' and ' },
          inline('echo hi\nexit 1'),
          { type: 'text', value: ' after' }
        ]
      },
      block('y'.repeat(LONGEST_BLOCK_MATH + 1))
    ]
  }
  remarkOnlyPlausibleMath()(tree)

  const line = tree.children[0].children
  check('the real formula is still a formula', line[1].type === 'inlineMath', line[1])
  check('the shell is text again', line[3].type === 'text', line[3])
  check(
    'and it reads as it was written, dollars included',
    line[3].value === '$echo hi\nexit 1$',
    line[3].value
  )
  check(
    'nothing around it moved',
    line[0].value === 'before ' && line[4].value === ' after',
    line.map((n) => n.type)
  )

  // A `math` node is a block, so what replaces it has to be one too — a bare
  // text node where a paragraph belongs is a tree nothing can render.
  check('an over-long block becomes a paragraph, not a loose string',
    tree.children[1].type === 'paragraph', tree.children[1].type)
  check(
    'carrying the source it was parsed from',
    tree.children[1].children[0].value === `$$${'y'.repeat(LONGEST_BLOCK_MATH + 1)}$$`
  )

  section('the bounds themselves')
  check('inline is bounded to a line’s worth', LONGEST_INLINE_MATH === 160)
  check('and a block to a formula’s worth', LONGEST_BLOCK_MATH === 600)
})
