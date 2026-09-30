import { session } from 'electron'
import type { SearchFetch } from './providers'

const MAX_RESPONSE_BYTES = 2_000_000

/** No windows, page scripts, disk cache, app cookies, credentials or referrers. */
export const fetchSearchPage: SearchFetch = async (url, signal, json = false) => {
  signal.throwIfAborted()
  const isolated = session.fromPartition('deep-pink-private-search', { cache: false })
  const response = await isolated.fetch(url.href, {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    headers: {
      Accept: json ? 'application/json' : 'text/html',
      'Cache-Control': 'no-store',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
    }
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status}`)
  }
  if (!response.body) throw new Error('Empty search response.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let output = ''
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Search response exceeds the size limit.')
      output += decoder.decode(value, { stream: true })
    }
    return output + decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
