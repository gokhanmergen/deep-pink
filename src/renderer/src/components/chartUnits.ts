import type { ChartUnit } from '@shared/charts'
import { formatCost, formatDuration, formatTokens } from '../format'

/**
 * How a number in a chart is written.
 *
 * The unit comes from the model, so it is a hint about what the number means —
 * never a licence to print arbitrary text. Every branch here ends in a number
 * this app formatted.
 */

function plain(value: number): string {
  const rounded = Math.abs(value) < 1 && value !== 0 ? Number(value.toPrecision(2)) : value
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function bytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = Math.abs(value)
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index++
  }
  const sign = value < 0 ? '-' : ''
  return `${sign}${size.toFixed(size < 10 && index > 0 ? 1 : 0)} ${units[index]}`
}

export function formatUnit(value: number, unit: ChartUnit): string {
  if (!Number.isFinite(value)) return '—'
  switch (unit) {
    case 'usd':
      return formatCost(value)
    case 'percent':
      return `${plain(value)}%`
    case 'bytes':
      return bytes(value)
    case 'ms':
      return formatDuration(Math.round(value))
    case 'tokens':
      return formatTokens(Math.round(value))
    default:
      return plain(value)
  }
}

/** Axis ticks are terser than values in a tooltip — the unit is in the title. */
export function formatTick(value: number, unit: ChartUnit): string {
  if (unit === 'plain' || unit === 'tokens') return formatTokens(Math.round(value))
  return formatUnit(value, unit)
}
