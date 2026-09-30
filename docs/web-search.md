# Built-in private web search

Enable web access in the composer's Extras menu for a chat, or in Settings → Web access by default. The default backend is **Built-in private search**. It works inside the desktop app with no account, API key, Docker, Python, browser download or local server. Existing DuckDuckGo settings migrate to this backend. Existing SearXNG and OpenRouter choices are preserved.

The model uses the existing `web_search` and `web_fetch` tools. Search returns numbered titles, direct URLs, snippets, source names and a retrieval timestamp. The model can read a page with `web_fetch` and cite its URL. Results and pages are treated as untrusted data in the web prompt.

## Quality and speed

Brave and DuckDuckGo start together. Bing starts if either fails or there are too few usable results, or after 700 ms if the initial sources are slow. The service keeps each engine's ranking and uses reciprocal rank fusion to promote URLs found by multiple sources. Duplicate results, advertising blocks, search navigation, unsafe URLs and blocked domains are excluded. Search redirectors and common tracking parameters are removed from source URLs.

Once enough results arrive, other active sources have 250 ms to contribute. A source has a 4-second budget, including reading its response, and the overall search has a 6-second deadline. Responses are limited to 2 MB. One slow or broken engine therefore cannot hold the tool open indefinitely. Search transport uses Electron's existing Chromium networking, including system proxy support, without rendering pages or executing their scripts.

## Failures and recovery

A source returning an error, a challenge, changed markup or no usable results yields to the other sources. It enters a 30-second cooldown, doubling on repeated failures to a maximum of five minutes. After cooldown it is eligible again; a successful request clears its failure count. When every source is cooling down, sources are probed in recovery order so that a recently recovered source can still serve the search.

Up to 100 searches are cached in process memory. The exact query, requested result count, source configuration and blocked-domain policy are part of the key. Results less than two minutes old are reused. During an outage, a matching result less than 30 minutes old can be returned with its original timestamp and an explicit stale-result warning. Stale results are never refreshed just because they were read. The cache disappears when the app closes and never enters storage or sync. Identical concurrent requests share work; stopping one chat does not cancel another chat's search. Stopping the last subscriber aborts the network requests.

No search service can promise fresh results when the device is offline or every upstream engine blocks it. With no usable cache, the tool reports the outage clearly. The existing chat tool-error path lets the assistant continue and explain the limitation; it must not equate an outage with proof that no matching pages exist or fabricate current facts.

## Privacy and optional backends

Built-in requests use an isolated, nonpersistent Electron session with disk caching disabled, omitted credentials and no cookies or referrer. No app logs of queries or responses are added. Engines still receive the query and the device's public IP address; this is private metasearch, not offline search or IP anonymization. Search queries and returned snippets become part of the chat tool transcript, including optional encrypted chat sync, and are provided to the chosen chat model.

For SearXNG, configure your own instance URL and enable `json` in its `search.formats`. URLs served under a reverse-proxy subpath are supported. SearXNG is tried first; a fast response with enough results avoids direct engine requests. Brave, DuckDuckGo and Bing are available as fallbacks when the instance fails, returns too few results or takes more than 700 ms. This means queries can go directly to those engines under those conditions, as explained in Settings. Localhost is permitted for this user-configured service only, not as a source page for `web_fetch`.

OpenRouter's billed web plugin is still available for users who explicitly select it. The free search service never automatically enables it and never sends queries to random public proxy instances.

## Research and implementation choice

Evaluated against quality, resilience, speed and desktop installation friction:

| Option | Strength | Desktop tradeoff |
| --- | --- | --- |
| [SearXNG](https://docs.searxng.org/dev/search_api.html) | Maintained metasearch with a JSON API and many upstream engines | A separately installed Python service or container. Retained as an optional source. |
| [DDGS](https://github.com/deedy5/ddgs) | Python metasearch library with multiple free sources and an API server | Still needs Python and additional dependencies. Its upstream scrapers remain subject to engine outages. |
| [OneSearch MCP](https://github.com/yokingma/one-search-mcp) | Local browser search and several provider integrations | Requires browser automation and an additional MCP process; it does not directly fit the built-in tool lifecycle. |
| Native engine adapters plus [Cheerio](https://github.com/cheeriojs/cheerio) | Fits the existing Electron runtime and tool flow, with no extra user setup | Small engine-specific selectors must be maintained as upstream markup changes. |

The implementation uses the off-the-shelf MIT-licensed Cheerio DOM parser rather than fragile HTML regular expressions, and Electron's [session networking](https://www.electronjs.org/docs/latest/api/net) rather than a new browser runtime. Adapters are deliberately small and separate from scheduling, ranking, caching and health so one engine can be repaired or replaced independently. No upstream SearXNG or DDGS implementation code is vendored.

Initial live endpoint research from the development machine found Brave, Bing and DuckDuckGo returning search pages in approximately 0.4–0.8 seconds. Google returned a page without usable result markup and Mojeek returned a CAPTCHA; neither is required by the default service. These observations are not an uptime guarantee or a broad relevance benchmark. Parser fixtures and deterministic outage tests are included for cloud execution; upstream availability and markup will need ongoing maintenance.
