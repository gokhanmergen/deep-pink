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
 * Requests go to openrouter.ai, which is somewhere this app already talks to,
 * so nothing new learns anything about you. Each author is fetched once ever
 * and kept on disk; misses are remembered too, or every start would re-ask for
 * the same dozen files that do not exist.
 */

/** Where the slug's own capitalisation is not what the file is called. */
const NAMED: Record<string, string> = {
  openai: 'OpenAI',
  'meta-llama': 'Meta',
  meta: 'Meta',
  mistralai: 'Mistral',
  google: 'GoogleGemini',
  'google-vertex': 'GoogleVertex',
  deepseek: 'DeepSeek',
  moonshotai: 'MoonshotAI',
  amazon: 'Bedrock',
  'x-ai': 'xAI',
  'z-ai': 'ZAI',
  ai21: 'AI21',
  nvidia: 'NVIDIA',
  bytedance: 'ByteDance',
  minimax: 'MiniMax'
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

async function fetchIcon(slug: string): Promise<string | null> {
  for (const name of candidates(slug)) {
    for (const ext of EXTENSIONS) {
      try {
        const response = await fetch(`https://openrouter.ai/images/icons/${name}.${ext}`)
        // Their 404 is an HTML page rather than a status-only response, so the
        // content type is checked as well: a 200 carrying `text/html` is a miss
        // wearing a hit's clothes.
        const type = response.headers.get('content-type') ?? ''
        if (!response.ok || !type.startsWith('image/')) continue

        const bytes = Buffer.from(await response.arrayBuffer())
        // Nothing legitimate here is large. A file that is says the URL is not
        // the one this thinks it is.
        if (!bytes.length || bytes.length > 512 * 1024) continue

        return `data:${MIME[ext]};base64,${bytes.toString('base64')}`
      } catch {
        // Offline, or the asset moved. Either way there is no mark to show and
        // the caller has a fallback for exactly this.
      }
    }
  }
  return null
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
