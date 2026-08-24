const { suite, settle } = require('./support/harness')

/**
 * Charts, in the window that actually draws them.
 *
 * The parser suite proves what survives validation; this one boots the real app
 * and proves the other half — that a validated chart becomes geometry rather
 * than a stack trace, that its interactive parts work, that the switch turns it
 * back into code, and above all that nothing the model wrote is ever live in
 * the DOM. A model-authored `<script>` has to arrive as eight characters of
 * text.
 */

const chart = (spec) => '```dp-chart\n' + JSON.stringify(spec) + '\n```'

suite(
  'charts — rendered in the app',
  async ({ check, section, subject, getWindow }) => {
    const { getDb, repo } = subject
    getDb()

    // Seeded before the renderer asks for them, exactly as the layout suite does.
    repo.setSetting('settings', { chartsEnabled: true })

    const thread = repo.createThread('Chart fixture')
    repo.insertMessage({ threadId: thread.id, role: 'user', content: 'how did the release go?' })
    repo.insertMessage({
      threadId: thread.id,
      role: 'assistant',
      model: 'test/model',
      content: [
        'Search got slower; everything else held.',
        chart({
          chart: 'column',
          title: 'Latency by route',
          caption: 'p95, over the last hour.',
          unit: 'ms',
          labels: ['/a', '/b', '/c'],
          series: [
            { label: 'p50', values: [12, 18, 9] },
            { label: 'p95', values: [240, 1310, 88] }
          ]
        }),
        // Thirty categories in the width of a message: the bars have to get
        // thinner rather than disappear.
        chart({
          chart: 'column',
          title: 'Crowded',
          labels: Array.from({ length: 30 }, (_, i) => `d${i}`),
          series: [{ label: 'Runs', values: Array.from({ length: 30 }, (_, i) => (i % 7) + 1) }]
        }),
        chart({
          chart: 'line',
          title: 'Requests per day',
          labels: ['Mon', 'Tue', 'Wed'],
          series: [{ label: 'Requests', values: [820, 932, 901] }]
        }),
        chart({
          chart: 'bar',
          title: 'Budget vs actual',
          labels: ['Compile', 'Tests'],
          series: [{ label: 'Over budget by', values: [-400, 900] }]
        }),
        chart({
          chart: 'scatter',
          title: 'Size against build time',
          xLabel: 'Files',
          yLabel: 'Seconds',
          series: [{ label: 'Packages', points: [{ x: 120, y: 3.2, label: 'core' }, { x: 40, y: 1.1 }] }]
        }),
        // A hostile one. Every string in it must land as text — two series, so
        // the legend is drawn and the series name is on screen as well as the
        // title.
        chart({
          title: '<script>window.__pwned = true</script>',
          series: [
            { label: '<img src=x onerror="window.__pwned = true">', values: [1, 2] },
            { label: 'ordinary', values: [2, 1] }
          ]
        }),
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

    section('every chart is drawn')
    const drawn = await run(`(() => ({
      blocks: document.querySelectorAll('.chartblock:not(.chartblock--failed)').length,
      svgs: document.querySelectorAll('.chartblock .viz svg').length,
      paths: document.querySelectorAll('.chartblock .viz svg path').length,
      dots: document.querySelectorAll('.chartblock .viz__dot').length,
      titles: [...document.querySelectorAll('.chartblock__title')].map((el) => el.textContent),
      captions: [...document.querySelectorAll('.chartblock__caption')].map((el) => el.textContent),
      legends: document.querySelectorAll('.chartblock .legend').length,
      codeblocks: document.querySelectorAll('.codeblock').length
    }))()`)

    check('one block per chart', drawn.blocks === 6, drawn)
    check('each one has a plot', drawn.svgs === 6, drawn)
    check('the plots are real geometry, not empty frames', drawn.paths > 40, drawn.paths)
    check('the scatter drew its markers', drawn.dots >= 2, drawn.dots)
    check('titles are shown', drawn.titles.includes('Latency by route'), drawn.titles)
    check('and captions under them', drawn.captions.join().includes('over the last hour'), drawn.captions)
    check('a chart with two series gets a legend', drawn.legends >= 2, drawn.legends)
    check(
      'the malformed chart and the plain fence stayed code',
      drawn.codeblocks === 2,
      drawn.codeblocks
    )
    const failed = await run(`(() => {
      const el = document.querySelector('.chartblock--failed')
      return { count: document.querySelectorAll('.chartblock--failed').length, text: el ? el.textContent : '' }
    })()`)
    check(
      'and the one that should have drawn says why it did not',
      failed.count === 1 && /not valid/.test(failed.text),
      failed
    )

    section('nothing the model wrote is live in the document')
    const injection = await run(`(() => {
      const transcript = document.querySelector('.transcript')
      const hostile = [...document.querySelectorAll('.chartblock')].find((el) =>
        el.textContent.includes('script')
      )
      return {
        pwned: window.__pwned === true,
        scripts: transcript.querySelectorAll('script').length,
        images: transcript.querySelectorAll('.chartblock img').length,
        handlers: transcript.querySelectorAll('.chartblock [onerror], .chartblock [onclick], .chartblock [onload]').length,
        // The tags arrive as characters, in the title and in the legend.
        asText: hostile ? hostile.textContent : ''
      }
    })()`)

    check('no script ran', injection.pwned === false, injection)
    check('no script element exists', injection.scripts === 0, injection)
    check('no image element was created from a chart', injection.images === 0, injection)
    check('no inline handler survived', injection.handlers === 0, injection)
    check(
      'the markup is on screen as the text it is',
      injection.asText.includes('<script>') && injection.asText.includes('onerror'),
      injection.asText
    )

    // The window cannot be screenshotted in a headless sandbox, so geometry is
    // measured instead: a chart that overflows its own box, or draws nothing at
    // all, is what a screenshot would have caught.
    section('nothing overflows the message it is in')
    const geometry = await run(`(() => {
      const out = []
      for (const block of document.querySelectorAll('.chartblock')) {
        const box = block.getBoundingClientRect()
        let left = box.left
        let right = box.right
        for (const child of block.querySelectorAll('*')) {
          const rect = child.getBoundingClientRect()
          // Zero-sized nodes are text wrappers and tooltips that are not shown.
          if (rect.width === 0 && rect.height === 0) continue
          left = Math.min(left, rect.left)
          right = Math.max(right, rect.right)
        }
        out.push({
          overflowLeft: Math.round(box.left - left),
          overflowRight: Math.round(right - box.right),
          height: Math.round(box.height)
        })
      }
      return out
    })()`)

    const overflowing = geometry.filter((entry) => entry.overflowRight > 2 || entry.overflowLeft > 2)
    check('every chart draws inside its own box', overflowing.length === 0, overflowing)
    check('and every one has real height', geometry.every((entry) => entry.height > 24), geometry)

    const bars = await run(`(() => {
      const block = document.querySelector('.chartblock')
      const boxes = [...block.querySelectorAll('.chart-bar')].map((p) => {
        const b = p.getBBox()
        return { w: Math.round(b.width), h: Math.round(b.height) }
      })
      const svg = block.querySelector('.viz svg')
      return { boxes, svg: { w: Math.round(svg.clientWidth), h: Math.round(svg.clientHeight) } }
    })()`)
    check('the chart is drawn at real pixels', bars.svg.w > 200 && bars.svg.h > 100, bars.svg)
    check('there is one mark per value', bars.boxes.length === 6, bars.boxes.length)
    check(
      'a column is capped at 24px thick, never filling its slot',
      bars.boxes.every((box) => box.w > 0 && box.w <= 24),
      bars.boxes
    )

    const crowded = await run(`(() => {
      const block = [...document.querySelectorAll('.chartblock')][1]
      return [...block.querySelectorAll('.chart-bar')].map((p) => Math.round(p.getBBox().width * 10) / 10)
    })()`)
    check('thirty categories all get a bar', crowded.length === 30, crowded.length)
    check('and none of them collapses to nothing', crowded.every((width) => width >= 1), crowded)

    // A bar chart whose values cross zero has to keep its baseline honest.
    const negatives = await run(`(() => {
      const block = [...document.querySelectorAll('.chartblock')][3]
      return {
        bars: block.querySelectorAll('.chart-bar').length,
        baseline: block.querySelectorAll('.viz__crosshair').length
      }
    })()`)
    check('a chart crossing zero draws both bars', negatives.bars === 2, negatives)
    check('and marks the baseline they grow from', negatives.baseline === 1, negatives)

    section('the numbers are always one click away')
    await run(`document.querySelector('.chartblock__source').click()`)
    await settle(300)
    const source = await run(`(() => {
      const block = document.querySelector('.chartblock')
      return { code: block.querySelectorAll('.codeblock').length, svg: block.querySelectorAll('.viz svg').length }
    })()`)
    check('the chart becomes its own JSON', source.code === 1 && source.svg === 0, source)

    section('switching charts off puts the code back')
    await run(`(() => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        (b.getAttribute('title') || '').startsWith('Charts in replies')
      )
      button.click()
    })()`)
    await settle(600)
    const off = await run(`({
      blocks: document.querySelectorAll('.chartblock:not(.chartblock--failed)').length,
      codeblocks: document.querySelectorAll('.codeblock').length
    })`)
    check('no chart is drawn any more', off.blocks === 0, off)
    check('and every one of them is readable as code', off.codeblocks >= 8, off)
  },
  { bootApp: true }
)
