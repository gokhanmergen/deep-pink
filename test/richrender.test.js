const { suite, settle } = require('./support/harness')

/**
 * Rich blocks, in the window that actually draws them.
 *
 * The parser suite proves what survives validation; this one boots the real app
 * and proves the other half — that a validated block becomes a chart rather
 * than a stack trace, that its interactive parts work, that the switch turns it
 * back into code, and above all that nothing the model wrote is ever live in
 * the DOM. A model-authored `<script>` has to arrive as five characters of
 * text.
 */

const block = (kind, spec) => '```dp-' + kind + '\n' + JSON.stringify(spec) + '\n```'

suite(
  'rich blocks — rendered in the app',
  async ({ check, section, subject, getWindow }) => {
    const { getDb, repo } = subject
    getDb()

    // Seeded before the renderer asks for them, exactly as the layout suite does.
    repo.setSetting('settings', { richBlocksEnabled: true })

    const thread = repo.createThread('Rich fixture')
    repo.insertMessage({ threadId: thread.id, role: 'user', content: 'show me everything' })
    repo.insertMessage({
      threadId: thread.id,
      role: 'assistant',
      model: 'test/model',
      content: [
        'Here is the shape of it.',
        block('chart', {
          chart: 'column',
          title: 'Latency by route',
          unit: 'ms',
          labels: ['/a', '/b', '/c'],
          series: [
            { label: 'p50', values: [12, 18, 9] },
            { label: 'p95', values: [240, 1310, 88] }
          ]
        }),
        // Thirty categories in the width of a message: the bars have to get
        // thinner rather than disappear.
        block('chart', {
          chart: 'column',
          title: 'Crowded',
          labels: Array.from({ length: 30 }, (_, i) => `d${i}`),
          series: [{ label: 'Runs', values: Array.from({ length: 30 }, (_, i) => (i % 7) + 1) }]
        }),
        block('chart', {
          chart: 'line',
          title: 'Over time',
          labels: ['Mon', 'Tue', 'Wed'],
          series: [{ label: 'Requests', values: [820, 932, 901] }]
        }),
        block('share', {
          title: 'Where the time went',
          unit: 'ms',
          segments: [
            { label: 'Compile', value: 4200 },
            { label: 'Tests', value: 9100 }
          ]
        }),
        block('stats', {
          tiles: [{ label: 'Uptime', value: '99.95%', sub: 'last 30 days', delta: 0.4, trend: [3, 5, 4, 6, 9] }]
        }),
        block('meter', { items: [{ label: 'Disk', value: 40, max: 100 }] }),
        block('table', {
          title: 'Endpoints',
          columns: ['Route', { key: 'p95', label: 'p95', unit: 'ms' }],
          rows: [
            ['/zebra', 240],
            ['/apple', 1310]
          ]
        }),
        block('tabs', {
          tabs: [
            { label: 'npm', body: 'THE NPM PANEL' },
            { label: 'pnpm', body: 'THE PNPM PANEL' }
          ]
        }),
        block('accordion', { items: [{ title: 'Why?', body: 'Because.', open: true }] }),
        block('steps', { steps: [{ title: 'Install' }, { title: 'Configure', at: 'day 2' }] }),
        block('callout', {
          tone: 'danger',
          title: 'Careful',
          // What a hostile block would carry. It must land as text.
          body: '<script>window.__pwned = true</script><img src=x onerror="window.__pwned = true">'
        }),
        block('cards', {
          cards: [
            { title: 'Safe link', href: 'https://example.com/docs' },
            { title: 'Nasty link', href: 'javascript:window.__pwned = true' }
          ]
        }),
        block('tree', { nodes: [{ label: 'src', children: [{ label: 'index.ts', note: 'entry' }] }] }),
        // Broken on purpose: it has to stay readable as the code it is.
        '```dp-chart\n{"chart":"line","series":[  \n```',
        'And a plain fence, which must not be touched:',
        '```json\n{"chart":"line"}\n```'
      ].join('\n\n')
    })

    const win = getWindow()
    check('the window exists', Boolean(win))
    if (!win) return

    await settle(6000)
    const run = (js) => win.webContents.executeJavaScript(js)

    section('every block is drawn')
    const kinds = await run(`(() => {
      const found = {}
      for (const el of document.querySelectorAll('.rb')) {
        found[el.dataset.kind] = (found[el.dataset.kind] || 0) + 1
      }
      return {
        found,
        codeblocks: document.querySelectorAll('.codeblock').length,
        chartSvgPaths: document.querySelectorAll('.rb[data-kind="chart"] svg path').length
      }
    })()`)

    for (const kind of ['chart', 'share', 'stats', 'meter', 'table', 'tabs', 'accordion', 'steps', 'callout', 'cards', 'tree']) {
      check(`${kind} rendered`, (kinds.found[kind] ?? 0) > 0, kinds.found)
    }
    check('all three charts are drawn', kinds.found.chart === 3, kinds.found)
    check('a chart is real geometry, not an empty frame', kinds.chartSvgPaths > 4, kinds.chartSvgPaths)
    check(
      'the malformed block and the plain fence stayed code',
      kinds.codeblocks === 2,
      kinds.codeblocks
    )
    const failed = await run(`(() => {
      const el = document.querySelector('.rb-failed')
      return { count: document.querySelectorAll('.rb-failed').length, text: el ? el.textContent : '' }
    })()`)
    check(
      'and the one that should have drawn says why it did not',
      failed.count === 1 && /not valid/.test(failed.text),
      failed
    )

    section('nothing the model wrote is live in the document')
    const injection = await run(`(() => {
      const transcript = document.querySelector('.transcript')
      return {
        pwned: window.__pwned === true,
        scripts: transcript.querySelectorAll('script').length,
        images: transcript.querySelectorAll('.rb img').length,
        handlers: transcript.querySelectorAll('.rb [onerror], .rb [onclick], .rb [onload]').length,
        // The tags arrive as characters — the callout says so on screen.
        asText: transcript.querySelector('.rb[data-kind="callout"] .rb-callout__body').textContent
      }
    })()`)

    check('no script ran', injection.pwned === false, injection)
    check('no script element exists', injection.scripts === 0, injection)
    check('no image element was created from a block', injection.images === 0, injection)
    check('no inline handler survived', injection.handlers === 0, injection)
    check(
      'the markup is on screen as the text it is',
      injection.asText.includes('<script>') && injection.asText.includes('onerror'),
      injection.asText
    )

    const links = await run(`(() => {
      const anchors = [...document.querySelectorAll('.rb[data-kind="cards"] a')]
      return { count: anchors.length, hrefs: anchors.map((a) => a.getAttribute('href')) }
    })()`)
    check('the http link is offered', links.hrefs.includes('https://example.com/docs'), links)
    check(
      'and the javascript: one is not an anchor at all',
      links.count === 1 && !links.hrefs.some((href) => href.startsWith('javascript:')),
      links
    )

    section('the parts that move, move')
    const tabs = await run(`(() => {
      const strip = document.querySelector('.rb[data-kind="tabs"] .rb-tabs__strip')
      const panel = document.querySelector('.rb[data-kind="tabs"] .rb-tabs__panel')
      const before = panel.textContent.trim()
      strip.querySelectorAll('button')[1].click()
      return { before, tabCount: strip.querySelectorAll('button').length }
    })()`)
    await settle(200)
    const afterTab = await run(
      `document.querySelector('.rb[data-kind="tabs"] .rb-tabs__panel').textContent.trim()`
    )
    check('a tab strip has one button per tab', tabs.tabCount === 2, tabs)
    check('the first panel is shown to start with', tabs.before === 'THE NPM PANEL', tabs)
    check('and clicking the second shows it instead', afterTab === 'THE PNPM PANEL', afterTab)

    const sorted = await run(`(() => {
      const table = document.querySelector('.rb[data-kind="table"] .rb-table')
      const column = (i) => [...table.querySelectorAll('tbody tr')].map((tr) => tr.children[i].textContent)
      const before = column(0)
      table.querySelectorAll('thead .rb-table__sort')[0].click()
      return { before }
    })()`)
    await settle(200)
    const afterSort = await run(
      `[...document.querySelectorAll('.rb[data-kind="table"] tbody tr')].map((tr) => tr.children[0].textContent)`
    )
    check('the table starts in the order it was written', sorted.before.join() === '/zebra,/apple', sorted)
    check('and sorts when its header is clicked', afterSort.join() === '/apple,/zebra', afterSort)
    const formatted = await run(
      `document.querySelector('.rb[data-kind="table"] tbody tr td[data-numeric="true"]').textContent`
    )
    check('a column with a unit is formatted by the app', /ms|s$/.test(formatted), formatted)

    // The window cannot be screenshotted in a headless sandbox, so geometry is
    // measured instead: a block that overflows its own box, or draws nothing at
    // all, is what a screenshot would have caught.
    section('nothing overflows the message it is in')
    const geometry = await run(`(() => {
      const out = []
      for (const rb of document.querySelectorAll('.rb')) {
        const box = rb.getBoundingClientRect()
        let left = box.left
        let right = box.right
        for (const child of rb.querySelectorAll('*')) {
          const rect = child.getBoundingClientRect()
          // Zero-sized nodes are text wrappers and tooltips that are not shown.
          if (rect.width === 0 && rect.height === 0) continue
          left = Math.min(left, rect.left)
          right = Math.max(right, rect.right)
        }
        out.push({
          kind: rb.dataset.kind,
          overflowLeft: Math.round(box.left - left),
          overflowRight: Math.round(right - box.right),
          height: Math.round(box.height)
        })
      }
      return out
    })()`)

    const overflowing = geometry.filter((entry) => entry.overflowRight > 2 || entry.overflowLeft > 2)
    check('every block draws inside its own box', overflowing.length === 0, overflowing)
    check('and every block has real height', geometry.every((entry) => entry.height > 24), geometry)

    const bars = await run(`(() => {
      const chart = document.querySelector('.rb[data-kind="chart"]')
      const boxes = [...chart.querySelectorAll('.rb-bar')].map((p) => {
        const b = p.getBBox()
        return { w: Math.round(b.width), h: Math.round(b.height) }
      })
      const svg = chart.querySelector('.viz svg')
      return { boxes, svg: { w: Math.round(svg.clientWidth), h: Math.round(svg.clientHeight) } }
    })()`)
    check('the chart is drawn at real pixels', bars.svg.w > 200 && bars.svg.h > 100, bars.svg)
    check('there is one mark per value', bars.boxes.length === 6, bars.boxes.length)

    const crowded = await run(`(() => {
      const svg = [...document.querySelectorAll('.rb[data-kind="chart"]')][1]
      return [...svg.querySelectorAll('.rb-bar')].map((p) => Math.round(p.getBBox().width * 10) / 10)
    })()`)
    check('thirty categories all get a bar', crowded.length === 30, crowded.length)
    check(
      'and none of them collapses to nothing',
      crowded.every((width) => width >= 1),
      crowded
    )
    check(
      'a column is capped at 24px thick, never filling its slot',
      bars.boxes.every((box) => box.w > 0 && box.w <= 24),
      bars.boxes
    )

    section('the source is always one click away')
    await run(`document.querySelector('.rb[data-kind="chart"] .rb__source').click()`)
    await settle(300)
    const source = await run(`(() => {
      const rb = document.querySelector('.rb[data-kind="chart"]')
      // Scoped to the plot: the source switch is an icon, and icons are SVG too.
      return { code: rb.querySelectorAll('.codeblock').length, svg: rb.querySelectorAll('.viz svg').length }
    })()`)
    check('the block becomes its own JSON', source.code === 1 && source.svg === 0, source)

    section('switching rich blocks off puts the code back')
    await run(`(() => {
      const button = [...document.querySelectorAll('.composer button, .comp button, button')]
        .find((b) => (b.getAttribute('title') || '').startsWith('Charts, tables and panels'))
      button.click()
    })()`)
    await settle(600)
    const off = await run(`({
      blocks: document.querySelectorAll('.rb').length,
      codeblocks: document.querySelectorAll('.codeblock').length
    })`)
    check('no block is drawn any more', off.blocks === 0, off)
    check('and every one of them is readable as code', off.codeblocks >= 13, off)
  },
  { bootApp: true }
)
