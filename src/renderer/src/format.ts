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
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
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
  return then.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function modelShortName(id: string): string {
  const slash = id.indexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}
