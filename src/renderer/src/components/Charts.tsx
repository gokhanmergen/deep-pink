import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * The charts, built by hand in SVG.
 *
 * A charting library would be several hundred kilobytes to draw a line chart and
 * a few bars, and would arrive with its own idea of what a dark theme is. These
 * follow the app's tokens instead: 2px lines, a ten-percent wash under a lone
 * series, hairline gridlines one step off the surface, and no colour anywhere
 * except on the data itself.
 */

/** Measures an element, so an SVG can be drawn at real pixels rather than scaled. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = (): void => setWidth(el.clientWidth)
    measure()

    // Panels are resizable and the sidebar can be hidden underneath one, so the
    // chart is measured continuously rather than once on mount.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}

/**
 * The categorical slots, in fixed order.
 *
 * Taken from a documented palette and re-validated against this app's surface:
 * every slot sits inside the dark-mode lightness band, clears 3:1 against
 * `#0a0a0a`, and the worst adjacent pair separates by ΔE 8.4 under simulated
 * colour-vision deficiency and 19.3 for normal vision. The order is the safety
 * mechanism, not decoration — never reorder it, never generate a sixth.
 *
 * A series keeps the slot its entity was given, so hiding one never repaints
 * the others.
 */
export const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']

/** Past this the tail is folded into one "Other" line rather than given a hue. */
export const MAX_SERIES = SERIES_COLORS.length

export interface ChartSeries {
  id: string
  label: string
  /** One value per label, in the same order. */
  values: number[]
  /**
   * Slot in `SERIES_COLORS`. Left off for a lone series, which wears the app's
   * accent — there is no identity to encode when there is only one of them.
   */
  slot?: number
}

/**
 * Nice round numbers for the y-axis, so ticks read 0 / 50 / 100 rather than
 * 0 / 47.3 / 94.6. Returns the top of the scale and the ticks below it.
 */
export function niceScale(max: number, ticks = 3): { top: number; steps: number[] } {
  if (max <= 0) return { top: 1, steps: [0] }

  const rough = max / ticks
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10
  const top = Math.ceil(max / step) * step

  const steps: number[] = []
  for (let at = 0; at <= top + step / 2; at += step) steps.push(at)
  return { top, steps }
}

interface TimeChartProps {
  /** One label per x position, shared by every series. */
  labels: string[]
  series: ChartSeries[]
  /** Formats a value for the axis and the tooltip. */
  format: (value: number) => string
  height?: number
  /** Anything else the tooltip should say about a position, e.g. request counts. */
  notes?: string[]
}

/**
 * One or more series over time.
 *
 * A lone series is filled, because the area under it is legible and pleasant.
 * Several are drawn as lines only: overlapping washes muddy into colours that
 * belong to no series. The crosshair snaps to the nearest position and reads
 * out every visible series at once, so the pointer never has to find a line.
 */
export function TimeChart({
  labels,
  series,
  format,
  height = 190,
  notes
}: TimeChartProps): React.JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const [hidden, setHidden] = useState<string[]>([])

  // A series that disappears from the data takes its hidden flag with it, so a
  // switch of measure or range never leaves a line invisibly switched off.
  const ids = series.map((s) => s.id).join('\u0000')
  useEffect(() => setHidden((current) => current.filter((id) => ids.split('\u0000').includes(id))), [ids])

  const visible = series.filter((s) => !hidden.includes(s.id))

  const pad = { top: 10, right: 8, bottom: 20, left: 52 }
  const plotWidth = Math.max(width - pad.left - pad.right, 10)
  const plotHeight = Math.max(height - pad.top - pad.bottom, 10)

  const scale = useMemo(
    () => niceScale(Math.max(...visible.flatMap((s) => s.values), 0)),
    [visible]
  )

  const x = useCallback(
    (index: number): number =>
      pad.left + (labels.length < 2 ? plotWidth / 2 : (index / (labels.length - 1)) * plotWidth),
    [labels.length, plotWidth, pad.left]
  )
  const y = useCallback(
    (value: number): number => pad.top + plotHeight - (value / scale.top) * plotHeight,
    [plotHeight, scale.top, pad.top]
  )

  const colorOf = (entry: ChartSeries): string =>
    entry.slot === undefined ? 'var(--accent)' : SERIES_COLORS[entry.slot % SERIES_COLORS.length]

  const pathOf = (entry: ChartSeries): string =>
    entry.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ')

  const onMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    if (labels.length < 2) {
      setHover(labels.length - 1)
      return
    }
    const box = event.currentTarget.getBoundingClientRect()
    const at = ((event.clientX - box.left - pad.left) / plotWidth) * (labels.length - 1)
    setHover(Math.min(Math.max(Math.round(at), 0), labels.length - 1))
  }

  // Kept on whichever side of the crosshair has room, so it never leaves the panel.
  const tipRight = hover !== null && x(hover) > pad.left + plotWidth / 2
  const single = visible.length === 1

  return (
    <>
      <div className="viz" ref={ref}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            role="img"
            aria-label={`${series.map((s) => s.label).join(', ')} over ${labels.length} points`}
          >
            {scale.steps.map((step) => (
              <g key={step}>
                <line
                  className="viz__grid"
                  x1={pad.left}
                  x2={pad.left + plotWidth}
                  y1={y(step)}
                  y2={y(step)}
                />
                <text
                  className="viz__tick"
                  x={pad.left - 8}
                  y={y(step)}
                  textAnchor="end"
                  dy="0.32em"
                >
                  {format(step)}
                </text>
              </g>
            ))}

            {/* Filled only when it is alone: stacked washes make a colour that
                belongs to no series. */}
            {single && visible[0].values.length > 0 && (
              <path
                className="viz__area"
                d={`${pathOf(visible[0])} L${x(labels.length - 1)},${y(0)} L${x(0)},${y(0)} Z`}
                style={{ fill: visible[0].slot === undefined ? undefined : colorOf(visible[0]) }}
                opacity={visible[0].slot === undefined ? undefined : 0.1}
              />
            )}

            {visible.map((entry) => (
              <path
                key={entry.id}
                className="viz__line"
                d={pathOf(entry)}
                style={{ stroke: colorOf(entry) }}
              />
            ))}

            {/* The last point of each series is marked; every other value
                belongs to the crosshair and the table below. */}
            {visible.map((entry) => (
              <circle
                key={`end-${entry.id}`}
                className="viz__end"
                cx={x(labels.length - 1)}
                cy={y(entry.values[entry.values.length - 1] ?? 0)}
                r={4}
                style={{ fill: colorOf(entry) }}
              />
            ))}

            {hover !== null && (
              <>
                <line
                  className="viz__crosshair"
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={pad.top}
                  y2={pad.top + plotHeight}
                />
                {visible.map((entry) => (
                  <circle
                    key={`dot-${entry.id}`}
                    className="viz__dot"
                    cx={x(hover)}
                    cy={y(entry.values[hover] ?? 0)}
                    r={4}
                    style={{ fill: colorOf(entry) }}
                  />
                ))}
              </>
            )}

            {labels.length > 0 && (
              <>
                <text className="viz__tick" x={pad.left} y={height - 5}>
                  {labels[0]}
                </text>
                <text
                  className="viz__tick"
                  x={pad.left + plotWidth}
                  y={height - 5}
                  textAnchor="end"
                >
                  {labels[labels.length - 1]}
                </text>
              </>
            )}
          </svg>
        )}

        {hover !== null && visible.length > 0 && (
          <div
            className="viz__tip"
            style={
              tipRight
                ? { right: `${Math.max(width - x(hover) + 10, 8)}px` }
                : { left: `${x(hover) + 10}px` }
            }
          >
            <div className="viz__tip-sub">{labels[hover]}</div>
            {visible.map((entry) => (
              <div className="viz__tip-row" key={entry.id}>
                <span className="viz__key" style={{ background: colorOf(entry) }} />
                <span className="viz__tip-value">{format(entry.values[hover] ?? 0)}</span>
                <span className="viz__tip-label">{entry.label}</span>
              </div>
            ))}
            {notes?.[hover] && <div className="viz__tip-sub">{notes[hover]}</div>}
          </div>
        )}
      </div>

      {/* Two or more series always carry a legend: identity is never left to
          colour-matching alone. Each key is also the switch for its line. */}
      {series.length > 1 && (
        <div className="legend">
          {series.map((entry) => {
            const on = !hidden.includes(entry.id)
            return (
              <button
                key={entry.id}
                className="legend__item"
                data-on={on}
                onClick={() =>
                  setHidden((current) =>
                    on ? [...current, entry.id] : current.filter((id) => id !== entry.id)
                  )
                }
                aria-pressed={on}
                title={on ? `Hide ${entry.label}` : `Show ${entry.label}`}
                type="button"
              >
                <span className="viz__key" style={{ background: colorOf(entry) }} />
                {entry.label}
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

/**
 * One row of a part-to-whole: what it is, what it cost, and how much of the
 * total that is. A bar per row rather than one stacked bar, so the hues never
 * multiply and each row can be read on its own.
 */
export function ShareRow({
  label,
  value,
  share,
  sub
}: {
  label: React.ReactNode
  value: string
  /** 0–1. */
  share: number
  sub?: string
}): React.JSX.Element {
  return (
    <div className="share">
      <div className="share__head">
        <span className="share__label">{label}</span>
        <span className="share__value">{value}</span>
      </div>
      <div className="share__track">
        <div className="share__fill" style={{ width: `${Math.max(share * 100, 1)}%` }} />
      </div>
      {sub && <div className="share__sub">{sub}</div>}
    </div>
  )
}

export interface Tile {
  label: string
  value: string
  sub?: string
}

/** The row of headline numbers, divided by rules rather than boxed in cards. */
export function StatTiles({ tiles }: { tiles: Tile[] }): React.JSX.Element {
  return (
    <div className="tiles">
      {tiles.map((tile) => (
        <div className="tile" key={tile.label}>
          <div className="tile__label">{tile.label}</div>
          <div className="tile__value">{tile.value}</div>
          {tile.sub && <div className="tile__sub">{tile.sub}</div>}
        </div>
      ))}
    </div>
  )
}

/** The small either/or above a chart: a range, a measure, a breakdown. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label
}: {
  options: { id: T; label: string }[]
  value: T
  onChange: (next: T) => void
  label: string
}): React.JSX.Element {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          className="segmented__option"
          data-active={option.id === value}
          onClick={() => onChange(option.id)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
