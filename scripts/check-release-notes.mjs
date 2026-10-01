import { readFileSync } from 'node:fs'
import { releaseNotesForVersion } from '../src/shared/releaseNotes.mjs'

const root = new URL('../', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
let source = ''
try {
  source = readFileSync(new URL('release-notes.md', root), 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

if (!releaseNotesForVersion(source, version)) {
  console.error(
    `Release notes needed for ${version}: handwrite feature bullets in release-notes.md ` +
      `under "# ${version}" before publishing. Agents must not author these bullets.`
  )
  if (!process.argv.includes('--warn')) process.exitCode = 1
} else {
  console.log(`Release notes ready for ${version}. Confirm the bullets were handwritten.`)
}
