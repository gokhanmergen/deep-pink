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
for (const { slug, displayName } of authors) {
  const mark = markFor(slug, displayName)
  if (!mark) {
    missing.push(slug)
    continue
  }
  if (!mark.confirmed) unconfirmed.push(`${slug} -> ${mark.file} (titled "${mark.title}")`)
  const svg = readFileSync(join(iconDir, `${mark.file}.svg`))
  entries.push([slug, `data:image/svg+xml;base64,${svg.toString('base64')}`])
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
if (unconfirmed.length) {
  console.log(`\nnot confirmed by the icon's own title — worth an eye:`)
  for (const line of unconfirmed) console.log(`  ${line}`)
}
