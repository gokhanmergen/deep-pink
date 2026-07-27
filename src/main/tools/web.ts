import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { WebSearchSettings } from '@shared/types'
import type { ToolParam } from '../providers/openrouter'

/**
 * Web search and fetch. Both are off unless the user turns web access on, and
 * both are ordinary tools the model must choose to call — nothing here runs in
 * the background.
 */

export const WEB_SEARCH_TOOL: ToolParam = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web and return titles, URLs and short snippets. Use when the answer depends on current information or on something outside your knowledge.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        max_results: {
          type: 'integer',
          description: 'How many results to return (1-10).',
          minimum: 1,
          maximum: 10
        }
      },
      required: ['query'],
      additionalProperties: false
    }
  }
}

export const WEB_FETCH_TOOL: ToolParam = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its readable text content. Use to read a page found via web_search or a URL the user gave you.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
        max_chars: {
          type: 'integer',
          description: 'Maximum characters of text to return.'
        }
      },
      required: ['url'],
      additionalProperties: false
    }
  }
}

export const WEB_PROMPT_SEGMENT = `Web access is enabled. You have two tools:
- \`web_search\` finds pages; it returns snippets, not full text.
- \`web_fetch\` reads a specific URL.

Search before answering questions about current events, versions, prices or anything you are unsure of. Fetch a page when a snippet is not enough. Cite the URLs you used.`

/* ------------------------------------------------------------------ *
 * Safety
 * ------------------------------------------------------------------ */

const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|198\.1[89]\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return PRIVATE_V4.test(address)
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase()
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80')
    )
  }
  return false
}

/**
 * Refuses anything that is not public http(s). Without this, a model could be
 * talked into reading the user's LAN or cloud metadata endpoints.
 */
async function assertFetchable(rawUrl: string, blockedDomains: string[]): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refusing to fetch ${url.protocol} — only http and https are allowed.`)
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Refusing to fetch a loopback or link-local address.')
  }

  if (blockedDomains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`))) {
    throw new Error(`${host} is on your blocked-domains list.`)
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Refusing to fetch a private IP address.')
    return url
  }

  try {
    const resolved = await lookup(host, { all: true })
    if (resolved.some((entry) => isPrivateAddress(entry.address))) {
      throw new Error(`${host} resolves to a private address; refusing to fetch.`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('refusing')) throw err
    // DNS failures are handled by the fetch itself.
  }

  return url
}

/* ------------------------------------------------------------------ *
 * HTML → text
 * ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  '#39': "'"
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[entity] ?? match
  })
}

/** Good-enough readability extraction: no DOM, no dependency. */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<[^>]+>/g, ' ')

  text = decodeEntities(text)

  return text
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match ? decodeEntities(match[1]).trim() : null
}

/* ------------------------------------------------------------------ *
 * Search backends
 * ------------------------------------------------------------------ */

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function searchDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`)

  const html = await res.text()
  const results: SearchResult[] = []
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi

  let match: RegExpExecArray | null
  while ((match = blockRe.exec(html)) !== null && results.length < limit) {
    let url = decodeEntities(match[1])
    // DDG wraps hits in a redirector; unwrap to the real destination.
    const wrapped = /[?&]uddg=([^&]+)/.exec(url)
    if (wrapped) url = decodeURIComponent(wrapped[1])
    if (url.startsWith('//')) url = `https:${url}`

    const title = htmlToText(match[2])
    const after = html.slice(match.index, match.index + 2500)
    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(after)

    results.push({
      title,
      url,
      snippet: snippetMatch ? htmlToText(snippetMatch[1]) : ''
    })
  }

  return results
}

async function searchSearxng(
  query: string,
  limit: number,
  instanceUrl: string
): Promise<SearchResult[]> {
  const url = new URL('/search', instanceUrl)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}`)

  const body = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[]
  }
  return (body.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? ''
  }))
}

/* ------------------------------------------------------------------ *
 * Tool implementations
 * ------------------------------------------------------------------ */

export async function runWebSearch(
  args: { query?: string; max_results?: number },
  settings: WebSearchSettings
): Promise<string> {
  const query = (args.query ?? '').trim()
  if (!query) throw new Error('web_search requires a `query`.')

  const limit = Math.min(Math.max(args.max_results ?? settings.maxResults, 1), 10)
  const results =
    settings.engine === 'searxng'
      ? await searchSearxng(query, limit, settings.searxngUrl)
      : await searchDuckDuckGo(query, limit)

  if (!results.length) return `No results for "${query}".`

  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join('\n\n')
}

export async function runWebFetch(
  args: { url?: string; max_chars?: number },
  settings: WebSearchSettings
): Promise<string> {
  const target = await assertFetchable(args.url ?? '', settings.blockedDomains)
  const limit = Math.min(args.max_chars ?? settings.fetchCharLimit, 200_000)

  const res = await fetch(target, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) throw new Error(`${target.href} returned HTTP ${res.status}`)

  const contentType = res.headers.get('content-type') ?? ''
  const raw = await res.text()

  let text: string
  let title: string | null = null
  if (contentType.includes('html')) {
    title = extractTitle(raw)
    text = htmlToText(raw)
  } else if (contentType.includes('json')) {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      text = raw
    }
  } else {
    text = raw
  }

  const truncated = text.length > limit
  const header = [`URL: ${target.href}`, title ? `Title: ${title}` : null]
    .filter(Boolean)
    .join('\n')

  return `${header}\n\n${text.slice(0, limit)}${
    truncated ? `\n\n[truncated at ${limit} characters of ${text.length}]` : ''
  }`
}
