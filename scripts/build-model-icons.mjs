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
 * Authors filed under a name that is not their OpenRouter slug.
 *
 * Z.AI's mark is under the company's older name, Zhipu; `x-ai` is `xai`; the
 * rest are the usual mismatch between how a company signs its models and what
 * it calls itself.
 */
const ALIAS = {
  'z-ai': 'zhipu',
  'x-ai': 'xai',
  'meta-llama': 'meta',
  mistralai: 'mistral',
  moonshotai: 'moonshot',
  'ibm-granite': 'ibm',
  'bytedance-seed': 'bytedance',
  'arcee-ai': 'arcee',
  'aion-labs': 'aionlabs',
  thinkingmachines: 'thinkingmachineslab',
  'nex-agi': 'nexa',
  rekaai: 'reka',
  'anthracite-org': 'anthracite'
}

const available = new Set(
  readdirSync(iconDir)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => f.replace(/\.svg$/, ''))
)

/** Colour where there is one: these sit on a dark surface among other marks. */
function fileFor(slug) {
  for (const name of [ALIAS[slug], slug, slug.replace(/-/g, '')].filter(Boolean)) {
    if (available.has(`${name}-color`)) return `${name}-color`
    if (available.has(name)) return name
  }
  return null
}

const response = await fetch('https://openrouter.ai/api/v1/models')
const authors = [
  ...new Set(
    (await response.json()).data.map((m) => m.id.replace(/^~/, '').split('/')[0].toLowerCase())
  )
].sort()

const entries = []
const missing = []
for (const slug of authors) {
  const file = fileFor(slug)
  if (!file) {
    missing.push(slug)
    continue
  }
  const svg = readFileSync(join(iconDir, `${file}.svg`))
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
