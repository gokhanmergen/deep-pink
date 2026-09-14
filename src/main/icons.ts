import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { BUNDLED_ICONS } from './modelIconData'

/**
 * Brand marks for the model that answered.
 *
 * A model id is `author/model`, and the author is the part worth showing at a
 * glance: which house wrote this, not which of its twenty versions. OpenRouter
 * serves those marks as site assets — and only as site assets. There is no
 * icon field anywhere in its API; I looked, in `/api/v1/models` and in
 * `/api/v1/providers`, and neither carries one.
 *
 * So this is a resolver rather than a lookup, and it is written to be wrong
 * gracefully. The filenames are inconsistent (`Anthropic.svg`, `DeepSeek.png`,
 * `DeepInfra.webp`), the capitalisation does not follow from the slug
 * (`openai` is `OpenAI`, `meta-llama` is `Meta`, `google` is `GoogleGemini`),
 * and several large authors have no mark at all — xAI, NVIDIA and Z-AI among
 * them. A missing icon is therefore an ordinary outcome and not a failure,
 * which is why the renderer's fallback is a designed thing rather than a gap.
 *
 * Where OpenRouter has nothing, the author's own site is asked for its own
 * favicon — which is the only place in this app that talks to a host other
 * than OpenRouter without being told to. It is one request, once per author
 * ever, to the company whose model you are already sending your words to, and
 * it is what puts a mark on Z.AI, xAI and NVIDIA.
 *
 * Each author is fetched once and kept on disk; misses are remembered too, or
 * every start would re-ask for the same dozen files that do not exist.
 */

/**
 * Where the slug's own capitalisation is not what the file is called.
 *
 * Every entry here has been fetched and seen to exist. Guessing a name that
 * does not is not free — it is three requests, one per extension, before the
 * miss is recorded — so an entry that is merely plausible costs more than
 * leaving the slug to the general guess below.
 *
 * Authors deliberately absent, having been checked and found to have no mark
 * under any spelling: x-ai (tried xAI, XAI, SpaceXAI, Grok), z-ai (ZAI, Z.AI,
 * Z.ai, Zai, Zhipu, ZhipuAI), nvidia, inflection, minimax, bytedance, ai21,
 * liquid, reka. OpenRouter's own page data agrees — it carries an
 * `author_icon_uri` for each of them and every one is null.
 */
const NAMED: Record<string, string> = {
  openai: 'OpenAI',
  'meta-llama': 'Meta',
  meta: 'Meta',
  mistralai: 'Mistral',
  google: 'GoogleGemini',
  'google-vertex': 'GoogleVertex',
  deepseek: 'DeepSeek',
  moonshotai: 'MoonshotAI',
  amazon: 'Bedrock'
}

/**
 * The extensions to try, in the order they are worth trying.
 *
 * SVG first because it is the one that stays sharp at sixteen pixels, which is
 * the only size any of these are ever drawn at.
 */
const EXTENSIONS = ['svg', 'png', 'webp'] as const

const MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp'
}

/** Long enough that a miss is not re-asked all week; short enough to heal. */
const REMEMBER_A_MISS_FOR = 7 * 24 * 60 * 60 * 1000

interface Known {
  /** The data URL, or null for an author nothing here could find a mark for. */
  url: string | null
  checkedAt: number
  /** Which set of sources produced this answer. See `STRATEGY`. */
  by?: number
}

/**
 * Bumped whenever where-we-look changes.
 *
 * A miss is a statement about the places that were searched, not about the
 * author — so when a new place is added, every previous miss becomes a claim
 * nobody checked. This is how they are thrown away. Hits are kept: a mark that
 * was found is still a mark.
 *
 * 1 — OpenRouter's icon directory only.
 * 2 — and the author's own favicon.
 * 3 — and the bundled set, which is looked at first.
 */
const STRATEGY = 3

let index: Record<string, Known> | null = null

function indexPath(): string {
  return join(app.getPath('userData'), 'model-icons.json')
}

function load(): Record<string, Known> {
  if (index) return index
  try {
    index = JSON.parse(readFileSync(indexPath(), 'utf8')) as Record<string, Known>
  } catch {
    index = {}
  }
  return index
}

function save(): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(indexPath(), JSON.stringify(index ?? {}))
  } catch {
    // A cache that cannot be written is a cache that is fetched again. The
    // icons still appear; they just cost a request per start.
  }
}

/**
 * `anthropic/claude-sonnet-4.5` → `anthropic`.
 *
 * The leading `~` is OpenRouter's mark for an alias that always points at an
 * author's newest model — `~z-ai/glm-flash-latest`, `~openai/gpt-astra-latest`.
 * It is not part of the author's name, and leaving it on meant sixteen models
 * asked about seven authors that do not exist, got nothing, and cached the
 * nothing. The `:free` and `:batch` suffixes are on the model rather than the
 * author and never reached this.
 */
export function authorOf(modelId: string): string {
  const bare = modelId.replace(/^~/, '')
  const slash = bare.indexOf('/')
  return (slash === -1 ? bare : bare.slice(0, slash)).toLowerCase()
}

/**
 * What the file might be called, best guess first.
 *
 * The mapping above covers what is known; the guesses after it are for authors
 * that arrive later. Capitalising the slug is right often enough to be worth
 * one request, and wrong cheaply.
 */
function candidates(slug: string): string[] {
  const guesses = new Set<string>()
  if (NAMED[slug]) guesses.add(NAMED[slug])

  // `mistral-ai` → `MistralAi`, and the same without the separators.
  const parts = slug.split(/[-_.]/).filter(Boolean)
  const titled = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  guesses.add(titled)
  guesses.add(parts[0].charAt(0).toUpperCase() + parts[0].slice(1))

  return [...guesses]
}

/**
 * Fetches a URL and returns it as a data URL, or null if it is not an image.
 *
 * The content type is checked rather than trusted from the extension because
 * both sources here answer a miss with a 200 and an HTML page — OpenRouter's
 * 404 route, and every site that serves its app shell for an unknown path. A
 * 200 carrying `text/html` is a miss wearing a hit's clothes.
 */
/** Found it, or looked and did not — which are not the same as failing to look. */
interface Lookup {
  url: string | null
  /** False when the network could not be reached, so nothing was learned. */
  reachable: boolean
}

async function asDataUrl(url: string, fallbackMime?: string): Promise<Lookup> {
  try {
    const response = await fetch(url, { redirect: 'follow' })
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim()
    if (!response.ok) return { url: null, reachable: true }
    if (!type.startsWith('image/') && !fallbackMime) return { url: null, reachable: true }

    const bytes = Buffer.from(await response.arrayBuffer())
    // Nothing legitimate here is large, and an empty body is a site answering
    // politely rather than having an icon — ai21.com serves a 200 of 0 bytes.
    if (!bytes.length || bytes.length > 512 * 1024) return { url: null, reachable: true }

    const mime = type.startsWith('image/') ? type : fallbackMime
    return { url: `data:${mime};base64,${bytes.toString('base64')}`, reachable: true }
  } catch {
    // Offline, or the host does not resolve. Nothing was learned about whether
    // a mark exists, which is the distinction the cache needs.
    return { url: null, reachable: false }
  }
}

/** OpenRouter's own mark for the author, if it has one. */
async function fromOpenRouter(slug: string): Promise<Lookup> {
  let reachable = false
  for (const name of candidates(slug)) {
    for (const ext of EXTENSIONS) {
      const found = await asDataUrl(`https://openrouter.ai/images/icons/${name}.${ext}`, MIME[ext])
      reachable = reachable || found.reachable
      if (found.url) return found
    }
  }
  return { url: null, reachable }
}

/**
 * Where an author lives, so its own site can be asked for its own mark.
 *
 * `/api/v1/providers` is a documented endpoint and it carries policy and
 * status URLs — which is not a homepage, but the host of one is the host of
 * the other. Many model authors are also inference providers under the same
 * slug, so this covers z-ai, nvidia, minimax, ai21, baidu, liquid and reka
 * without anything being written down here.
 *
 * Fetched once per session. It is a list of a hundred names and it changes
 * about as often as the company list of an industry.
 */
let providerHosts: Map<string, string> | null = null

async function hostsBySlug(): Promise<Map<string, string>> {
  if (providerHosts) return providerHosts
  providerHosts = new Map()
  try {
    const response = await fetch('https://openrouter.ai/api/v1/providers')
    if (!response.ok) return providerHosts
    const body = (await response.json()) as {
      data?: { slug?: string; privacy_policy_url?: string; terms_of_service_url?: string }[]
    }
    for (const entry of body.data ?? []) {
      const url = entry.privacy_policy_url ?? entry.terms_of_service_url
      if (!entry.slug || !url) continue
      try {
        providerHosts.set(entry.slug, new URL(url).hostname.replace(/^www\./, ''))
      } catch {
        // A URL that is not one tells us nothing about where they live.
      }
    }
  } catch {
    // No list means no fallback hosts, which means a lettered badge. Fine.
  }
  return providerHosts
}

/** The registrable part of a host: `chat.z.ai` is really `z.ai`. */
function parentDomain(host: string): string | null {
  const parts = host.split('.')
  return parts.length > 2 ? parts.slice(-2).join('.') : null
}

const FAVICONS = ['/favicon.svg', '/favicon.ico', '/favicon.png', '/apple-touch-icon.png']

/**
 * The author's own favicon, for the ones OpenRouter has no mark for.
 *
 * This is the only thing in the app that talks to a host other than OpenRouter
 * without being asked to — one request per author, once, and never again once
 * the answer is known. It asks the author's own site rather than a favicon
 * service, so the only party that learns anything is the company whose model
 * you are already sending your words to.
 */
async function fromTheirSite(slug: string): Promise<Lookup> {
  const hosts: string[] = []

  const known = (await hostsBySlug()).get(slug)
  if (known) {
    hosts.push(known)
    const parent = parentDomain(known)
    if (parent) hosts.push(parent)
  }

  // `z-ai` is `z.ai` and `x-ai` is `x.ai`. Worth one guess for the authors that
  // sell a model without also serving one, which is how xAI is missed above.
  if (slug.includes('-')) {
    const dotted = slug.replace(/-/g, '.')
    if (!hosts.includes(dotted)) hosts.push(dotted)
  }

  // A host that does not resolve is a host, not a network failure: plenty of
  // these guesses are simply wrong. Only say nothing was learned if there was
  // nowhere to ask in the first place.
  let reachable = hosts.length === 0
  for (const host of hosts) {
    for (const path of FAVICONS) {
      // ICO is not served with an `image/` type everywhere, and it is the one
      // extension here whose own name is unambiguous.
      const found = await asDataUrl(
        `https://${host}${path}`,
        path.endsWith('.ico') ? 'image/x-icon' : undefined
      )
      reachable = reachable || found.reachable
      if (found.url) return found
    }
  }
  return { url: null, reachable }
}

/**
 * Everywhere a mark might be, cheapest first.
 *
 * The bundled set has already been consulted by the caller and answers two
 * thirds of authors with no request at all, which is the only reason these two
 * are affordable — they are for the long tail, and the long tail is where a
 * mark is least likely to exist in the first place.
 */
async function fetchIcon(slug: string): Promise<{ url: string | null; checked: boolean }> {
  const ours = await fromOpenRouter(slug)
  if (ours.url) return { url: ours.url, checked: true }

  const theirs = await fromTheirSite(slug)
  if (theirs.url) return { url: theirs.url, checked: true }

  return { url: null, checked: ours.reachable && theirs.reachable }
}

/**
 * The mark for an author, as a data URL, or null when there is not one.
 *
 * Data rather than a file and a protocol handler: these are a few hundred
 * bytes each and there are a dozen of them, so a URL scheme, a handler and a
 * directory of files would be three moving parts to save nothing. `data:` is
 * already allowed by the window's content policy, so this needed no loosening
 * of it either.
 */
export async function iconForAuthor(slug: string): Promise<string | null> {
  /*
   * Ahead of the cache, not behind it.
   *
   * The cache remembers what was found before the bundled set existed —
   * DeepSeek as a 25KB PNG, Moonshot as a 229KB one, both scraped from a
   * website. Those are answers, so they would be returned for ever, and the
   * sharper local SVG would never be reached. Asking here costs a map lookup
   * and settles it.
   */
  const bundled = BUNDLED_ICONS[slug]
  if (bundled) return bundled

  const known = load()
  const cached = known[slug]

  if (cached) {
    if (cached.url) return cached.url
    // A miss is only worth keeping if it was reached by looking everywhere we
    // look now, and if it is recent.
    if ((cached.by ?? 1) >= STRATEGY && Date.now() - cached.checkedAt < REMEMBER_A_MISS_FOR) {
      return null
    }
  }

  const found = await fetchIcon(slug)
  /*
   * A failure to reach the network is not an absence of an icon.
   *
   * Writing one down as the other is how a laptop that opened the app on a
   * train ends up with a week of blank marks it will not retry. Only an answer
   * — found, or searched everywhere and not found — is remembered.
   */
  if (found.checked) {
    known[slug] = { url: found.url, checkedAt: Date.now(), by: STRATEGY }
    save()
  }
  return found.url
}
