import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

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
  /** The data URL, or null for an author OpenRouter has no mark for. */
  url: string | null
  checkedAt: number
}

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

/** `anthropic/claude-sonnet-4.5` → `anthropic`. */
export function authorOf(modelId: string): string {
  const slash = modelId.indexOf('/')
  return (slash === -1 ? modelId : modelId.slice(0, slash)).toLowerCase()
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
async function asDataUrl(url: string, fallbackMime?: string): Promise<string | null> {
  try {
    const response = await fetch(url, { redirect: 'follow' })
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim()
    if (!response.ok) return null
    if (!type.startsWith('image/') && !fallbackMime) return null

    const bytes = Buffer.from(await response.arrayBuffer())
    // Nothing legitimate here is large, and an empty body is a site answering
    // politely rather than having an icon — ai21.com serves a 200 of 0 bytes.
    if (!bytes.length || bytes.length > 512 * 1024) return null

    return `data:${type.startsWith('image/') ? type : fallbackMime};base64,${bytes.toString('base64')}`
  } catch {
    // Offline, or the asset moved, or the host does not resolve.
    return null
  }
}

/** OpenRouter's own mark for the author, if it has one. */
async function fromOpenRouter(slug: string): Promise<string | null> {
  for (const name of candidates(slug)) {
    for (const ext of EXTENSIONS) {
      const found = await asDataUrl(`https://openrouter.ai/images/icons/${name}.${ext}`, MIME[ext])
      if (found) return found
    }
  }
  return null
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
async function fromTheirSite(slug: string): Promise<string | null> {
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

  for (const host of hosts) {
    for (const path of FAVICONS) {
      // ICO is not served with an `image/` type everywhere, and it is the one
      // extension here whose own name is unambiguous.
      const found = await asDataUrl(`https://${host}${path}`, path.endsWith('.ico') ? 'image/x-icon' : undefined)
      if (found) return found
    }
  }
  return null
}

async function fetchIcon(slug: string): Promise<string | null> {
  return (await fromOpenRouter(slug)) ?? (await fromTheirSite(slug))
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
  const known = load()
  const cached = known[slug]

  if (cached) {
    if (cached.url) return cached.url
    if (Date.now() - cached.checkedAt < REMEMBER_A_MISS_FOR) return null
  }

  const url = await fetchIcon(slug)
  known[slug] = { url, checkedAt: Date.now() }
  save()
  return url
}
