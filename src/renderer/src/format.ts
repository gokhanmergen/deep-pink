/**
 * Date formatters, built once.
 *
 * `toLocaleString` looks free and is not: each call resolves a locale and
 * builds a formatter, and the sidebar runs several per thread on every render.
 * With a few hundred threads that alone cost about 100ms per thread switch.
 * Holding the formatters here makes the same work roughly thirty times cheaper.
 *
 * The locale is resolved at load, so a system locale change lands on restart.
 */
const DAY_AND_MONTH = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const MONTH_AND_YEAR = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Costs here are often fractions of a cent, so keep enough precision to be honest. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(5)}`
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function formatNumber(n: number): string {
  return n.toLocaleString()
}

export function formatRelative(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`
  return DAY_AND_MONTH.format(timestamp)
}

/**
 * The same idea as `formatRelative` with the words taken out, for places that
 * show two timestamps side by side and have room for neither in full.
 */
export function formatRelativeShort(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`
  return DAY_AND_MONTH.format(timestamp)
}

export function formatDateTime(timestamp: number): string {
  return FULL.format(timestamp)
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/** Groups threads into the buckets the sidebar shows. */
export function dateBucket(timestamp: number): string {
  const now = new Date()
  const then = new Date(timestamp)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000

  if (timestamp >= startOfToday) return 'Today'
  if (timestamp >= startOfToday - day) return 'Yesterday'
  if (timestamp >= startOfToday - 7 * day) return 'Previous 7 days'
  if (timestamp >= startOfToday - 30 * day) return 'Previous 30 days'
  return MONTH_AND_YEAR.format(then)
}

export function modelShortName(id: string): string {
  const slash = id.indexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}
