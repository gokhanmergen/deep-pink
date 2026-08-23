const { suite } = require('./support/harness')

/**
 * Rich blocks — the reader between a remote model and the window.
 *
 * Everything a block contains arrives from somewhere else, so the parser is the
 * security boundary as much as it is a convenience: what it lets through is
 * drawn, and what it refuses is shown as the code it always was. These check
 * both halves — that a well-formed block survives intact, and that a hostile or
 * broken one comes back null rather than as anything a component would try to
 * render.
 */

const fence = (kind, object) => [`dp-${kind}`, JSON.stringify(object)]

suite('rich blocks — what the model may draw', async ({ check, section, subject }) => {
  const { richBlocks } = subject
  const { parseRichBlock, richKindOf, RICH_LIMITS, RICH_BLOCKS_PROMPT, RICH_BLOCK_KINDS } = richBlocks

  const parse = (kind, object) => parseRichBlock(...fence(kind, object))

  section('which fences are ours')
  check('a known kind is recognised', richKindOf('dp-chart') === 'chart')
  check('the prefix is required', richKindOf('chart') === null)
  check('an unknown kind is not ours', richKindOf('dp-iframe') === null)
  check('a real language is left alone', richKindOf('typescript') === null)
  check(
    'every documented kind parses',
    RICH_BLOCK_KINDS.every((kind) => richKindOf(`dp-${kind}`) === kind)
  )

  section('nothing malformed reaches a component')
  check('half a block, as it streams, is refused', parseRichBlock('dp-chart', '{"chart":"li') === null)
  check('an empty body is refused', parseRichBlock('dp-chart', '') === null)
  check('a JSON array is refused', parseRichBlock('dp-chart', '[1,2,3]') === null)
  check('a string is refused', parseRichBlock('dp-callout', '"hello"') === null)
  check('a chart with no series is refused', parse('chart', { chart: 'line' }) === null)
  check('a table with no rows is refused', parse('table', { columns: ['a'] }) === null)
  check('a callout with no body is refused', parse('callout', { tone: 'danger' }) === null)
  check(
    'a block past the size limit is refused rather than parsed',
    parseRichBlock('dp-chart', 'x'.repeat(RICH_LIMITS.bytes + 1)) === null
  )
  check('an unknown kind never parses', parseRichBlock('dp-script', '{"body":"x"}') === null)

  section('a chart')
  const chart = parse('chart', {
    chart: 'column',
    title: 'Requests',
    unit: 'ms',
    labels: ['Mon', 'Tue'],
    series: [
      { label: 'p50', values: [12, 18] },
      { label: 'p95', values: ['1,200', 900] }
    ]
  })
  check('it keeps its kind, title and unit', chart.block.spec.chart === 'column' &&
    chart.block.spec.title === 'Requests' && chart.block.spec.unit === 'ms')
  check('numbers written as text are read', chart.block.spec.series[1].values[0] === 1200)
  check('an unknown chart kind falls back to a line',
    parse('chart', { chart: 'pie', series: [{ label: 'a', values: [1] }] }).block.spec.chart === 'line')
  check('an unknown unit falls back to plain',
    parse('chart', { unit: 'bananas', series: [{ label: 'a', values: [1] }] }).block.spec.unit === 'plain')

  const many = parse('chart', {
    series: Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, values: [i] }))
  })
  check('the palette is never extended past its slots', many.block.spec.series.length === RICH_LIMITS.series)
  check('and the block says what it dropped', many.notes.some((note) => /series/.test(note)), many.notes)

  const scatter = parse('chart', {
    chart: 'scatter',
    series: Array.from({ length: 5 }, (_, i) => ({
      label: `s${i}`,
      points: [{ x: i, y: i * 2, label: 'p' }]
    }))
  })
  check('a scatter is held to three series', scatter.block.spec.series.length === 3, scatter.notes)
  check('a scatter with no points is refused',
    parse('chart', { chart: 'scatter', series: [{ label: 'a', values: [1, 2] }] }) === null)

  section('part-to-whole folds its tail')
  const share = parse('share', {
    segments: Array.from({ length: 10 }, (_, i) => ({ label: `p${i}`, value: 10 - i }))
  })
  check('six segments at most', share.block.spec.segments.length === RICH_LIMITS.segments)
  check('the last is Other', share.block.spec.segments[5].label === 'Other')
  check(
    'and it holds everything that was folded, so the total still adds up',
    share.block.spec.segments[5].value === 5 + 4 + 3 + 2 + 1 + 0,
    share.block.spec.segments[5]
  )

  section('a table')
  const table = parse('table', {
    columns: ['Route', { key: 'p95', label: 'p95', unit: 'ms' }],
    rows: [['/a', 240], { Route: '/b', p95: 1310 }],
    sortBy: 'p95',
    sort: 'desc'
  })
  check('columns come from strings or objects', table.block.spec.columns.map((c) => c.label).join() === 'Route,p95')
  check('rows come from arrays or objects', table.block.spec.rows[1][0] === '/b' && table.block.spec.rows[1][1] === 1310)
  check('a numeric column is detected and right-aligned',
    table.block.spec.columns[1].numeric === true && table.block.spec.columns[1].align === 'right')
  check('a text column is not', table.block.spec.columns[0].numeric === false)
  check('it opens sorted by the named column', table.block.spec.sortBy === 1 && table.block.spec.sortDescending)

  const wide = parse('table', {
    columns: Array.from({ length: 40 }, (_, i) => `c${i}`),
    rows: [Array.from({ length: 40 }, (_, i) => i)]
  })
  check('columns are capped', wide.block.spec.columns.length === RICH_LIMITS.columns)
  check('and every row is cut to match', wide.block.spec.rows[0].length === RICH_LIMITS.columns)

  const long = parse('table', {
    columns: ['n'],
    rows: Array.from({ length: RICH_LIMITS.rows + 50 }, (_, i) => [i])
  })
  check('rows are capped', long.block.spec.rows.length === RICH_LIMITS.rows)
  check('and the reader is told', long.notes.some((note) => /rows/.test(note)), long.notes)

  section('links inside a block')
  const cards = parse('cards', {
    cards: [
      { title: 'ok', href: 'https://example.com/x' },
      { title: 'script', href: 'javascript:alert(1)' },
      { title: 'file', href: 'file:///etc/passwd' },
      { title: 'data', href: 'data:text/html,<script>alert(1)</script>' },
      { title: 'nonsense', href: 'not a url' }
    ]
  })
  check('https survives', cards.block.spec.cards[0].href === 'https://example.com/x')
  check('javascript: does not', cards.block.spec.cards[1].href === null)
  check('file: does not', cards.block.spec.cards[2].href === null)
  check('data: does not', cards.block.spec.cards[3].href === null)
  check('and neither does something that is not a URL', cards.block.spec.cards[4].href === null)

  section('markup is data, never markup')
  const callout = parse('callout', {
    tone: 'danger',
    title: '<img src=x onerror=alert(1)>',
    body: '<script>alert(1)</script>'
  })
  check('a title carrying a tag is kept as text', callout.block.spec.title === '<img src=x onerror=alert(1)>')
  check('so is a body — it renders as Markdown, which escapes it',
    callout.block.spec.body === '<script>alert(1)</script>')
  check('an unknown tone falls back to a note',
    parse('callout', { tone: 'apocalypse', body: 'x' }).block.spec.tone === 'note')

  section('a tree cannot be made to run away')
  let deep = { label: 'leaf' }
  for (let i = 0; i < 40; i++) deep = { label: `d${i}`, children: [deep] }
  const tree = parse('tree', { nodes: [deep] })

  let depth = 0
  for (let node = tree.block.spec.nodes[0]; node; node = node.children[0]) depth++
  check('nesting stops at the limit', depth <= RICH_LIMITS.treeDepth + 1, depth)

  const wide_tree = parse('tree', {
    nodes: Array.from({ length: RICH_LIMITS.treeNodes + 100 }, (_, i) => ({ label: `f${i}` }))
  })
  check('and so does breadth', wide_tree.block.spec.nodes.length <= RICH_LIMITS.treeNodes)
  check('a node with children is a directory whatever it claims',
    parse('tree', { nodes: [{ label: 'src', kind: 'file', children: [{ label: 'a.ts' }] }] })
      .block.spec.nodes[0].kind === 'dir')

  section('text is bounded, bodies are not truncated to uselessness')
  const shouty = parse('stats', { tiles: [{ label: 'x'.repeat(5000), value: '1' }] })
  check(
    'a label is cut to something a tile can hold',
    shouty.block.spec.tiles[0].label.length <= RICH_LIMITS.text,
    shouty.block.spec.tiles[0].label.length
  )
  const bodyBlock = parse('accordion', { items: [{ title: 't', body: 'y'.repeat(RICH_LIMITS.body + 500) }] })
  check('a Markdown body is cut to its own, larger limit',
    bodyBlock.block.spec.items[0].body.length === RICH_LIMITS.body)
  check('newlines inside a body survive',
    parse('accordion', { items: [{ title: 't', body: 'a\n\nb' }] }).block.spec.items[0].body === 'a\n\nb')

  section('meters and steps')
  const meter = parse('meter', { items: [{ label: 'Disk', value: 40 }, { label: 'No value' }] })
  check('a meter with no maximum is a percentage', meter.block.spec.items[0].max === 100)
  check('an item with no value is dropped, not drawn at zero', meter.block.spec.items.length === 1)
  const steps = parse('steps', { steps: ['First', { title: 'Second', at: 'day 2' }] })
  check('a bare string is a step', steps.block.spec.steps[0].title === 'First')
  check('a date makes it a timeline', steps.block.spec.steps[1].at === 'day 2')

  section('what the model is told')
  check('every kind appears in the prompt',
    RICH_BLOCK_KINDS.every((kind) => RICH_BLOCKS_PROMPT.includes(`dp-${kind}`)))
  // It mentions <script> only to say it is never rendered; what must not appear
  // is an element offered as something the model could write.
  check(
    'no HTML element is offered as an option',
    !/<(div|span|style|img|iframe|table|a|p|h[1-6])[\s>]/i.test(RICH_BLOCKS_PROMPT)
  )
  check('and it says so out loud', /HTML[^.]*never rendered/.test(RICH_BLOCKS_PROMPT))
  check('and it stays small enough to send every turn',
    Math.ceil(RICH_BLOCKS_PROMPT.length / 4) < 1200, Math.ceil(RICH_BLOCKS_PROMPT.length / 4))

  // The examples are the part a model copies, so they have to be valid.
  section('the examples in the prompt parse')
  const examples = [...RICH_BLOCKS_PROMPT.matchAll(/```(dp-[a-z]+)\n([\s\S]*?)```/g)]
  check('there is one per kind', examples.length === RICH_BLOCK_KINDS.length, examples.length)
  for (const [, language, source] of examples) {
    check(`${language} parses`, parseRichBlock(language, source.trim()) !== null, source.trim())
  }
})
