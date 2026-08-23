import { useMemo, useState } from 'react'
import type { ChartSpec, ShareSpec, RichUnit } from '@shared/richBlocks'
import { SERIES_COLORS, TimeChart, niceScale, useWidth } from '../Charts'
import { formatTick, formatUnit } from './units'

/**
 * The charts a rich block can draw.
 *
 * Same rules as the statistics panels next door, because they are the same
 * app: the five-slot categorical palette in fixed order, hairline solid
 * gridlines, 2px lines, marks capped at 24px with a rounded data end, a 2px
 * surface gap doing the separating, a legend whenever there are two or more
 * series, and values on the axis and in the tooltip rather than printed beside
 * every mark. A model cannot choose a colour here — it names series, and the
 * palette answers.
 */

/** The slot a series wears. Identity follows position, never rank or value. */
function colorAt(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]
}

/**
 * A scale that includes zero, so bar length stays proportional to value —
 * the one thing a bar chart must not get wrong.
 */
function scaleFor(values: number[]): { min: number; max: number; ticks: number[] } {
  const high = Math.max(0, ...values)
  const low = Math.min(0, ...values)

  const top = niceScale(high || 1)
  if (low === 0) return { min: 0, max: top.top, ticks: top.steps }

  const bottom = niceScale(-low)
  return {
    min: -bottom.top,
    max: top.top,
    ticks: [...bottom.steps.filter((s) => s > 0).map((s) => -s).reverse(), ...top.steps]
  }
}

/**
 * A bar with its data end rounded and its baseline square.
 *
 * `side` is the end the value grows towards, so a bar that runs left because
 * its value is negative is rounded on the left.
 */
function barPath(
  x: number,
  y: number,
  width: number,
  height: number,
  side: 'top' | 'bottom' | 'left' | 'right'
): string {
  const radius = Math.min(4, width / 2, height / 2)
  if (radius <= 0.5 || width <= 0 || height <= 0) {
    return `M${x},${y}h${width}v${height}h${-width}Z`
  }

  const r = radius
  switch (side) {
    case 'right':
      return `M${x},${y}h${width - r}a${r},${r} 0 0 1 ${r},${r}v${height - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(width - r)}Z`
    case 'left':
      return `M${x + width},${y}h${-(width - r)}a${r},${r} 0 0 0 ${-r},${r}v${height - 2 * r}a${r},${r} 0 0 0 ${r},${r}h${width - r}Z`
    case 'top':
      return `M${x},${y + height}v${-(height - r)}a${r},${r} 0 0 1 ${r},${-r}h${width - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${height - r}Z`
    default:
      return `M${x},${y}v${height - r}a${r},${r} 0 0 0 ${r},${r}h${width - 2 * r}a${r},${r} 0 0 0 ${r},${-r}v${-(height - r)}Z`
  }
}

/** Text with no room to be measured: cut to what the gutter can hold. */
function clip(label: string, pixels: number): string {
  const fits = Math.max(Math.floor(pixels / 6.2), 3)
  return label.length <= fits ? label : `${label.slice(0, fits - 1)}…`
}

interface Hover {
  band: number
  x: number
  y: number
}

function Legend({ series }: { series: { label: string }[] }): React.JSX.Element | null {
  if (series.length < 2) return null
  return (
    <div className="legend">
      {series.map((entry, index) => (
        <span className="legend__item" key={`${entry.label}-${index}`}>
          <span className="viz__key" style={{ background: colorAt(index) }} />
          {entry.label}
        </span>
      ))}
    </div>
  )
}

/**
 * Bars and columns, grouped or stacked.
 *
 * One component for both directions: the difference is which axis carries the
 * categories, and writing it twice would be two places for the geometry to go
 * wrong.
 */
export function RichBars({ spec }: { spec: ChartSpec }): React.JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<Hover | null>(null)

  const horizontal = spec.chart === 'bar'
  const series = spec.series
  const bands = Math.max(
    spec.labels.length,
    ...series.map((entry) => entry.values.length)
  )

  const flat = useMemo(() => series.flatMap((entry) => entry.values), [series])
  // Stacking negatives makes a bar that means nothing, so a stack that contains
  // one is drawn grouped instead and says so underneath.
  const negatives = flat.some((value) => value < 0)
  const stacked = spec.stacked && series.length > 1 && !negatives

  const totals = useMemo(
    () =>
      Array.from({ length: bands }, (_, band) =>
        series.reduce((sum, entry) => sum + Math.max(entry.values[band] ?? 0, 0), 0)
      ),
    [bands, series]
  )

  const scale = useMemo(
    () => scaleFor(stacked ? totals : flat),
    [stacked, totals, flat]
  )

  const gap = 2
  const thickness = 24
  const rows = stacked ? 1 : series.length
  const bandSize = Math.min(rows * thickness + (rows - 1) * gap + 14, 64)

  const gutter = horizontal ? Math.min(Math.max(width * 0.26, 60), 150) : 52
  const pad = horizontal
    ? { top: 6, right: 44, bottom: 22, left: gutter }
    : { top: 12, right: 8, bottom: 26, left: gutter }

  const height = horizontal
    ? Math.max(bands * bandSize + pad.top + pad.bottom, 90)
    : Math.max(Math.min(bands * 46, 260), 150)

  const plotWidth = Math.max(width - pad.left - pad.right, 10)
  const plotHeight = height - pad.top - pad.bottom

  const span = scale.max - scale.min || 1
  /** Where a value sits along the value axis, in pixels from the plot origin. */
  const along = (value: number): number => ((value - scale.min) / span) * (horizontal ? plotWidth : plotHeight)
  const zero = along(0)

  const bandAt = (index: number): number =>
    (horizontal ? pad.top : pad.left) + index * (horizontal ? bandSize : plotWidth / bands)

  const bandWidth = horizontal ? bandSize : plotWidth / bands
  // The air around a band is a proportion of it, not a fixed 14px: at thirty
  // categories a fixed margin is wider than the band and leaves no bar at all.
  const air = Math.min(14, bandWidth * 0.25)
  const barThickness = Math.max(
    Math.min((bandWidth - air - (rows - 1) * gap) / rows, thickness),
    1
  )

  // Enough x labels not to collide, and never fewer than the two ends.
  const labelStep = horizontal
    ? 1
    : Math.max(Math.ceil(bands / Math.max(Math.floor(plotWidth / 56), 1)), 1)

  const marks = (band: number): React.JSX.Element[] => {
    const out: React.JSX.Element[] = []
    let offset = 0

    series.forEach((entry, index) => {
      const value = entry.values[band]
      if (value === undefined) return

      const start = stacked ? offset : 0
      if (stacked) offset += Math.max(value, 0)

      const from = stacked ? along(start) : zero
      const to = stacked ? along(start + Math.max(value, 0)) : along(value)
      const length = Math.abs(to - from)
      // A stacked segment gives up 2px of itself so the surface separates it
      // from the next; a lone bar keeps all of its length.
      const drawn = stacked ? Math.max(length - gap, 0) : length
      if (drawn <= 0) return

      const lane = stacked ? 0 : index
      const cross = bandAt(band) + air / 2 + lane * (barThickness + gap)

      const path = horizontal
        ? barPath(
            pad.left + Math.min(from, to) + (stacked ? gap : 0),
            cross,
            drawn,
            barThickness,
            value < 0 ? 'left' : 'right'
          )
        : barPath(
            cross,
            pad.top + plotHeight - Math.max(from, to),
            barThickness,
            drawn,
            value < 0 ? 'bottom' : 'top'
          )

      out.push(
        <path key={`${band}-${index}`} d={path} style={{ fill: colorAt(index) }} className="rb-bar" />
      )
    })

    return out
  }

  /** The value beside a lone bar's tip, where there is room for it. */
  const tipLabel = (band: number): React.JSX.Element | null => {
    if (series.length !== 1 || stacked) return null
    const value = series[0].values[band]
    if (value === undefined) return null

    if (horizontal) {
      return (
        <text
          className="viz__tick rb-bar__value"
          x={pad.left + along(value) + (value < 0 ? -6 : 6)}
          y={bandAt(band) + air / 2 + barThickness / 2}
          textAnchor={value < 0 ? 'end' : 'start'}
          dy="0.32em"
        >
          {formatUnit(value, spec.unit)}
        </text>
      )
    }

    if (bandWidth < 44) return null
    return (
      <text
        className="viz__tick rb-bar__value"
        x={bandAt(band) + bandWidth / 2}
        y={pad.top + plotHeight - along(value) - 6}
        textAnchor="middle"
      >
        {formatUnit(value, spec.unit)}
      </text>
    )
  }

  return (
    <>
      <div className="viz" ref={ref}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${spec.title ?? 'Chart'}: ${series.map((s) => s.label).join(', ')}`}
            onMouseLeave={() => setHover(null)}
          >
            {scale.ticks.map((tick) => {
              const at = along(tick)
              return horizontal ? (
                <line
                  key={tick}
                  className="viz__grid"
                  x1={pad.left + at}
                  x2={pad.left + at}
                  y1={pad.top}
                  y2={pad.top + plotHeight}
                />
              ) : (
                <g key={tick}>
                  <line
                    className="viz__grid"
                    x1={pad.left}
                    x2={pad.left + plotWidth}
                    y1={pad.top + plotHeight - at}
                    y2={pad.top + plotHeight - at}
                  />
                  <text
                    className="viz__tick"
                    x={pad.left - 8}
                    y={pad.top + plotHeight - at}
                    textAnchor="end"
                    dy="0.32em"
                  >
                    {formatTick(tick, spec.unit)}
                  </text>
                </g>
              )
            })}

            {Array.from({ length: bands }, (_, band) => (
              <g key={band}>
                {marks(band)}
                {tipLabel(band)}

                {/* The hit target is the whole band, so a 2px bar is as easy to
                    point at as a full-width one. */}
                <rect
                  x={horizontal ? pad.left : bandAt(band)}
                  y={horizontal ? bandAt(band) : pad.top}
                  width={horizontal ? plotWidth : bandWidth}
                  height={horizontal ? bandSize : plotHeight}
                  fill="transparent"
                  onMouseMove={(event) => {
                    const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
                    setHover({
                      band,
                      x: box ? event.clientX - box.left : 0,
                      y: box ? event.clientY - box.top : 0
                    })
                  }}
                />

                {horizontal && (
                  <text
                    className="viz__tick"
                    x={pad.left - 8}
                    y={bandAt(band) + bandSize / 2}
                    textAnchor="end"
                    dy="0.32em"
                  >
                    {clip(spec.labels[band] ?? '', gutter - 12)}
                  </text>
                )}

                {!horizontal && band % labelStep === 0 && (
                  <text
                    className="viz__tick"
                    x={bandAt(band) + bandWidth / 2}
                    y={height - 8}
                    textAnchor="middle"
                  >
                    {clip(spec.labels[band] ?? '', bandWidth * labelStep)}
                  </text>
                )}
              </g>
            ))}

            {/* Only drawn when the data crosses it: on an all-positive chart the
                baseline is the axis and does not need saying twice. */}
            {scale.min < 0 && (
              <line
                className="viz__crosshair"
                x1={horizontal ? pad.left + zero : pad.left}
                x2={horizontal ? pad.left + zero : pad.left + plotWidth}
                y1={horizontal ? pad.top : pad.top + plotHeight - zero}
                y2={horizontal ? pad.top + plotHeight : pad.top + plotHeight - zero}
              />
            )}
          </svg>
        )}

        {hover !== null && (
          <div
            className="viz__tip"
            style={
              hover.x > width / 2
                ? { right: `${Math.max(width - hover.x + 12, 8)}px`, top: `${Math.max(hover.y - 12, 4)}px` }
                : { left: `${hover.x + 12}px`, top: `${Math.max(hover.y - 12, 4)}px` }
            }
          >
            <div className="viz__tip-sub">{spec.labels[hover.band] ?? `#${hover.band + 1}`}</div>
            {series.map((entry, index) => (
              <div className="viz__tip-row" key={`${entry.label}-${index}`}>
                <span className="viz__key" style={{ background: colorAt(index) }} />
                <span className="viz__tip-value">
                  {formatUnit(entry.values[hover.band] ?? 0, spec.unit)}
                </span>
                <span className="viz__tip-label">{entry.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Legend series={series} />
      {spec.stacked && negatives && (
        <div className="rb-note">
          Drawn side by side rather than stacked: a stack containing a negative value
          would not add up to anything.
        </div>
      )}
    </>
  )
}

/** Two measures against each other. Three series at most — see the parser. */
export function RichScatter({ spec }: { spec: ChartSpec }): React.JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<{ series: number; point: number } | null>(null)

  const height = 240
  const pad = { top: 12, right: 14, bottom: 30, left: 56 }
  const plotWidth = Math.max(width - pad.left - pad.right, 10)
  const plotHeight = height - pad.top - pad.bottom

  const xs = spec.series.flatMap((entry) => entry.points.map((point) => point.x))
  const ys = spec.series.flatMap((entry) => entry.points.map((point) => point.y))
  const xScale = useMemo(() => scaleFor(xs), [xs])
  const yScale = useMemo(() => scaleFor(ys), [ys])

  const x = (value: number): number =>
    pad.left + ((value - xScale.min) / (xScale.max - xScale.min || 1)) * plotWidth
  const y = (value: number): number =>
    pad.top + plotHeight - ((value - yScale.min) / (yScale.max - yScale.min || 1)) * plotHeight

  const hovered =
    hover && spec.series[hover.series]?.points[hover.point]
      ? { entry: spec.series[hover.series], point: spec.series[hover.series].points[hover.point] }
      : null

  return (
    <>
      <div className="viz" ref={ref}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={spec.title ?? 'Scatter plot'}>
            {yScale.ticks.map((tick) => (
              <g key={`y${tick}`}>
                <line className="viz__grid" x1={pad.left} x2={pad.left + plotWidth} y1={y(tick)} y2={y(tick)} />
                <text className="viz__tick" x={pad.left - 8} y={y(tick)} textAnchor="end" dy="0.32em">
                  {formatTick(tick, spec.unit)}
                </text>
              </g>
            ))}

            {xScale.ticks.map((tick) => (
              <text key={`x${tick}`} className="viz__tick" x={x(tick)} y={height - 10} textAnchor="middle">
                {formatTick(tick, 'plain')}
              </text>
            ))}

            {spec.series.map((entry, index) =>
              entry.points.map((point, at) => (
                <circle
                  key={`${index}-${at}`}
                  className="viz__dot"
                  cx={x(point.x)}
                  cy={y(point.y)}
                  r={hover?.series === index && hover.point === at ? 6 : 4.5}
                  style={{ fill: colorAt(index) }}
                  onMouseEnter={() => setHover({ series: index, point: at })}
                  onMouseLeave={() => setHover(null)}
                />
              ))
            )}

            {/* Named axes, because a scatter's two measures are not guessable
                from the numbers the way a category axis is. */}
            {spec.xLabel && (
              <text className="viz__tick" x={pad.left + plotWidth / 2} y={height - 1} textAnchor="middle">
                {spec.xLabel}
              </text>
            )}
            {spec.yLabel && (
              <text className="viz__tick" x={pad.left - 48} y={pad.top - 2}>
                {spec.yLabel}
              </text>
            )}
          </svg>
        )}

        {hovered && (
          <div
            className="viz__tip"
            style={
              x(hovered.point.x) > width / 2
                ? { right: `${Math.max(width - x(hovered.point.x) + 12, 8)}px` }
                : { left: `${x(hovered.point.x) + 12}px` }
            }
          >
            {hovered.point.label && <div className="viz__tip-sub">{hovered.point.label}</div>}
            <div className="viz__tip-row">
              <span className="viz__key" style={{ background: colorAt(hover?.series ?? 0) }} />
              <span className="viz__tip-value">
                {formatTick(hovered.point.x, 'plain')}, {formatUnit(hovered.point.y, spec.unit)}
              </span>
              <span className="viz__tip-label">{hovered.entry.label}</span>
            </div>
          </div>
        )}
      </div>

      <Legend series={spec.series} />
    </>
  )
}

/** Line and area go through the panels' own chart, which already reads well. */
export function RichChart({ spec }: { spec: ChartSpec }): React.JSX.Element {
  if (spec.chart === 'scatter') return <RichScatter spec={spec} />
  if (spec.chart === 'bar' || spec.chart === 'column') return <RichBars spec={spec} />

  const labels = spec.labels.length
    ? spec.labels
    : Array.from({ length: Math.max(...spec.series.map((s) => s.values.length)) }, (_, i) =>
        String(i + 1)
      )

  return (
    <TimeChart
      labels={labels}
      series={spec.series.map((entry, index) => ({
        id: `${entry.label}-${index}`,
        label: entry.label,
        values: entry.values,
        // A lone series wears the accent and is filled; several are told apart
        // by the categorical slots, in order.
        slot: spec.series.length === 1 ? undefined : index
      }))}
      format={(value) => formatTick(value, spec.unit)}
    />
  )
}

/**
 * Part-to-whole, as one stacked bar.
 *
 * Not a pie: the eye compares lengths well and angles badly, and two slices of
 * a circle is a sentence written as a picture.
 */
export function RichShare({ spec }: { spec: ShareSpec }): React.JSX.Element {
  const total = spec.segments.reduce((sum, segment) => sum + segment.value, 0)
  const [hover, setHover] = useState<number | null>(null)

  return (
    <div className="rb-share">
      <div className="rb-share__bar" role="img" aria-label={spec.title ?? 'Breakdown'}>
        {spec.segments.map((segment, index) => (
          <div
            key={`${segment.label}-${index}`}
            className="rb-share__part"
            style={{
              flexGrow: Math.max(segment.value, 0),
              background: colorAt(index),
              opacity: hover === null || hover === index ? 1 : 0.45
            }}
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
            title={`${segment.label}: ${formatUnit(segment.value, spec.unit)}`}
          />
        ))}
      </div>

      <div className="rb-share__keys">
        {spec.segments.map((segment, index) => (
          <div
            className="rb-share__key"
            key={`${segment.label}-${index}`}
            data-dim={hover !== null && hover !== index}
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="viz__key" style={{ background: colorAt(index) }} />
            <span className="rb-share__label">{segment.label}</span>
            <span className="rb-share__value">{formatUnit(segment.value, spec.unit)}</span>
            <span className="rb-share__pct">
              {total > 0 ? `${((segment.value / total) * 100).toFixed(total < 1 ? 1 : 0)}%` : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The shape of a series behind a headline number. Never labelled or axed. */
export function Sparkline({ values, unit }: { values: number[]; unit: RichUnit }): React.JSX.Element {
  const width = 76
  const height = 20
  const high = Math.max(...values)
  const low = Math.min(...values)
  const span = high - low || 1

  const points = values
    .map((value, index) => {
      const x = values.length < 2 ? width : (index / (values.length - 1)) * width
      const y = height - 2 - ((value - low) / span) * (height - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg
      className="rb-spark"
      width={width}
      height={height}
      role="img"
      aria-label={`Trend, ${formatUnit(low, unit)} to ${formatUnit(high, unit)}`}
    >
      <polyline points={points} />
    </svg>
  )
}
