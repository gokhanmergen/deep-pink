import { isIP } from 'node:net'
import type { SearchProvider, SearchResult } from './providers'

export interface RankedResult extends SearchResult {
  sources: string[]
}

export interface SearchResponse {
  results: RankedResult[]
  searchedAt: number
  cached: boolean
  stale: boolean
  unavailable: string[]
}

interface Request {
  query: string
  limit: number
  providers: SearchProvider[]
  blockedDomains: string[]
  /** Give a configured private instance a head start before sending to direct sources. */
  preferFirst?: boolean
  signal?: AbortSignal
}

interface Health {
  failures: number
  retryAt: number
}

interface Flight {
  promise: Promise<SearchResponse>
  controller: AbortController
  users: number
}

interface Options {
  now?: () => number
  hedgeMs?: number
  mergeMs?: number
  providerTimeoutMs?: number
  deadlineMs?: number
  freshMs?: number
  staleMs?: number
  cooldownMs?: number
}

function publicResult(url: URL, blocked: string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (blocked.some((d) => host === d || host.endsWith(`.${d}`))) return false
  // Sources must be public; local SearXNG is an explicitly configured transport, not a result.
  if (isIP(host) === 4 && /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|198\.1[89]\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/.test(host)) return false
  if (isIP(host) === 6 && /^(::|fc|fd|fe[89ab]|ff)/i.test(host)) return false
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
}

/** Reciprocal rank fusion rewards agreement while preserving each source's ranking. */
export function rankResults(
  batches: { name: string; results: SearchResult[] }[],
  blockedDomains: string[],
  limit: number
): RankedResult[] {
  const blocked = blockedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean)
  const hits = new Map<string, RankedResult & { score: number }>()
  for (const batch of batches) {
    const seen = new Set<string>()
    batch.results.slice(0, 10).forEach((result, rank) => {
      try {
        const url = new URL(result.url)
        if (!publicResult(url, blocked) || !result.title.trim()) return
        url.hash = ''
        // http/https and www variants are normally the same document.
        const key = `${url.host.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}${url.search}`
        if (seen.has(key)) return
        seen.add(key)
        const score = 1 / (60 + rank + 1)
        const existing = hits.get(key)
        if (existing) {
          existing.score += score
          if (!existing.sources.includes(batch.name)) existing.sources.push(batch.name)
          if (result.snippet.length > existing.snippet.length) existing.snippet = result.snippet.slice(0, 1500)
          if (url.protocol === 'https:') existing.url = url.href
        } else {
          hits.set(key, { title: result.title.trim().slice(0, 300), url: url.href,
            snippet: result.snippet.trim().slice(0, 1500), sources: [batch.name], score })
        }
      } catch { /* A malformed result must not discard the other sources. */ }
    })
  }
  return [...hits.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, limit).map(({ score: _score, ...result }) => result)
}

/** All state is bounded and in memory; nothing is written to disk or synced. */
export class SearchService {
  private readonly cache = new Map<string, SearchResponse>()
  private readonly health = new Map<string, Health>()
  private readonly flights = new Map<string, Flight>()
  private readonly options: Required<Options>

  constructor(options: Options = {}) {
    this.options = {
      now: Date.now, hedgeMs: 700, mergeMs: 250, providerTimeoutMs: 4000,
      deadlineMs: 6000, freshMs: 120_000, staleMs: 1_800_000, cooldownMs: 30_000,
      ...options
    }
  }

  async search(request: Request): Promise<SearchResponse> {
    request.signal?.throwIfAborted()
    const key = JSON.stringify([request.query, request.limit, Boolean(request.preferFirst), request.providers.map((p) => p.id),
      request.blockedDomains.map((d) => d.trim().toLowerCase()).sort()])
    const cached = this.cache.get(key)
    const age = cached ? this.options.now() - cached.searchedAt : Infinity
    if (cached && age < this.options.freshMs) return { ...cached, cached: true }
    if (cached && age >= this.options.staleMs) this.cache.delete(key)

    let flight = this.flights.get(key)
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController()
      const promise = this.searchLive(request, controller.signal).then((response) => {
        this.cache.delete(key)
        this.cache.set(key, response)
        if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!)
        return response
      }).catch((err: unknown) => {
        // Cancellation must never turn into an offline cache response.
        controller.signal.throwIfAborted()
        if (cached && this.options.now() - cached.searchedAt < this.options.staleMs) {
          return { ...cached, cached: true, stale: true,
            unavailable: request.providers.map((p) => p.name) }
        }
        throw err
      }).finally(() => {
        if (this.flights.get(key) === current) this.flights.delete(key)
      })
      const current: Flight = { controller, users: 0, promise }
      flight = current
      this.flights.set(key, flight)
    }
    // Two comparison panes can share work; stopping one must not cancel the other.
    flight.users++
    const current = flight
    let removeListener: (() => void) | undefined
    return new Promise<SearchResponse>((resolve, reject) => {
      const aborted = (): void => reject(request.signal?.reason ?? new Error('Search cancelled.'))
      request.signal?.addEventListener('abort', aborted, { once: true })
      removeListener = () => request.signal?.removeEventListener('abort', aborted)
      current.promise.then(resolve, reject)
      if (request.signal?.aborted) aborted()
    }).finally(() => {
      removeListener?.()
      current.users--
      if (current.users === 0) current.controller.abort()
    })
  }

  private searchLive(request: Request, parent: AbortSignal): Promise<SearchResponse> {
    const { now, hedgeMs, mergeMs, providerTimeoutMs, deadlineMs, cooldownMs } = this.options
    const available = request.providers.filter((p) => (this.health.get(p.id)?.retryAt ?? 0) <= now())
    // If all circuits are open, probe in recovery order. Do not let a cooldown
    // on every source prevent finding one that has already recovered.
    const queue = available.length ? [...available] : [...request.providers]
      .sort((a, b) => (this.health.get(a.id)?.retryAt ?? 0) - (this.health.get(b.id)?.retryAt ?? 0))
    const unavailable = new Set(request.providers.filter((p) => !queue.includes(p)).map((p) => p.name))

    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      const batches: { name: string; results: SearchResult[] }[] = []
      let active = 0
      let done = false
      let grace: ReturnType<typeof setTimeout> | undefined
      let hedge: ReturnType<typeof setTimeout> | undefined
      const finished = (): void => {
        if (done) return
        done = true
        clearTimeout(deadline)
        clearTimeout(hedge)
        clearTimeout(grace)
        parent.removeEventListener('abort', cancelled)
        controller.abort()
        if (parent.aborted) { reject(parent.reason); return }
        const results = rankResults(batches, request.blockedDomains, request.limit)
        if (results.length) resolve({ results, searchedAt: now(), cached: false, stale: false,
          unavailable: [...unavailable] })
        else reject(new Error(
          'Web search is temporarily unavailable or returned no usable public results. ' +
          'Check your connection or try a different query shortly. ' +
          `Sources: ${request.providers.map((p) => p.name).join(', ')}. ` +
          'This does not establish that no matching pages exist.'
        ))
      }
      const cancelled = (): void => finished()
      const deadline = setTimeout(finished, deadlineMs)
      parent.addEventListener('abort', cancelled, { once: true })

      const launch = (): void => {
        const provider = queue.shift()
        if (!provider || done) return
        active++
        const timed = AbortSignal.any([controller.signal, AbortSignal.timeout(providerTimeoutMs)])
        // Race even injected transports that ignore AbortSignal: the deadline is real.
        const work = new Promise<SearchResult[]>((accept, fail) => {
          const aborted = (): void => fail(timed.reason)
          timed.addEventListener('abort', aborted, { once: true })
          Promise.resolve().then(() => provider.search(request.query, timed)).then(accept, fail)
            .finally(() => timed.removeEventListener('abort', aborted))
        })
        work.then((results) => {
          if (done) return
          if (!rankResults([{ name: provider.name, results }], [], 10).length) {
            throw new Error('No usable results (empty response, challenge or changed markup).')
          }
          this.health.delete(provider.id)
          batches.push({ name: provider.name, results })
        }).catch(() => {
          if (done || parent.aborted) return
          unavailable.add(provider.name)
          const failures = Math.min((this.health.get(provider.id)?.failures ?? 0) + 1, 5)
          this.health.set(provider.id, { failures, retryAt: now() + Math.min(cooldownMs * 2 ** (failures - 1), 300_000) })
          if (this.health.size > 100) this.health.delete(this.health.keys().next().value!)
        }).finally(() => {
          active--
          if (done) return
          const enough = rankResults(batches, request.blockedDomains, request.limit).length >= request.limit
          if (enough) {
            if (!active) finished()
            else if (!grace) grace = setTimeout(finished, mergeMs)
          } else if (queue.length) launch()
          else if (!active) finished()
        })
      }
      if (parent.aborted) { finished(); return }
      launch()
      if (!request.preferFirst || !available.some((p) => p.id === request.providers[0]?.id)) launch()
      hedge = setTimeout(launch, hedgeMs)
      if (!active) finished()
    })
  }
}
