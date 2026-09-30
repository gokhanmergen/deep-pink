import { load } from 'cheerio/slim'

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchProvider {
  /** Includes the instance URL for self-hosted sources, so health is independent. */
  id: string
  name: string
  search(query: string, signal: AbortSignal): Promise<SearchResult[]>
}

export type SearchFetch = (url: URL, signal: AbortSignal, json?: boolean) => Promise<string>

const text = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** Only unwrap known search redirectors, never arbitrary destination parameters. */
export function resultUrl(raw: string, base: string): string | null {
  if (!raw.trim() || raw.length > 8192) return null
  try {
    let url = new URL(raw, base)
    if (url.hostname === 'duckduckgo.com' && url.pathname === '/l/') {
      url = new URL(url.searchParams.get('uddg') ?? '')
    } else if (url.hostname === 'www.bing.com' && url.pathname === '/ck/a') {
      const wrapped = url.searchParams.get('u') ?? ''
      url = new URL(wrapped.startsWith('a1')
        ? Buffer.from(wrapped.slice(2), 'base64url').toString('utf8')
        : wrapped)
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    // Search navigation, ads and challenges are not sources for an answer.
    if (['duckduckgo.com', 'html.duckduckgo.com', 'www.bing.com', 'search.brave.com'].includes(url.hostname)) {
      return null
    }
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key)
    }
    return url.href
  } catch {
    return null
  }
}

/** DOM selectors survive attribute ordering, quoting and nested markup changes. */
export function parseSearchHtml(engine: 'brave' | 'duckduckgo' | 'bing', html: string): SearchResult[] {
  const $ = load(html)
  $('script, style, noscript').remove()
  const results: SearchResult[] = []
  const base = engine === 'brave' ? 'https://search.brave.com'
    : engine === 'bing' ? 'https://www.bing.com' : 'https://duckduckgo.com'
  const selector = engine === 'brave' ? '.snippet[data-type="web"]'
    : engine === 'bing' ? '#b_results .b_algo' : '.result'

  $(selector).each((_i, element) => {
    const block = $(element)
    if (block.is('.result--ad') || block.find('.result__badge').text().trim() === 'Ad') return
    const title = engine === 'brave' ? block.find('.search-snippet-title').first()
      : engine === 'bing' ? block.find('h2 a').first() : block.find('a.result__a').first()
    const link = engine === 'brave' ? title.closest('a') : title
    const href = link.attr('href')
    const url = href ? resultUrl(href, base) : null
    if (!url) return
    const snippet = engine === 'brave' ? block.find('.generic-snippet .content').first().text()
      : engine === 'bing' ? block.find('.b_caption p, .b_lineclamp2, .b_lineclamp3').first().text()
        : block.find('.result__snippet').first().text()
    results.push({ title: text(title.text()), url, snippet: text(snippet) })
  })
  return results.slice(0, 10)
}

export function builtInProviders(fetchText: SearchFetch): SearchProvider[] {
  return (['brave', 'duckduckgo', 'bing'] as const).map((engine) => ({
    id: engine,
    name: { brave: 'Brave', duckduckgo: 'DuckDuckGo', bing: 'Bing' }[engine],
    async search(query, signal) {
      const url = new URL(engine === 'brave' ? 'https://search.brave.com/search'
        : engine === 'bing' ? 'https://www.bing.com/search' : 'https://html.duckduckgo.com/html/')
      url.searchParams.set('q', query)
      if (engine === 'brave') url.searchParams.set('source', 'web')
      if (engine === 'bing') {
        url.searchParams.set('setlang', 'en')
        url.searchParams.set('mkt', 'en-US')
      }
      return parseSearchHtml(engine, await fetchText(url, signal))
    }
  }))
}

export function searxngProvider(instance: string, fetchText: SearchFetch): SearchProvider {
  return {
    id: `searxng:${instance}`,
    name: 'SearXNG',
    async search(query, signal) {
      const base = new URL(instance)
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
        throw new Error('SearXNG needs an http(s) instance URL without credentials.')
      }
      // Preserve a reverse proxy's subpath rather than resolving /search at the root.
      base.pathname = `${base.pathname.replace(/\/$/, '')}/search`
      base.search = ''
      base.hash = ''
      base.searchParams.set('q', query)
      base.searchParams.set('format', 'json')
      base.searchParams.set('categories', 'general')
      const body: unknown = JSON.parse(await fetchText(base, signal, true))
      if (!body || typeof body !== 'object' || !('results' in body) || !Array.isArray(body.results)) {
        throw new Error('SearXNG did not return a JSON results array. Enable the json search format.')
      }
      return body.results.flatMap((row: unknown): SearchResult[] => {
        if (!row || typeof row !== 'object') return []
        const r = row as Record<string, unknown>
        if (typeof r.url !== 'string' || typeof r.title !== 'string') return []
        const url = resultUrl(r.url, instance)
        if (!url) return []
        return [{ title: text(load(r.title).text()), url,
          snippet: typeof r.content === 'string' ? text(load(r.content).text()) : '' }]
      }).slice(0, 10)
    }
  }
}
