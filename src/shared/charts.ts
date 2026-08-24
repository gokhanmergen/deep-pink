/**
 * Charts — the one thing a reply can be that Markdown cannot express.
 *
 * Prose, tables, lists and code are Markdown's, and mathematics is KaTeX's.
 * What neither can do is draw a series, so a model that wants to show a shape
 * writes a fenced block of JSON and this app draws it. Deliberately NOT HTML.
 *
 * ## Why not HTML
 *
 * Letting a model emit HTML into a Chromium window means an allowlist, a
 * sanitiser, and being right about both forever — one missed attribute, one
 * `javascript:` URL, one `<style>` that covers the window, and a remote model
 * is driving the app. The trade is a bad one when the same result is available
 * from data: a fenced block of JSON, validated here, drawn by React components
 * that never see a string of markup. Nothing in this path can inject an
 * element, run a script, load a resource, or reach outside the transcript.
 *
 * So: the model chooses the numbers, the app chooses everything else — the
 * colours, the scale, the marks. Everything below is checked, coerced and
 * clamped before it reaches a component, and anything that does not validate
 * falls back to being shown as an ordinary code block, because a malformed
 * chart must never blank a reply.
 *
 * Shared between the two processes on purpose: the main process documents this
 * to the model, the renderer reads it back, and neither can drift from the
 * other because both are looking at this file.
 */

/* ------------------------------------------------------------------ *
 * The language
 * ------------------------------------------------------------------ */

/**
 * The fence a chart is written in.
 *
 * Prefixed so it cannot be confused with a language: ```dp-chart``` is
 * unambiguous, where ```chart``` would hijack somebody's code sample.
 */
export const CHART_FENCE = 'dp-chart'

/**
 * What one chart may contain.
 *
 * Not defensive decoration: a model that miscounts a loop can emit a hundred
 * thousand points, and the window that has to draw them is the user's. Every
 * limit here caps work the renderer can be asked to do, and anything trimmed
 * is reported under the chart rather than silently dropped.
 */
export const CHART_LIMITS = {
  /** One block's JSON. Past this it is data, not a picture of data. */
  bytes: 96 * 1024,
  /** The categorical palette has five slots and is never extended. */
  series: 5,
  /**
   * An all-pairs form: every series has to be told from every other, which
   * colour alone cannot do past three.
   */
  scatterSeries: 3,
  points: 400,
  /** Any single label or title. */
  text: 400,
  caption: 600
} as const

export type ChartUnit = 'plain' | 'usd' | 'percent' | 'bytes' | 'ms' | 'tokens'

const UNITS = new Set<ChartUnit>(['plain', 'usd', 'percent', 'bytes', 'ms', 'tokens'])

export type ChartKind = 'line' | 'area' | 'bar' | 'column' | 'scatter'

const KINDS = new Set<ChartKind>(['line', 'area', 'bar', 'column', 'scatter'])

/* ------------------------------------------------------------------ *
 * What a validated chart looks like
 * ------------------------------------------------------------------ */

export interface ChartPoint {
  x: number
  y: number
  label: string | null
}

export interface ChartSeries {
  label: string
  /** One per label, for everything except scatter. */
  values: number[]
  /** Scatter only. */
  points: ChartPoint[]
}

export interface ChartSpec {
  chart: ChartKind
  title: string | null
  caption: string | null
  labels: string[]
  series: ChartSeries[]
  stacked: boolean
  unit: ChartUnit
  xLabel: string | null
  yLabel: string | null
}

export interface ParsedChart {
  spec: ChartSpec
  /**
   * What had to be trimmed to fit the limits above, in the reader's words. The
   * component shows these under the chart: one quietly missing half its data
   * would be a lie told by the app rather than by the model.
   */
  notes: string[]
}

/* ------------------------------------------------------------------ *
 * Reading one
 * ------------------------------------------------------------------ */

/** Whether a fence language names a chart. */
export function isChartFence(language: string): boolean {
  return language.toLowerCase() === CHART_FENCE
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Text as a label: one line, trimmed, and bounded. */
function text(value: unknown, limit: number = CHART_LIMITS.text): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

function textOrNull(value: unknown, limit: number = CHART_LIMITS.text): string | null {
  return text(value, limit) || null
}

function number(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    // Models write "1,200" and "42%" often enough to be worth reading.
    const parsed = Number(value.replace(/[\s,%$]/g, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/[\s,%$]/g, ''))
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function unit(value: unknown): ChartUnit {
  const named = String(value ?? '').toLowerCase() as ChartUnit
  return UNITS.has(named) ? named : 'plain'
}

/** Caps a list, and says so. */
function capped<T>(items: T[], limit: number, notes: string[], what: string): T[] {
  if (items.length <= limit) return items
  notes.push(`Showing the first ${limit} of ${items.length} ${what}.`)
  return items.slice(0, limit)
}

/**
 * Reads one fenced chart.
 *
 * Returns null for anything that is not a valid chart, and the caller shows the
 * source as a code block instead. Never throws: this runs on every render of
 * every message, including halfway through a stream where the JSON is by
 * definition incomplete.
 */
export function parseChart(language: string, source: string): ParsedChart | null {
  if (!isChartFence(language)) return null
  if (source.length > CHART_LIMITS.bytes) return null

  let json: unknown
  try {
    json = JSON.parse(source)
  } catch {
    return null
  }

  const raw = record(json)
  if (!raw) return null

  const notes: string[] = []

  const kindName = String(raw['chart'] ?? raw['kind'] ?? raw['type'] ?? 'line').toLowerCase()
  const chart = (KINDS.has(kindName as ChartKind) ? kindName : 'line') as ChartKind

  const labels = capped(
    list(raw['labels'] ?? raw['x']).map((value) => text(value, 80)),
    CHART_LIMITS.points,
    notes,
    'labels'
  )

  const series: ChartSeries[] = capped(
    list(raw['series']),
    CHART_LIMITS.series,
    notes,
    'series (the palette has five slots)'
  )
    .map((entry, index) => {
      const record_ = record(entry)
      if (!record_) return null

      const points = list(record_['points'])
        .map((point) => {
          const p = record(point)
          if (!p) return null
          const x = numberOrNull(p['x'])
          const y = numberOrNull(p['y'])
          return x === null || y === null ? null : { x, y, label: textOrNull(p['label'], 80) }
        })
        .filter((point): point is ChartPoint => point !== null)

      return {
        label: text(record_['label'] ?? record_['name'], 80) || `Series ${index + 1}`,
        values: list(record_['values'] ?? record_['data'])
          .map((value) => number(value))
          .slice(0, CHART_LIMITS.points),
        points: points.slice(0, CHART_LIMITS.points)
      }
    })
    .filter((entry): entry is ChartSeries => entry !== null)

  if (!series.length) return null

  if (chart === 'scatter') {
    if (!series.some((entry) => entry.points.length)) return null
    if (series.length > CHART_LIMITS.scatterSeries) {
      notes.push(
        `A scatter is readable to ${CHART_LIMITS.scatterSeries} series; the rest are not drawn.`
      )
      series.length = CHART_LIMITS.scatterSeries
    }
  } else if (!series.some((entry) => entry.values.length)) {
    return null
  }

  return {
    notes,
    spec: {
      chart,
      title: textOrNull(raw['title']),
      caption: textOrNull(raw['caption'], CHART_LIMITS.caption),
      labels,
      series,
      stacked: raw['stacked'] === true,
      unit: unit(raw['unit']),
      xLabel: textOrNull(raw['xLabel'], 80),
      yLabel: textOrNull(raw['yLabel'], 80)
    }
  }
}

/* ------------------------------------------------------------------ *
 * What the model is told
 * ------------------------------------------------------------------ */

/**
 * The system prompt segment, shown verbatim in the prompt inspector.
 *
 * Kept dense on purpose — it is paid for in tokens on every turn of every
 * thread it is switched on for — and it leads with when NOT to draw, because a
 * model handed a chart will otherwise plot two numbers.
 */
export const CHARTS_PROMPT = `# Charts

This client draws charts. Write one as a fenced \`dp-chart\` block whose body is a single JSON object; the app validates it and renders it. HTML and <script> are never rendered, so do not emit them.

Draw only when the shape of the numbers is the point — a trend, a comparison across categories, a relationship between two measures. Two or three numbers are a sentence; a handful of labelled figures is a Markdown table. Never open an answer with a chart, and never draw the same data twice.

\`\`\`dp-chart
{"chart":"line","title":"Requests per day","labels":["Mon","Tue","Wed"],"series":[{"label":"OK","values":[820,932,901]},{"label":"Errors","values":[12,9,31]}]}
\`\`\`

- "chart": "line" | "area" (a trend over ordered labels) | "bar" (horizontal, for long category names or many categories) | "column" (vertical) | "scatter" (two measures against each other).
- "labels": one per position, shared by every series. "series": up to five, each {"label", "values"} in label order.
- Scatter takes points rather than values, and names its axes: {"chart":"scatter","xLabel":"Size","yLabel":"Build time","series":[{"label":"Packages","points":[{"x":120,"y":3.2,"label":"core"}]}]}. Three series at most.
- Optional on any chart: "caption" (a sentence under it), "unit" ("plain" | "usd" | "percent" | "bytes" | "ms" | "tokens" — the app formats every number by it), "stacked": true for bar and column.
- The app owns the colours, the scale, the legend and the tooltip. Do not ask for a colour, and do not write your own axis or legend into the labels.
- There is no pie or donut. For part-to-whole use a stacked bar with one label, or say the percentages in prose.

State the finding in a sentence next to the chart. A chart nobody has been told what to look for is decoration.`
