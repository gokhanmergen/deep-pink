/**
 * Turns the brand marks this app needs into one generated module.
 *
 * Icons come from `@lobehub/icons-static-svg`, which is 906 marks and 4.4MB —
 * far more than an OpenRouter client will ever draw. This takes the ones that
 * match a real OpenRouter author and writes them into `src/main/modelIconData.ts`
 * as data URLs, which is about seventy kilobytes and needs no asset pipeline,
 * no protocol handler and no network at runtime.
 *
 * Run it again when the author list moves on:  node scripts/build-model-icons.mjs
 *
 * The marks are trademarks of the companies they belong to. They are used here
 * to identify those companies' models, which is the purpose they exist for and
 * the same thing OpenRouter's own site does with them.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconDir = join(root, 'node_modules', '@lobehub', 'icons-static-svg', 'icons')

/**
 * Authors whose mark is filed under a different name, and only those.
 *
 * Deliberately short. An alias is a claim that two names are one company, and
 * a wrong one puts a wrong logo on a model — which is worse than no logo,
 * because a blank says "unknown" and a wrong one says something false with
 * confidence. Z.AI is what this is for: it was aliased to Zhipu, the company's
 * older name, whose mark is a blue glyph rather than the Z everyone knows, and
 * nothing caught it because the file existed and loaded fine.
 *
 * The slug itself and its dehyphenated form are tried first, so `z-ai` finds
 * `zai` and `x-ai` finds `xai` without anything being written here at all.
 */
const ALIAS = {
  'meta-llama': 'meta',
  mistralai: 'mistral',
  moonshotai: 'moonshot',
  'ibm-granite': 'ibm',
  'bytedance-seed': 'bytedance',
  'arcee-ai': 'arcee'
}

const available = new Set(
  readdirSync(iconDir)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => f.replace(/\.svg$/, ''))
)

/** Every icon carries the company it belongs to. This is the check. */
function titleOf(name) {
  const match = readFileSync(join(iconDir, `${name}.svg`), 'utf8').match(/<title>([^<]*)<\/title>/)
  return match ? match[1] : null
}

const flatten = (value) => (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * The mark for an author, and whether anything confirmed it.
 *
 * A candidate whose own title is the author's own name is the answer and
 * needs no judgement. Where none of them says so — xAI's mark is titled "Grok",
 * which is true and does not match — the first that exists is taken and
 * reported, so a human can look at the short list rather than at all of them.
 */
function markFor(slug, displayName) {
  const candidates = [slug, slug.replace(/-/g, ''), ALIAS[slug]].filter(Boolean)
  const found = []

  for (const name of candidates) {
    const file = available.has(`${name}-color`) ? `${name}-color` : available.has(name) ? name : null
    if (!file) continue
    const title = titleOf(file)
    if (flatten(title) === flatten(displayName)) return { file, title, confirmed: true }
    found.push({ file, title, confirmed: false })
  }

  return found[0] ?? null
}

/*
 * Marks drawn in black, made visible.
 *
 * Where a brand has no colour variant, the icon set ships it as a black glyph
 * — Anthropic, OpenAI, Meta and a dozen others. On this app's surfaces that is
 * a dark shape on a dark background, which is to say nothing at all.
 *
 * The rule has to be certain before it touches anything, because recolouring a
 * logo that was meant to be that colour is a worse outcome than leaving one
 * invisible. So it is an *every* rather than an *any*: a file is only repainted
 * when every visible paint in it is dark. One coloured stop, one blue path, and
 * the file is left exactly as it was. That makes a false positive impossible by
 * construction rather than by choosing a good threshold — the threshold only
 * decides how much gets brightened, never whether a coloured mark might be.
 */

/** Every colour a document paints with: attributes, inline styles, gradients. */
function paintsIn(svg) {
  const found = []
  for (const m of svg.matchAll(/(?:fill|stroke|stop-color)\s*=\s*"([^"]*)"/g)) found.push(m[1])
  for (const m of svg.matchAll(/(?:fill|stroke|stop-color)\s*:\s*([^;"'}]+)/g)) found.push(m[1])
  return found.map((v) => v.trim()).filter(Boolean)
}

const NAMED_BLACK = new Set(['black', '#000', '#000000'])

/** sRGB relative luminance, 0 for black and 1 for white. */
function luminanceOf(colour) {
  const hex = colour.replace('#', '')
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
  if (!/^[0-9a-f]{6}$/i.test(full)) return null

  const channel = (v) => {
    const n = parseInt(v, 16) / 255
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * channel(full.slice(0, 2)) +
    0.7152 * channel(full.slice(2, 4)) +
    0.0722 * channel(full.slice(4, 6))
  )
}

/** Dark enough to vanish on this app's surfaces, which sit under 0.02. */
const TOO_DARK_TO_SEE = 0.08

/**
 * Whether every visible paint in the file is dark.
 *
 * `currentColor` counts as dark: inside an `<img>` the SVG is its own document
 * with no inherited colour, so it resolves to black. Anything this cannot read
 * — an unparseable value, a name that is not plain black — counts as *not*
 * dark, which stops the whole file rather than risking it.
 */
function isDarkOnly(svg) {
  for (const paint of paintsIn(svg)) {
    const value = paint.toLowerCase()
    if (value === 'none' || value === 'transparent' || value.startsWith('url(')) continue
    if (value === 'currentcolor' || NAMED_BLACK.has(value)) continue

    const luminance = luminanceOf(value)
    if (luminance === null || luminance > TOO_DARK_TO_SEE) return false
  }

  // Nothing disqualified it. A file that paints nothing explicitly is using the
  // default, and the default is black.
  return true
}

/** What a dark paint becomes: the same colour with its lightness turned over. */
const LIGHT = '#e8e8ef'

function brighten(svg) {
  const swap = (value) => {
    const flat = value.toLowerCase()
    if (flat === 'none' || flat === 'transparent' || flat.startsWith('url(')) return value
    if (flat === 'currentcolor' || NAMED_BLACK.has(flat)) return LIGHT

    // A shade that is dark but not black keeps its distance from the others,
    // so a two-tone glyph stays two-tone instead of flattening to one.
    const luminance = luminanceOf(flat)
    if (luminance === null) return value
    const level = Math.round((0.82 + (TOO_DARK_TO_SEE - luminance) * 0.9) * 255)
    const hex = Math.max(0, Math.min(255, level)).toString(16).padStart(2, '0')
    return `#${hex}${hex}${hex}`
  }

  return svg
    .replace(/(fill|stroke|stop-color)(\s*=\s*)"([^"]*)"/g, (_, k, eq, v) => `${k}${eq}"${swap(v)}"`)
    .replace(/(fill|stroke|stop-color)(\s*:\s*)([^;"'}]+)/g, (_, k, c, v) => `${k}${c}${swap(v)}`)
}

const response = await fetch('https://openrouter.ai/api/v1/models')
/*
 * `name` is "Z.ai: GLM 5.3 Flash", so the author's own name for itself is
 * already in the catalogue — which is what makes the check above possible
 * without anything being looked up by hand.
 */
const bySlug = new Map()
for (const model of (await response.json()).data) {
  const slug = model.id.replace(/^~/, '').split('/')[0].toLowerCase()
  if (!bySlug.has(slug)) bySlug.set(slug, model.name.split(':')[0].trim())
}
const authors = [...bySlug]
  .map(([slug, displayName]) => ({ slug, displayName }))
  .sort((a, b) => a.slug.localeCompare(b.slug))

const entries = []
const missing = []
const unconfirmed = []
const brightened = []
for (const { slug, displayName } of authors) {
  const mark = markFor(slug, displayName)
  if (!mark) {
    missing.push(slug)
    continue
  }
  if (!mark.confirmed) unconfirmed.push(`${slug} -> ${mark.file} (titled "${mark.title}")`)

  let svg = readFileSync(join(iconDir, `${mark.file}.svg`), 'utf8')
  if (isDarkOnly(svg)) {
    svg = brighten(svg)
    brightened.push(`${slug} (${mark.file})`)
  }
  entries.push([slug, `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`])
}

const body = `/**
 * Brand marks, generated. Do not edit by hand — run:
 *
 *     node scripts/build-model-icons.mjs
 *
 * ${entries.length} of ${authors.length} OpenRouter authors, from
 * @lobehub/icons-static-svg (MIT). The rest have no mark in that set and fall
 * through to OpenRouter's own directory, then to the author's own favicon,
 * then to a lettered badge — see \`icons.ts\`.
 *
 * Without a mark here: ${missing.join(', ')}
 */
export const BUNDLED_ICONS: Record<string, string> = {
${entries.map(([slug, url]) => `  ${/^[a-z][a-z0-9]*$/.test(slug) ? slug : `'${slug}'`}: '${url}'`).join(',\n')}
}
`

writeFileSync(join(root, 'src', 'main', 'modelIconData.ts'), body)
console.log(`${entries.length}/${authors.length} authors have a bundled mark`)
console.log(`without one: ${missing.join(', ')}`)
console.log(`\n${brightened.length} were drawn in black and have been lightened:`)
console.log(`  ${brightened.join(', ')}`)
if (unconfirmed.length) {
  console.log(`\nnot confirmed by the icon's own title — worth an eye:`)
  for (const line of unconfirmed) console.log(`  ${line}`)
}
