/**
 * Rich blocks — structured output the model can draw with.
 *
 * Markdown covers prose, tables and code, and KaTeX covers mathematics. What is
 * left over is everything with a shape: a series over time, a part of a whole,
 * a comparison, a set of panels the reader picks between. This file is the
 * language for those, and it is deliberately NOT HTML.
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
 * So: the model writes data, the app owns the rendering. Everything below is
 * checked, coerced and clamped before it reaches a component, and anything that
 * does not validate falls back to being shown as an ordinary code block — a
 * malformed chart must never blank a reply.
 *
 * Shared between the two processes on purpose: the main process documents this
 * language to the model, the renderer reads it back, and neither can drift from
 * the other because both are looking at this file.
 */

/* ------------------------------------------------------------------ *
 * The language
 * ------------------------------------------------------------------ */

export const RICH_BLOCK_KINDS = [
  'chart',
  'share',
  'stats',
  'meter',
  'table',
  'tabs',
  'accordion',
  'steps',
  'callout',
  'cards',
  'tree'
] as const

export type RichBlockKind = (typeof RICH_BLOCK_KINDS)[number]

/**
 * Fences are prefixed so they cannot be confused with a language.
 * ```dp-chart``` is unambiguous; ```table``` would hijack anyone's code sample.
 */
export const RICH_FENCE_PREFIX = 'dp-'

/**
 * What a block may contain.
 *
 * Not defensive decoration: a model that miscounts a loop can emit a hundred
 * thousand points, and the window that has to draw them is the user's. Every
 * limit here is a cap on work the renderer can be asked to do, and anything
 * trimmed is reported in the block's footer rather than silently dropped.
 */
export const RICH_LIMITS = {
  /** One block's JSON. Past this it is data, not a picture of data. */
  bytes: 96 * 1024,
  /** The categorical palette has five slots and is never extended. */
  series: 5,
  points: 400,
  rows: 250,
  columns: 24,
  /** Tabs, cards, steps, tiles, meters, accordion sections. */
  items: 40,
  /** Part-to-whole stays readable to about here; the tail folds into "Other". */
  segments: 6,
  treeNodes: 400,
  treeDepth: 8,
  /** Any single label or title. Bodies are Markdown and may be longer. */
  text: 400,
  body: 20_000
} as const

export type RichUnit = 'plain' | 'usd' | 'percent' | 'bytes' | 'ms' | 'tokens'

const UNITS = new Set<RichUnit>(['plain', 'usd', 'percent', 'bytes', 'ms', 'tokens'])

export type CalloutTone = 'note' | 'tip' | 'success' | 'warning' | 'danger'

const TONES = new Set<CalloutTone>(['note', 'tip', 'success', 'warning', 'danger'])

export type ChartKind = 'line' | 'area' | 'bar' | 'column' | 'scatter'

const CHART_KINDS = new Set<ChartKind>(['line', 'area', 'bar', 'column', 'scatter'])

export type Align = 'left' | 'right' | 'center'

/* ------------------------------------------------------------------ *
 * What a validated block looks like
 * ------------------------------------------------------------------ */

export interface ChartPoint {
  x: number
  y: number
  label: string | null
}

export interface ChartSeriesSpec {
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
  series: ChartSeriesSpec[]
  stacked: boolean
  unit: RichUnit
  xLabel: string | null
  yLabel: string | null
}

export interface ShareSpec {
  title: string | null
  caption: string | null
  unit: RichUnit
  segments: { label: string; value: number }[]
}

export interface StatsSpec {
  title: string | null
  tiles: {
    label: string
    value: string
    sub: string | null
    /** Signed change, drawn as a direction and read out in words. */
    delta: number | null
    deltaUnit: RichUnit
    /** A small line behind the number. Shape only — never labelled. */
    trend: number[]
  }[]
}

export interface MeterSpec {
  title: string | null
  caption: string | null
  unit: RichUnit
  items: { label: string; value: number; max: number; sub: string | null }[]
}

export interface TableSpec {
  title: string | null
  caption: string | null
  columns: { key: string; label: string; align: Align; unit: RichUnit; numeric: boolean }[]
  rows: (string | number | null)[][]
  sortable: boolean
  /** Column index the table opens sorted by, or null for source order. */
  sortBy: number | null
  sortDescending: boolean
}

export interface TabsSpec {
  tabs: { label: string; body: string }[]
}

export interface AccordionSpec {
  title: string | null
  items: { title: string; body: string; open: boolean }[]
}

export interface StepsSpec {
  title: string | null
  /** Numbered when nothing is dated, and read as a timeline when they are. */
  steps: { title: string; body: string; at: string | null }[]
}

export interface CalloutSpec {
  tone: CalloutTone
  title: string | null
  body: string
}

export interface CardsSpec {
  title: string | null
  columns: number
  cards: { title: string; body: string; meta: string | null; href: string | null }[]
}

export interface TreeNode {
  label: string
  kind: 'dir' | 'file'
  note: string | null
  children: TreeNode[]
}

export interface TreeSpec {
  title: string | null
  caption: string | null
  nodes: TreeNode[]
}

export type RichSpec =
  | { kind: 'chart'; spec: ChartSpec }
  | { kind: 'share'; spec: ShareSpec }
  | { kind: 'stats'; spec: StatsSpec }
  | { kind: 'meter'; spec: MeterSpec }
  | { kind: 'table'; spec: TableSpec }
  | { kind: 'tabs'; spec: TabsSpec }
  | { kind: 'accordion'; spec: AccordionSpec }
  | { kind: 'steps'; spec: StepsSpec }
  | { kind: 'callout'; spec: CalloutSpec }
  | { kind: 'cards'; spec: CardsSpec }
  | { kind: 'tree'; spec: TreeSpec }

export interface ParsedRichBlock {
  block: RichSpec
  /**
   * What had to be trimmed to fit the limits above, in the reader's words. The
   * component shows these under the block: a chart quietly missing half its
   * data would be a lie told by the app rather than by the model.
   */
  notes: string[]
}

/* ------------------------------------------------------------------ *
 * Reading one
 * ------------------------------------------------------------------ */

/** The kind a fence names, or null if it is not one of ours. */
export function richKindOf(language: string): RichBlockKind | null {
  if (!language.startsWith(RICH_FENCE_PREFIX)) return null
  const rest = language.slice(RICH_FENCE_PREFIX.length).toLowerCase()
  return (RICH_BLOCK_KINDS as readonly string[]).includes(rest) ? (rest as RichBlockKind) : null
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
function text(value: unknown, limit: number = RICH_LIMITS.text): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

function textOrNull(value: unknown, limit: number = RICH_LIMITS.text): string | null {
  const cleaned = text(value, limit)
  return cleaned || null
}

/** A Markdown body: newlines kept, length bounded. */
function body(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, RICH_LIMITS.body) : ''
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

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function unit(value: unknown): RichUnit {
  const named = String(value ?? '').toLowerCase() as RichUnit
  return UNITS.has(named) ? named : 'plain'
}

/**
 * Only what can be opened safely.
 *
 * Links inside a block go through the same door as links in prose — the main
 * process opens http and https in the desktop browser and refuses everything
 * else — but a scheme is checked here as well, so a `javascript:` or `file:`
 * URL never even reaches a component as an href.
 */
function href(value: unknown): string | null {
  const raw = text(value, 2000)
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** Caps a list, and says so. */
function capped<T>(items: T[], limit: number, notes: string[], what: string): T[] {
  if (items.length <= limit) return items
  notes.push(`Showing the first ${limit} of ${items.length} ${what}.`)
  return items.slice(0, limit)
}

function parseChart(raw: Record<string, unknown>, notes: string[]): ChartSpec | null {
  const kindName = String(raw['chart'] ?? raw['kind'] ?? raw['type'] ?? 'line').toLowerCase()
  const chart = (CHART_KINDS.has(kindName as ChartKind) ? kindName : 'line') as ChartKind

  const labels = capped(
    list(raw['labels'] ?? raw['x']).map((value) => text(value, 80)),
    RICH_LIMITS.points,
    notes,
    'labels'
  )

  const rawSeries = list(raw['series'])
  const series: ChartSeriesSpec[] = capped(
    rawSeries,
    RICH_LIMITS.series,
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
        values: list(record_['values'] ?? record_['data']).map((value) => number(value)),
        points
      }
    })
    .filter((entry): entry is ChartSeriesSpec => entry !== null)
    .map((entry) => ({
      ...entry,
      values: entry.values.slice(0, RICH_LIMITS.points),
      points: entry.points.slice(0, RICH_LIMITS.points)
    }))

  if (!series.length) return null

  if (chart === 'scatter') {
    if (!series.some((entry) => entry.points.length)) return null
    // An all-pairs form: every series has to be told from every other, which
    // colour alone cannot do past three.
    if (series.length > 3) {
      notes.push('A scatter is readable to three series; the rest are not drawn.')
      series.length = 3
    }
  } else if (!series.some((entry) => entry.values.length)) {
    return null
  }

  return {
    chart,
    title: textOrNull(raw['title']),
    caption: textOrNull(raw['caption'], 600),
    labels,
    series,
    stacked: bool(raw['stacked']),
    unit: unit(raw['unit']),
    xLabel: textOrNull(raw['xLabel'], 80),
    yLabel: textOrNull(raw['yLabel'], 80)
  }
}

function parseShare(raw: Record<string, unknown>, notes: string[]): ShareSpec | null {
  const all = list(raw['segments'] ?? raw['parts'] ?? raw['data'])
    .map((entry) => {
      const record_ = record(entry)
      if (!record_) return null
      const value = numberOrNull(record_['value'])
      const label = text(record_['label'] ?? record_['name'], 80)
      return value === null || !label ? null : { label, value: Math.max(value, 0) }
    })
    .filter((entry): entry is { label: string; value: number } => entry !== null)

  if (!all.length) return null

  // Past six the segments are thinner than their labels. The tail becomes one
  // "Other", which is honest: the total still adds up.
  let segments = all
  if (all.length > RICH_LIMITS.segments) {
    const keep = all.slice(0, RICH_LIMITS.segments - 1)
    const rest = all.slice(RICH_LIMITS.segments - 1)
    segments = [...keep, { label: 'Other', value: rest.reduce((sum, e) => sum + e.value, 0) }]
    notes.push(`${rest.length} smaller segments are folded into “Other”.`)
  }

  return {
    title: textOrNull(raw['title']),
    caption: textOrNull(raw['caption'], 600),
    unit: unit(raw['unit']),
    segments
  }
}

function parseStats(raw: Record<string, unknown>, notes: string[]): StatsSpec | null {
  const tiles = capped(list(raw['tiles'] ?? raw['stats'] ?? raw['items']), RICH_LIMITS.items, notes, 'tiles')
    .map((entry) => {
      const record_ = record(entry)
      if (!record_) return null
      const label = text(record_['label'] ?? record_['name'], 80)
      const value = text(record_['value'], 80)
      if (!label && !value) return null
      return {
        label,
        value,
        sub: textOrNull(record_['sub'] ?? record_['note'], 120),
        delta: numberOrNull(record_['delta']),
        deltaUnit: unit(record_['deltaUnit'] ?? 'percent'),
        trend: list(record_['trend']).slice(0, RICH_LIMITS.points).map((value) => number(value))
      }
    })
    .filter((tile): tile is StatsSpec['tiles'][number] => tile !== null)

  return tiles.length ? { title: textOrNull(raw['title']), tiles } : null
}

function parseMeter(raw: Record<string, unknown>, notes: string[]): MeterSpec | null {
  const items = capped(list(raw['items'] ?? raw['meters'] ?? raw['bars']), RICH_LIMITS.items, notes, 'meters')
    .map((entry) => {
      const record_ = record(entry)
      if (!record_) return null
      const label = text(record_['label'] ?? record_['name'], 120)
      const value = numberOrNull(record_['value'])
      if (!label || value === null) return null
      const max = numberOrNull(record_['max'])
      return {
        label,
        value,
        // A meter is a ratio against a limit; without one, percent is meant.
        max: max === null || max <= 0 ? 100 : max,
        sub: textOrNull(record_['sub'], 120)
      }
    })
    .filter((item): item is MeterSpec['items'][number] => item !== null)

  return items.length
    ? {
        title: textOrNull(raw['title']),
        caption: textOrNull(raw['caption'], 600),
        unit: unit(raw['unit']),
        items
      }
    : null
}

function parseTable(raw: Record<string, unknown>, notes: string[]): TableSpec | null {
  const rawColumns = list(raw['columns'] ?? raw['headers'])
  const rawRows = list(raw['rows'] ?? raw['data'])
  if (!rawColumns.length || !rawRows.length) return null

  const columns = capped(rawColumns, RICH_LIMITS.columns, notes, 'columns').map((entry, index) => {
    const record_ = record(entry)
    const label = record_ ? text(record_['label'] ?? record_['key'], 120) : text(entry, 120)
    const key = record_ ? text(record_['key'] ?? record_['label'], 120) : label
    const alignName = String(record_?.['align'] ?? '').toLowerCase()
    return {
      key: key || `col${index}`,
      label: label || `Column ${index + 1}`,
      align: (alignName === 'right' || alignName === 'center' ? alignName : 'left') as Align,
      unit: unit(record_?.['unit']),
      // Filled in below, from what the column actually holds.
      numeric: false
    }
  })

  const rows = capped(rawRows, RICH_LIMITS.rows, notes, 'rows').map((entry) => {
    const asRecord = record(entry)
    const cells = asRecord
      ? columns.map((column) => asRecord[column.key] ?? null)
      : list(entry).slice(0, columns.length)

    return columns.map((_column, index) => {
      const cell = cells[index] ?? null
      if (cell === null || cell === undefined) return null
      if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
      if (typeof cell === 'boolean') return cell ? 'yes' : 'no'
      return text(cell, 300)
    })
  })

  // A column is numeric when everything in it is a number: that decides
  // alignment and how sorting compares, and guessing per cell would stagger
  // the decimal points down the column.
  columns.forEach((column, index) => {
    const cells = rows.map((row) => row[index]).filter((cell) => cell !== null && cell !== '')
    column.numeric = cells.length > 0 && cells.every((cell) => numberOrNull(cell) !== null)
    if (column.numeric && column.align === 'left') column.align = 'right'
  })

  const sortByName = raw['sortBy']
  const sortIndex =
    typeof sortByName === 'number'
      ? Math.trunc(sortByName)
      : columns.findIndex((column) => column.key === text(sortByName, 120) || column.label === text(sortByName, 120))

  return {
    title: textOrNull(raw['title']),
    caption: textOrNull(raw['caption'], 600),
    columns,
    rows,
    sortable: bool(raw['sortable'], true),
    sortBy: sortIndex >= 0 && sortIndex < columns.length ? sortIndex : null,
    sortDescending: String(raw['sort'] ?? '').toLowerCase() === 'desc' || bool(raw['descending'])
  }
}

function parseTabs(raw: Record<string, unknown>, notes: string[]): TabsSpec | null {
  const tabs = capped(list(raw['tabs'] ?? raw['items'] ?? raw['panels']), RICH_LIMITS.items, notes, 'tabs')
    .map((entry, index) => {
      const record_ = record(entry)
      if (!record_) return null
      return {
        label: text(record_['label'] ?? record_['title'], 80) || `Tab ${index + 1}`,
        body: body(record_['body'] ?? record_['content'])
      }
    })
    .filter((tab): tab is TabsSpec['tabs'][number] => tab !== null)

  return tabs.length ? { tabs } : null
}

function parseAccordion(raw: Record<string, unknown>, notes: string[]): AccordionSpec | null {
  const items = capped(list(raw['items'] ?? raw['sections']), RICH_LIMITS.items, notes, 'sections')
    .map((entry, index) => {
      const record_ = record(entry)
      if (!record_) return null
      return {
        title: text(record_['title'] ?? record_['label'], 200) || `Section ${index + 1}`,
        body: body(record_['body'] ?? record_['content']),
        open: bool(record_['open'])
      }
    })
    .filter((item): item is AccordionSpec['items'][number] => item !== null)

  return items.length ? { title: textOrNull(raw['title']), items } : null
}

function parseSteps(raw: Record<string, unknown>, notes: string[]): StepsSpec | null {
  const steps = capped(list(raw['steps'] ?? raw['items'] ?? raw['events']), RICH_LIMITS.items, notes, 'steps')
    .map((entry, index) => {
      const record_ = record(entry)
      if (!record_) {
        const plain = text(entry, 200)
        return plain ? { title: plain, body: '', at: null } : null
      }
      return {
        title: text(record_['title'] ?? record_['label'], 200) || `Step ${index + 1}`,
        body: body(record_['body'] ?? record_['content']),
        at: textOrNull(record_['at'] ?? record_['date'] ?? record_['when'], 60)
      }
    })
    .filter((step): step is StepsSpec['steps'][number] => step !== null)

  return steps.length ? { title: textOrNull(raw['title']), steps } : null
}

function parseCallout(raw: Record<string, unknown>): CalloutSpec | null {
  const toneName = String(raw['tone'] ?? raw['kind'] ?? 'note').toLowerCase() as CalloutTone
  const text_ = body(raw['body'] ?? raw['content'] ?? raw['text'])
  if (!text_.trim()) return null
  return {
    tone: TONES.has(toneName) ? toneName : 'note',
    title: textOrNull(raw['title']),
    body: text_
  }
}

function parseCards(raw: Record<string, unknown>, notes: string[]): CardsSpec | null {
  const cards = capped(list(raw['cards'] ?? raw['items']), RICH_LIMITS.items, notes, 'cards')
    .map((entry) => {
      const record_ = record(entry)
      if (!record_) return null
      const title = text(record_['title'] ?? record_['label'], 200)
      const text_ = body(record_['body'] ?? record_['content'])
      if (!title && !text_) return null
      return {
        title,
        body: text_,
        meta: textOrNull(record_['meta'] ?? record_['sub'], 120),
        href: href(record_['href'] ?? record_['url'])
      }
    })
    .filter((card): card is CardsSpec['cards'][number] => card !== null)

  if (!cards.length) return null
  const columns = Math.min(Math.max(Math.trunc(number(raw['columns'], 2)), 1), 3)
  return { title: textOrNull(raw['title']), columns, cards }
}

function parseTree(raw: Record<string, unknown>, notes: string[]): TreeSpec | null {
  let remaining = RICH_LIMITS.treeNodes

  const walk = (entries: unknown[], depth: number): TreeNode[] => {
    if (depth > RICH_LIMITS.treeDepth) return []
    const nodes: TreeNode[] = []

    for (const entry of entries) {
      if (remaining <= 0) break
      const record_ = record(entry)
      const label = record_ ? text(record_['label'] ?? record_['name'], 200) : text(entry, 200)
      if (!label) continue
      remaining--

      const children = record_ ? walk(list(record_['children']), depth + 1) : []
      const declared = String(record_?.['kind'] ?? '').toLowerCase()
      nodes.push({
        label,
        // A node with something under it is a directory whatever it says.
        kind: children.length || declared === 'dir' || label.endsWith('/') ? 'dir' : 'file',
        note: record_ ? textOrNull(record_['note'], 120) : null,
        children
      })
    }

    return nodes
  }

  const nodes = walk(list(raw['nodes'] ?? raw['tree'] ?? raw['items']), 0)
  if (!nodes.length) return null
  if (remaining <= 0) notes.push(`Only the first ${RICH_LIMITS.treeNodes} entries are shown.`)

  return {
    title: textOrNull(raw['title']),
    caption: textOrNull(raw['caption'], 600),
    nodes
  }
}

/**
 * Reads one fenced block.
 *
 * Returns null for anything that is not a valid block of that kind, and the
 * caller shows the source as a code block instead. Never throws: this runs on
 * every render of every message, including halfway through a stream where the
 * JSON is by definition incomplete.
 */
export function parseRichBlock(language: string, source: string): ParsedRichBlock | null {
  const kind = richKindOf(language)
  if (!kind) return null
  if (source.length > RICH_LIMITS.bytes) return null

  let json: unknown
  try {
    json = JSON.parse(source)
  } catch {
    return null
  }

  const raw = record(json)
  if (!raw) return null

  const notes: string[] = []

  switch (kind) {
    case 'chart': {
      const spec = parseChart(raw, notes)
      return spec ? { block: { kind, spec }, notes } : null
    }
    case 'share': {
      const spec = parseShare(raw, notes)
      return spec ? { block: { kind, spec }, notes } : null
    }
    case 'stats': {
      const spec = parseStats(raw, notes)
      return spec ? { block: { kind, spec }, notes } : null
    }
    case 'meter': {
      const spec = parseMeter(raw, notes)
      return spec ? { block: { kind, spec }, notes } : null
    }
    case 'table': {
      const spec = parseTable(raw, notes)
      return spec ? { block: { kind, spec }, notes } : null
    }
    case 'tabs': {
      const spec = parseTabs(raw, notes)
      return spec ? { block: { kind, spec }, notes } : null
    }
    case 'accordion': {
      const spec = parseAccordion(raw, notes)
      return spec ? { block: { kind, spec }, notes } : null
    }
    case 'steps': {
      const spec = parseSteps(raw, notes)
      return spec ? { block: { kind, spec }, notes } : null
    }
    case 'callout': {
      const spec = parseCallout(raw)
      return spec ? { block: { kind, spec }, notes } : null
    }
    case 'cards': {
      const spec = parseCards(raw, notes)
      return spec ? { block: { kind, spec }, notes } : null
    }
    case 'tree': {
      const spec = parseTree(raw, notes)
      return spec ? { block: { kind, spec }, notes } : null
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
 * thread it is switched on for — and it leads with when NOT to use these,
 * because a model handed a box of widgets will otherwise draw a chart of two
 * numbers.
 */
export const RICH_BLOCKS_PROMPT = `# Rich blocks

This client renders extra block types beyond Markdown. Each is a fenced code block whose body is a single JSON object. The app validates and draws them; HTML and <script> are never rendered, so do not emit them.

Use these only where the shape of the data is the point. Prose stays prose, a short list stays a list, code stays in a normal code fence, and mathematics stays in $…$. Never wrap an entire answer in one. If a block does not render, its JSON was invalid.

\`\`\`dp-chart
{"chart":"line","title":"Requests per day","unit":"plain","labels":["Mon","Tue","Wed"],"series":[{"label":"OK","values":[820,932,901]},{"label":"Errors","values":[12,9,31]}]}
\`\`\`
chart: "line" | "area" | "bar" (horizontal) | "column" (vertical) | "scatter". Optional: caption, stacked (bar/column), unit ("plain"|"usd"|"percent"|"bytes"|"ms"|"tokens"). Five series maximum, and the app picks every colour. Scatter takes points instead of values, names its axes, and is readable to three series: {"chart":"scatter","xLabel":"Size","yLabel":"Time","series":[{"label":"Runs","points":[{"x":1,"y":2,"label":"a"}]}]}. There is no pie or donut: for part-to-whole use dp-share.

\`\`\`dp-share
{"title":"Where the time went","unit":"ms","segments":[{"label":"Compile","value":4200},{"label":"Tests","value":9100}]}
\`\`\`
Part-to-whole, one stacked bar. Six segments; the rest fold into "Other".

\`\`\`dp-stats
{"tiles":[{"label":"Uptime","value":"99.95%","sub":"last 30 days","delta":0.4,"trend":[3,5,4,6,9]}]}
\`\`\`
Headline numbers. delta is a signed change (percent unless deltaUnit says otherwise); trend draws a sparkline. Prefer this to a one-bar chart.

\`\`\`dp-meter
{"unit":"bytes","items":[{"label":"Disk","value":412000000,"max":512000000,"sub":"80%"}]}
\`\`\`
One or more ratios against a limit. max defaults to 100.

\`\`\`dp-table
{"title":"Endpoints","columns":["Route",{"key":"p95","label":"p95","unit":"ms"}],"rows":[["/api/users",240],["/api/search",1310]],"sortBy":"p95","sort":"desc"}
\`\`\`
Sortable, with numeric columns right-aligned automatically. Rows are arrays in column order, or objects keyed by column key. Use an ordinary Markdown table for anything small or textual.

\`\`\`dp-tabs
{"tabs":[{"label":"npm","body":"Run \`npm install\`, then …"},{"label":"pnpm","body":"Run \`pnpm install\`, then …"}]}
\`\`\`
Alternatives the reader picks between — never sequential steps. Every body is Markdown, and may itself contain a rich block.

\`\`\`dp-accordion
{"items":[{"title":"Why is this slow?","body":"…","open":false}]}
\`\`\`
Long asides, kept out of the way. Bodies are Markdown.

\`\`\`dp-steps
{"steps":[{"title":"Install","body":"…"},{"title":"Configure","body":"…","at":"2 min"}]}
\`\`\`
An ordered process. With "at" on each step it reads as a timeline.

\`\`\`dp-callout
{"tone":"warning","title":"This drops the table","body":"Back it up first."}
\`\`\`
tone: note | tip | success | warning | danger. One idea; the body is Markdown. Do not use a callout as a heading.

\`\`\`dp-cards
{"columns":2,"cards":[{"title":"better-sqlite3","body":"Synchronous, fast.","meta":"MIT","href":"https://example.com"}]}
\`\`\`
A comparison of options at a glance. href must be http or https.

\`\`\`dp-tree
{"nodes":[{"label":"src","children":[{"label":"index.ts","note":"entry"}]}]}
\`\`\`
A directory or hierarchy. A node with children is drawn as a folder.`
