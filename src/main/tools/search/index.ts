import type { WebSearchSettings } from '@shared/types'
import { builtInProviders, searxngProvider } from './providers'
import { fetchSearchPage } from './network'
import { SearchService } from './service'

const service = new SearchService()
const builtIn = builtInProviders(fetchSearchPage)

export async function searchWeb(
  query: string, limit: number, settings: WebSearchSettings, signal?: AbortSignal
): Promise<string> {
  const providers = settings.engine === 'searxng'
    ? [searxngProvider(settings.searxngUrl, fetchSearchPage), ...builtIn] : builtIn
  const response = await service.search({ query, limit, providers,
    blockedDomains: settings.blockedDomains, preferFirst: settings.engine === 'searxng', signal })
  const header = [
    `Search: ${JSON.stringify(query)}`,
    `Retrieved: ${new Date(response.searchedAt).toISOString()}${response.cached ? ' (memory cache)' : ''}`,
    response.stale
      ? 'WARNING: Live search is unavailable. These are older cached results; verify time-sensitive claims before using them.'
      : response.unavailable.length
        ? `Automatic fallback: ${response.unavailable.join(', ')} unavailable; results from working sources below.` : null
  ].filter(Boolean).join('\n')
  return `${header}\n\n${response.results.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}\n   Sources: ${r.sources.join(', ')}`
  ).join('\n\n')}`
}
