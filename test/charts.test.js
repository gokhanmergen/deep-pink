const { suite } = require('./support/harness')

/**
 * Charts — the reader between a remote model and the window.
 *
 * Everything a chart contains arrives from somewhere else, so the parser is the
 * security boundary as much as it is a convenience: what it lets through is
 * drawn, and what it refuses is shown as the code it always was. These check
 * both halves — that a well-formed chart survives intact, and that a hostile or
 * broken one comes back null rather than as anything a component would try to
 * render.
 */

suite('charts — what the model may draw', async ({ check, section, subject }) => {
  const { charts } = subject
  const { parseChart, isChartFence, CHART_FENCE, CHART_LIMITS, CHARTS_PROMPT } = charts

  const parse = (object) => parseChart(CHART_FENCE, JSON.stringify(object))

  section('which fences are ours')
  check('the chart fence is recognised', isChartFence('dp-chart'))
  check('however it is capitalised', isChartFence('DP-Chart'))
  check('the prefix is required', isChartFence('chart') === false)
  check('a real language is left alone', isChartFence('typescript') === false)
  check('a fence that is not ours never parses', parseChart('json', '{"series":[]}') === null)

  section('nothing malformed reaches a component')
  check('half a chart, as it streams, is refused', parseChart(CHART_FENCE, '{"chart":"li') === null)
  check('an empty body is refused', parseChart(CHART_FENCE, '') === null)
  check('a JSON array is refused', parseChart(CHART_FENCE, '[1,2,3]') === null)
  check('a string is refused', parseChart(CHART_FENCE, '"hello"') === null)
  check('no series at all is refused', parse({ chart: 'line' }) === null)
  check('series with no values is refused', parse({ series: [{ label: 'a' }] }) === null)
  check(
    'a chart past the size limit is refused rather than parsed',
    parseChart(CHART_FENCE, 'x'.repeat(CHART_LIMITS.bytes + 1)) === null
  )

  section('a chart')
  const chart = parse({
    chart: 'column',
    title: 'Requests',
    caption: 'p95 is the one that hurts.',
    unit: 'ms',
    labels: ['Mon', 'Tue'],
    series: [
      { label: 'p50', values: [12, 18] },
      { label: 'p95', values: ['1,200', 900] }
    ]
  })
  check(
    'it keeps its kind, title, caption and unit',
    chart.spec.chart === 'column' &&
      chart.spec.title === 'Requests' &&
      chart.spec.caption === 'p95 is the one that hurts.' &&
      chart.spec.unit === 'ms'
  )
  check('numbers written as text are read', chart.spec.series[1].values[0] === 1200)
  check('labels come through in order', chart.spec.labels.join() === 'Mon,Tue')
  check('nothing is stacked unless it says so', chart.spec.stacked === false)
  check('and stacked means stacked', parse({ stacked: true, series: [{ label: 'a', values: [1] }] }).spec.stacked)

  check(
    'an unknown chart kind falls back to a line',
    parse({ chart: 'pie', series: [{ label: 'a', values: [1] }] }).spec.chart === 'line'
  )
  check(
    'an unknown unit falls back to plain',
    parse({ unit: 'bananas', series: [{ label: 'a', values: [1] }] }).spec.unit === 'plain'
  )
  check(
    'a series with no name still gets one',
    parse({ series: [{ values: [1] }] }).spec.series[0].label === 'Series 1'
  )
  check(
    'a value that is not a number reads as zero rather than breaking the scale',
    parse({ series: [{ label: 'a', values: [1, null, 'nonsense'] }] }).spec.series[0].values.join() === '1,0,0'
  )

  section('the palette is never extended')
  const many = parse({
    series: Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, values: [i] }))
  })
  check('five series at most', many.spec.series.length === CHART_LIMITS.series)
  check('and the chart says what it dropped', many.notes.some((note) => /series/.test(note)), many.notes)

  const points = parse({
    labels: Array.from({ length: CHART_LIMITS.points + 50 }, (_, i) => `l${i}`),
    series: [{ label: 'a', values: Array.from({ length: CHART_LIMITS.points + 50 }, (_, i) => i) }]
  })
  check('points are capped', points.spec.series[0].values.length === CHART_LIMITS.points)
  check('labels with them', points.spec.labels.length === CHART_LIMITS.points)

  section('a scatter')
  const scatter = parse({
    chart: 'scatter',
    xLabel: 'Size',
    yLabel: 'Time',
    series: Array.from({ length: 5 }, (_, i) => ({
      label: `s${i}`,
      points: [{ x: i, y: i * 2, label: 'p' }]
    }))
  })
  check('it keeps its axis names', scatter.spec.xLabel === 'Size' && scatter.spec.yLabel === 'Time')
  check('it is held to three series', scatter.spec.series.length === CHART_LIMITS.scatterSeries, scatter.notes)
  check('and says so', scatter.notes.some((note) => /scatter/.test(note)), scatter.notes)
  check(
    'a scatter with no points is refused',
    parse({ chart: 'scatter', series: [{ label: 'a', values: [1, 2] }] }) === null
  )
  check(
    'a point missing a coordinate is dropped, not plotted at zero',
    parse({
      chart: 'scatter',
      series: [{ label: 'a', points: [{ x: 1, y: 2 }, { x: 3 }, { y: 4 }] }]
    }).spec.series[0].points.length === 1
  )

  section('text is data, never markup')
  const shouty = parse({
    title: '<img src=x onerror=alert(1)>',
    series: [{ label: '<script>alert(1)</script>', values: [1] }]
  })
  check('a title carrying a tag is kept as text', shouty.spec.title === '<img src=x onerror=alert(1)>')
  check('so is a series name — both are rendered as text nodes', shouty.spec.series[0].label === '<script>alert(1)</script>')
  check(
    'a title is cut to something a heading can hold',
    parse({ title: 'x'.repeat(5000), series: [{ label: 'a', values: [1] }] }).spec.title.length ===
      CHART_LIMITS.text
  )
  check(
    'and newlines in a label cannot break the layout',
    parse({ series: [{ label: 'a\n\nb', values: [1] }] }).spec.series[0].label === 'a b'
  )

  section('what the model is told')
  check('it names the fence', CHARTS_PROMPT.includes('dp-chart'))
  check(
    'it names every kind it can draw',
    ['line', 'area', 'bar', 'column', 'scatter'].every((kind) => CHARTS_PROMPT.includes(`"${kind}"`))
  )
  check('no HTML element is offered as an option', !/<(div|span|style|img|iframe|table|a|p|h[1-6])[\s>]/i.test(CHARTS_PROMPT))
  check('and it says HTML is never rendered', /HTML[^.]*never rendered/.test(CHARTS_PROMPT))
  check('it rules out a pie', /no pie/i.test(CHARTS_PROMPT))
  check(
    'and it stays small enough to send every turn',
    Math.ceil(CHARTS_PROMPT.length / 4) < 500,
    Math.ceil(CHARTS_PROMPT.length / 4)
  )

  // The examples are the part a model copies, so they have to be valid.
  section('the examples in the prompt parse')
  const fenced = [...CHARTS_PROMPT.matchAll(/```dp-chart\n([\s\S]*?)```/g)].map(([, body]) => body.trim())
  const inline = [...CHARTS_PROMPT.matchAll(/\{"chart":"scatter".*\}/g)].map((match) => match[0])
  check('there is a fenced example', fenced.length === 1, fenced.length)
  check('and an inline one for the scatter', inline.length === 1, inline.length)
  for (const source of [...fenced, ...inline]) {
    check(`the example parses: ${source.slice(0, 40)}…`, parseChart(CHART_FENCE, source) !== null, source)
  }
})
