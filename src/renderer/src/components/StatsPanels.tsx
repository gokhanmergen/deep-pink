import { useEffect, useMemo, useState } from 'react'
import type { GlobalStats, ModelUsageRollup, ThreadStats, ToolUsageRollup } from '@shared/types'
import { useStore } from '../store'
import { Overlay } from './Overlay'
import {
  MAX_SERIES,
  Segmented,
  ShareRow,
  StatTiles,
  TimeChart,
  type ChartSeries
} from './Charts'
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatTokens,
  modelShortName
} from '../format'

const SOURCE_LABEL: Record<string, string> = {
  repo: 'Attached repository',
  web: 'Web search and fetch',
  mcp: 'MCP servers'
}

/** What tools pulled into the context, which is the part that costs money. */
function ToolUsage({ rows }: { rows: ToolUsageRollup[] }): React.JSX.Element | null {
  if (!rows.length) return null
  const most = Math.max(...rows.map((row) => row.estimatedTokens), 1)

  return (
    <>
      <div className="section-title">What tools brought in</div>
      <table className="table">
        <thead>
          <tr>
            <th>Source</th>
            <th className="num">Calls</th>
            <th className="num">Read</th>
            <th className="num">Est. tokens</th>
            <th>Share</th>
            <th className="num">Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.source}>
              <td>{SOURCE_LABEL[row.source] ?? row.source}</td>
              <td className="num">{formatNumber(row.calls)}</td>
              <td className="num">
                {row.chars < 1024
                  ? `${row.chars} B`
                  : row.chars < 1024 * 1024
                    ? `${Math.round(row.chars / 1024)} KB`
                    : `${(row.chars / 1024 / 1024).toFixed(1)} MB`}
              </td>
              <td className="num">{formatTokens(row.estimatedTokens)}</td>
              <td style={{ width: 90 }}>
                <div className="share__track">
                  <div
                    className="share__fill"
                    style={{ width: `${Math.max((row.estimatedTokens / most) * 100, 1)}%` }}
                  />
                </div>
              </td>
              <td className="num">{formatDuration(row.totalMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="field__hint" style={{ marginTop: 6 }}>
        Estimated from what was returned. These tokens are billed as part of the
        prompt on the turn after each call, and again on every turn that follows
        until the context is compacted.
      </p>
    </>
  )
}

/**
 * A rollup as rows with a share bar each.
 *
 * One bar per row rather than one stacked bar: the hues never multiply, every
 * row can be read on its own, and the table underneath keeps the exact numbers
 * reachable without hovering anything.
 */
function ShareList({
  rows,
  total
}: {
  rows: ModelUsageRollup[]
  total: number
}): React.JSX.Element | null {
  if (!rows.length) return null

  return (
    <div>
      {rows.slice(0, 6).map((row) => (
        <ShareRow
          key={`${row.model}:${row.provider ?? ''}`}
          label={
            <>
              <span className="viz__key" />
              <span title={row.model}>{modelShortName(row.model) || 'unknown'}</span>
            </>
          }
          value={formatCost(row.costUsd)}
          share={total > 0 ? row.costUsd / total : 0}
          sub={`${total > 0 ? ((row.costUsd / total) * 100).toFixed(1) : '0.0'}% of cost · ${formatTokens(row.totalTokens)} tokens`}
        />
      ))}
    </div>
  )
}

function RollupTable({
  rows,
  caption
}: {
  rows: ModelUsageRollup[]
  caption: string
}): React.JSX.Element | null {
  if (!rows.length) return null
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0)

  return (
    <>
      <div className="section-title">{caption}</div>
      <table className="table">
        <thead>
          <tr>
            <th>{caption.includes('provider') ? 'Provider' : 'Model'}</th>
            <th className="num">Requests</th>
            <th className="num">In</th>
            <th className="num">Out</th>
            <th className="num">Cost</th>
            <th className="num">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.model}:${row.provider ?? ''}`}>
              <td title={row.model}>{modelShortName(row.model)}</td>
              <td className="num">{formatNumber(row.requests)}</td>
              <td className="num">{formatTokens(row.promptTokens)}</td>
              <td className="num">{formatTokens(row.completionTokens)}</td>
              <td className="num">{formatCost(row.costUsd)}</td>
              <td className="num">
                {total > 0 ? `${((row.costUsd / total) * 100).toFixed(1)}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Per-thread
 * ------------------------------------------------------------------ */

type Measure = 'cost' | 'tokens'

const MEASURES: { id: Measure; label: string }[] = [
  { id: 'cost', label: 'Cost' },
  { id: 'tokens', label: 'Tokens' }
]

export function ThreadStatsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const activeThreadId = useStore((s) => s.activeThreadId)
  const compact = useStore((s) => s.compact)
  const [stats, setStats] = useState<ThreadStats | null>(null)
  const [measure, setMeasure] = useState<Measure>('cost')

  useEffect(() => {
    if (!activeThreadId) return
    void window.deepPink.stats.thread(activeThreadId).then(setStats)
  }, [activeThreadId])

  const ratio = stats?.contextLimit ? Math.min(stats.contextTokens / stats.contextLimit, 1) : 0

  // One point per request, in order. Turns are numbered rather than dated: what
  // matters is where in the conversation the money went, not the clock time.
  const turns = useMemo(() => {
    const rows = stats?.byTurn ?? []
    return {
      labels: rows.map((_, index) => `Turn ${index + 1}`),
      notes: rows.map((turn) => formatDateTime(turn.at)),
      series: [
        {
          id: 'turn',
          label: measure === 'cost' ? 'Cost' : 'Tokens',
          values: rows.map((turn) => (measure === 'cost' ? turn.costUsd : turn.totalTokens))
        }
      ] as ChartSeries[]
    }
  }, [stats, measure])

  const format = measure === 'cost' ? formatCost : formatTokens

  return (
    <Overlay
      title="Thread statistics"
      onClose={onClose}
      wide
      footer={
        <>
          <span>Counts come from the provider's own accounting, recorded per message.</span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => void compact()} type="button">
            Compact context now
          </button>
        </>
      }
    >
      <div className="panel__body">
        {!stats ? (
          <p className="dim">Loading…</p>
        ) : (
          <>
            <div className="viz-split">
              <div>
                <div className="hero">
                  <div className="hero__label">Thread cost</div>
                  <div className="hero__value">{formatCost(stats.costUsd)}</div>
                  <div className="hero__sub">
                    {formatNumber(stats.messageCount)} message
                    {stats.messageCount === 1 ? '' : 's'} · {formatTokens(stats.totalTokens)} tokens
                  </div>
                </div>

                <div style={{ marginTop: 16 }}>
                  <ShareList rows={stats.byModel} total={stats.costUsd} />
                </div>
              </div>

              <div>
                <div className="viz-head">
                  <span className="viz-head__title">
                    {measure === 'cost' ? 'Cost per turn' : 'Tokens per turn'}
                  </span>
                  <div style={{ flex: 1 }} />
                  <Segmented
                    options={MEASURES}
                    value={measure}
                    onChange={setMeasure}
                    label="What the chart plots"
                  />
                </div>

                {turns.labels.length > 1 ? (
                  <TimeChart
                    labels={turns.labels}
                    series={turns.series}
                    notes={turns.notes}
                    format={format}
                  />
                ) : (
                  <p className="field__hint">
                    A second reply is needed before there is a shape to plot.
                  </p>
                )}
              </div>
            </div>

            <StatTiles
              tiles={[
                {
                  label: 'Prompt tokens',
                  value: formatTokens(stats.promptTokens),
                  sub: `${formatNumber(stats.promptTokens)} exactly`
                },
                { label: 'Completion', value: formatTokens(stats.completionTokens) },
                {
                  label: 'Reasoning',
                  value: formatTokens(stats.reasoningTokens),
                  sub: 'billed as output'
                },
                {
                  label: 'Cached',
                  value: formatTokens(stats.cachedTokens),
                  sub: 'at the cache-read rate'
                },
                {
                  label: 'Speed',
                  value: stats.avgTokensPerSecond
                    ? `${stats.avgTokensPerSecond.toFixed(1)} tok/s`
                    : '—',
                  sub: 'average across replies'
                },
                {
                  label: 'First token',
                  value: stats.avgTimeToFirstTokenMs
                    ? formatDuration(Math.round(stats.avgTimeToFirstTokenMs))
                    : '—',
                  sub: 'average'
                }
              ]}
            />

            <div className="section-title">Context window</div>
            <div className="stat" style={{ marginBottom: 18 }}>
              <div className="spread">
                <span className="muted">
                  {formatNumber(stats.contextTokens)}
                  {stats.contextLimit ? ` of ${formatNumber(stats.contextLimit)}` : ''} tokens in
                  play
                </span>
                <span className="chip">
                  {stats.contextLimit ? `${Math.round(ratio * 100)}%` : 'unknown limit'}
                </span>
              </div>
              <div className="meter">
                <div
                  className="meter__fill"
                  data-warn={ratio > 0.75}
                  style={{ width: `${ratio * 100}%` }}
                />
              </div>
            </div>

            <ToolUsage rows={stats.toolUsage} />
            <RollupTable rows={stats.byModel} caption="By model" />
          </>
        )}
      </div>
    </Overlay>
  )
}

/* ------------------------------------------------------------------ *
 * Global
 * ------------------------------------------------------------------ */

type Range = '7' | '30' | '90'

const RANGES: { id: Range; label: string }[] = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' }
]

type Breakdown = 'model' | 'day'

const BREAKDOWNS: { id: Breakdown; label: string }[] = [
  { id: 'model', label: 'Model' },
  { id: 'day', label: 'Day' }
]

type Grouping = 'total' | 'model'

const GROUPINGS: { id: Grouping; label: string }[] = [
  { id: 'total', label: 'Total' },
  { id: 'model', label: 'By model' }
]

/** `YYYY-MM-DD` for a local date `back` days ago, matching what SQLite stored. */
function dayKey(back: number): string {
  const at = new Date()
  at.setDate(at.getDate() - back)
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/** `Jul 21` — short enough for an axis end. */
function shortDay(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}

export function GlobalStatsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [stats, setStats] = useState<GlobalStats | null>(null)
  const [credits, setCredits] = useState<{ totalCredits: number; totalUsage: number } | null>(null)
  const [range, setRange] = useState<Range>('30')
  const [measure, setMeasure] = useState<Measure>('cost')
  const [grouping, setGrouping] = useState<Grouping>('total')
  const [breakdown, setBreakdown] = useState<Breakdown>('model')

  useEffect(() => {
    void window.deepPink.stats.global().then(setStats)
    void window.deepPink.stats.credits().then(setCredits)
  }, [])

  /**
   * One point per day across the whole range, days with no spend included.
   *
   * The database only has rows for days something was sent, and plotting those
   * alone would space a quiet fortnight the same as two busy days — a chart that
   * reads as steady use when the truth is two spikes.
   */
  const days = useMemo(() => {
    const span = Number(range)
    const byDay = new Map((stats?.byDay ?? []).map((day) => [day.day, day]))

    return Array.from({ length: span }, (_, index) => {
      const key = dayKey(span - 1 - index)
      const found = byDay.get(key)
      return {
        key,
        costUsd: found?.costUsd ?? 0,
        totalTokens: found?.totalTokens ?? 0,
        requests: found?.requests ?? 0
      }
    })
  }, [stats, range])

  const labels = useMemo(() => days.map((day) => shortDay(day.key)), [days])
  const notes = useMemo(
    () => days.map((day) => `${day.requests} request${day.requests === 1 ? '' : 's'}`),
    [days]
  )

  /**
   * The chart's series: either one line for everything, or one per model.
   *
   * Models are ranked by what they cost across the whole range and keep the
   * colour that rank gives them for as long as the range does — hiding a line
   * from the legend never repaints the ones left behind. Past the palette, the
   * tail is folded into a single "Other" rather than given a generated hue
   * nobody could tell from the others.
   */
  const series = useMemo<ChartSeries[]>(() => {
    const value = (row: { costUsd: number; totalTokens: number }): number =>
      measure === 'cost' ? row.costUsd : row.totalTokens

    if (grouping === 'total') {
      return [{ id: 'total', label: 'All models', values: days.map(value) }]
    }

    const within = new Set(days.map((day) => day.key))
    const rows = (stats?.byDayModel ?? []).filter((row) => within.has(row.day))

    const spend = new Map<string, number>()
    for (const row of rows) spend.set(row.model, (spend.get(row.model) ?? 0) + row.costUsd)

    const ranked = [...spend.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model)
    const named = ranked.slice(0, spend.size > MAX_SERIES ? MAX_SERIES - 1 : MAX_SERIES)
    const folded = new Set(ranked.slice(named.length))

    const byKey = new Map<string, number>()
    for (const row of rows) {
      const key = `${folded.has(row.model) ? '\u0000other' : row.model}:${row.day}`
      byKey.set(key, (byKey.get(key) ?? 0) + value(row))
    }

    const build = (id: string, label: string, slot: number): ChartSeries => ({
      id,
      label,
      slot,
      values: days.map((day) => byKey.get(`${id}:${day.key}`) ?? 0)
    })

    const built = named.map((model, index) =>
      build(model, modelShortName(model) || 'unknown', index)
    )
    if (folded.size) {
      built.push(build('\u0000other', `Other (${folded.size})`, named.length))
    }
    return built
  }, [days, stats, measure, grouping])

  const inRange = useMemo(
    () =>
      days.reduce(
        (sum, day) => ({
          cost: sum.cost + day.costUsd,
          tokens: sum.tokens + day.totalTokens,
          requests: sum.requests + day.requests,
          activeDays: sum.activeDays + (day.requests > 0 ? 1 : 0)
        }),
        { cost: 0, tokens: 0, requests: 0, activeDays: 0 }
      ),
    [days]
  )

  const format = measure === 'cost' ? formatCost : formatTokens

  return (
    <Overlay
      title="Global statistics"
      onClose={onClose}
      wide
      footer={
        <span>
          Everything here is computed from your local database. Credit balance is the only figure
          fetched from OpenRouter.
        </span>
      }
    >
      <div className="panel__body">
        {!stats ? (
          <p className="dim">Loading…</p>
        ) : (
          <>
            {/* One row of filters, above everything they scope. */}
            <div className="viz-head">
              <span className="dim" style={{ fontSize: 12 }}>
                {shortDay(days[0]?.key ?? dayKey(0))} to {shortDay(days[days.length - 1]?.key ?? dayKey(0))}
              </span>
              <div style={{ flex: 1 }} />
              <Segmented options={RANGES} value={range} onChange={setRange} label="Date range" />
            </div>

            <div className="viz-split">
              <div>
                <div className="hero">
                  <div className="hero__label">Spent in range</div>
                  <div className="hero__value">{formatCost(inRange.cost)}</div>
                  <div className="hero__sub">
                    {formatCost(stats.costUsd)} since{' '}
                    {stats.firstUsedAt ? formatDateTime(stats.firstUsedAt).split(',')[0] : 'the start'}
                  </div>
                </div>

                <div style={{ marginTop: 16 }}>
                  <ShareList rows={stats.byModel} total={stats.costUsd} />
                </div>
              </div>

              <div>
                <div className="viz-head">
                  <span className="viz-head__title">
                    {measure === 'cost' ? 'Daily cost' : 'Daily tokens'}
                  </span>
                  <div style={{ flex: 1 }} />
                  <Segmented
                    options={GROUPINGS}
                    value={grouping}
                    onChange={setGrouping}
                    label="One line or one per model"
                  />
                  <Segmented
                    options={MEASURES}
                    value={measure}
                    onChange={setMeasure}
                    label="What the chart plots"
                  />
                </div>

                <TimeChart labels={labels} series={series} notes={notes} format={format} />
              </div>
            </div>

            <StatTiles
              tiles={[
                {
                  label: 'Processed tokens',
                  value: formatTokens(inRange.tokens),
                  sub: inRange.activeDays
                    ? `${formatTokens(Math.round(inRange.tokens / inRange.activeDays))} per active day`
                    : 'nothing sent yet'
                },
                {
                  label: 'Cached input',
                  value: formatTokens(stats.cachedTokens),
                  sub: stats.promptTokens
                    ? `${((stats.cachedTokens / stats.promptTokens) * 100).toFixed(1)}% of all input`
                    : undefined
                },
                {
                  label: 'Output',
                  value: formatTokens(stats.completionTokens),
                  sub: `includes ${formatTokens(stats.reasoningTokens)} reasoning`
                },
                {
                  label: 'Requests',
                  value: formatNumber(inRange.requests),
                  sub: `${formatNumber(stats.threadCount)} threads`
                },
                credits
                  ? {
                      label: 'Credit left',
                      value: formatCost(Math.max(credits.totalCredits - credits.totalUsage, 0)),
                      sub: `${formatCost(credits.totalUsage)} used on this key`
                    }
                  : {
                      label: 'Messages',
                      value: formatNumber(stats.messageCount),
                      sub: `${formatNumber(stats.toolCallCount)} tool calls`
                    }
              ]}
            />

            <div className="viz-head">
              <span className="viz-head__title">Breakdown</span>
              <div style={{ flex: 1 }} />
              <Segmented
                options={BREAKDOWNS}
                value={breakdown}
                onChange={setBreakdown}
                label="How to break the spend down"
              />
            </div>

            {breakdown === 'model' ? (
              <>
                <RollupTable rows={stats.byModel} caption="By model" />
                <RollupTable rows={stats.byProvider} caption="By provider" />
              </>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="num">Requests</th>
                    <th className="num">Tokens</th>
                    <th style={{ width: 110 }}>Cost</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {[...days]
                    .reverse()
                    .filter((day) => day.requests > 0)
                    .map((day) => (
                      <tr key={day.key}>
                        <td>{shortDay(day.key)}</td>
                        <td className="num">{formatNumber(day.requests)}</td>
                        <td className="num">{formatTokens(day.totalTokens)}</td>
                        <td>
                          <div className="share__track">
                            <div
                              className="share__fill"
                              style={{
                                width: `${Math.max(
                                  (day.costUsd / Math.max(...days.map((d) => d.costUsd), 1)) * 100,
                                  1
                                )}%`
                              }}
                            />
                          </div>
                        </td>
                        <td className="num">{formatCost(day.costUsd)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}

            <ToolUsage rows={stats.toolUsage} />
          </>
        )}
      </div>
    </Overlay>
  )
}
