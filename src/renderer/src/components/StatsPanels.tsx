import { useEffect, useState } from 'react'
import type { GlobalStats, ModelUsageRollup, ThreadStats } from '@shared/types'
import { useStore } from '../store'
import { Overlay } from './Overlay'
import { formatCost, formatDateTime, formatDuration, formatNumber, formatTokens, modelShortName } from '../format'

function Stat({
  label,
  value,
  sub,
  accent
}: {
  label: string
  value: string
  sub?: string
  accent?: boolean
}): React.JSX.Element {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value${accent ? ' stat__value--accent' : ''}`}>{value}</div>
      {sub && <div className="stat__sub">{sub}</div>}
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

export function ThreadStatsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const activeThreadId = useStore((s) => s.activeThreadId)
  const compact = useStore((s) => s.compact)
  const [stats, setStats] = useState<ThreadStats | null>(null)

  useEffect(() => {
    if (!activeThreadId) return
    void window.deepPink.stats.thread(activeThreadId).then(setStats)
  }, [activeThreadId])

  const ratio = stats?.contextLimit ? Math.min(stats.contextTokens / stats.contextLimit, 1) : 0

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
            <div className="stat-grid">
              <Stat label="Total cost" value={formatCost(stats.costUsd)} accent />
              <Stat
                label="Total tokens"
                value={formatTokens(stats.totalTokens)}
                sub={`${formatNumber(stats.totalTokens)} exactly`}
              />
              <Stat label="Messages" value={formatNumber(stats.messageCount)} />
              <Stat label="Tool calls" value={formatNumber(stats.toolCallCount)} />
            </div>

            <div className="section-title">Context window</div>
            <div className="stat" style={{ marginBottom: 18 }}>
              <div className="spread">
                <span className="muted">
                  {formatNumber(stats.contextTokens)}
                  {stats.contextLimit ? ` of ${formatNumber(stats.contextLimit)}` : ''} tokens in
                  play
                </span>
                <span className="chip">{stats.contextLimit ? `${Math.round(ratio * 100)}%` : 'unknown limit'}</span>
              </div>
              <div className="meter">
                <div className="meter__fill" data-warn={ratio > 0.75} style={{ width: `${ratio * 100}%` }} />
              </div>
            </div>

            <div className="stat-grid">
              <Stat label="Prompt tokens" value={formatTokens(stats.promptTokens)} />
              <Stat label="Completion tokens" value={formatTokens(stats.completionTokens)} />
              <Stat
                label="Reasoning tokens"
                value={formatTokens(stats.reasoningTokens)}
                sub="billed as output"
              />
              <Stat
                label="Cached tokens"
                value={formatTokens(stats.cachedTokens)}
                sub="charged at the cache-read rate"
              />
              <Stat
                label="Speed"
                value={stats.avgTokensPerSecond ? `${stats.avgTokensPerSecond.toFixed(1)} tok/s` : '—'}
                sub="average across replies"
              />
              <Stat
                label="Time to first token"
                value={
                  stats.avgTimeToFirstTokenMs ? formatDuration(Math.round(stats.avgTimeToFirstTokenMs)) : '—'
                }
                sub="average"
              />
            </div>

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

export function GlobalStatsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [stats, setStats] = useState<GlobalStats | null>(null)
  const [credits, setCredits] = useState<{ totalCredits: number; totalUsage: number } | null>(null)

  useEffect(() => {
    void window.deepPink.stats.global().then(setStats)
    void window.deepPink.stats.credits().then(setCredits)
  }, [])

  const maxDay = Math.max(1, ...(stats?.byDay.map((d) => d.costUsd) ?? [0]))

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
            <div className="stat-grid">
              <Stat label="Total spent" value={formatCost(stats.costUsd)} accent />
              <Stat
                label="Total tokens"
                value={formatTokens(stats.totalTokens)}
                sub={`${formatNumber(stats.totalTokens)} exactly`}
              />
              <Stat label="Threads" value={formatNumber(stats.threadCount)} />
              <Stat label="Messages" value={formatNumber(stats.messageCount)} />
              <Stat label="Tool calls" value={formatNumber(stats.toolCallCount)} />
              {credits && (
                <Stat
                  label="Credit remaining"
                  value={formatCost(Math.max(credits.totalCredits - credits.totalUsage, 0))}
                  sub={`${formatCost(credits.totalUsage)} used on this key`}
                />
              )}
            </div>

            <div className="stat-grid">
              <Stat label="Prompt tokens" value={formatTokens(stats.promptTokens)} />
              <Stat label="Completion tokens" value={formatTokens(stats.completionTokens)} />
              <Stat label="Reasoning tokens" value={formatTokens(stats.reasoningTokens)} />
              <Stat label="Cached tokens" value={formatTokens(stats.cachedTokens)} />
              <Stat
                label="Since"
                value={stats.firstUsedAt ? formatDateTime(stats.firstUsedAt).split(',')[0] : '—'}
              />
            </div>

            {stats.byDay.length > 0 && (
              <>
                <div className="section-title">Spend by day</div>
                <div style={{ marginBottom: 18 }}>
                  {stats.byDay.slice(0, 21).map((day) => (
                    <div className="bar-row" key={day.day}>
                      <div>
                        <div className="spread" style={{ marginBottom: 3 }}>
                          <span className="dim">{day.day}</span>
                          <span className="dim">
                            {formatTokens(day.totalTokens)} · {day.requests} req
                          </span>
                        </div>
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${(day.costUsd / maxDay) * 100}%` }} />
                        </div>
                      </div>
                      <span className="mono nowrap">{formatCost(day.costUsd)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <RollupTable rows={stats.byModel} caption="By model" />
            <RollupTable rows={stats.byProvider} caption="By provider" />
          </>
        )}
      </div>
    </Overlay>
  )
}
