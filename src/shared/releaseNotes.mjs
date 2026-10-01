/** Parse the maintainer's Markdown, without inventing or rewriting any features. */
export function parseReleaseNotes(source) {
  const text = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
  const [heading, ...lines] = text.split('\n')
  const match = /^#\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)\s*$/.exec(heading)
  if (!match) return null
  const body = lines.join('\n').trim()
  const entries = body.split('\n').filter((line) => line.trim())
  if (!entries.length || !/^[-*+]\s+\S/.test(entries[0])) return null
  if (entries.some((line) => !/^[-*+]\s+\S/.test(line) && !/^(?: {2,}|\t)\S/.test(line)))
    return null
  return { version: match[1], body }
}

/** Old, malformed, or unfinished notes must never describe a different release. */
export function releaseNotesForVersion(source, version) {
  const notes = parseReleaseNotes(source)
  return notes?.version === version ? notes : null
}

export function shouldShowReleaseNotes(notes, version, seenVersion) {
  return Boolean(notes && notes.version === version && seenVersion !== version)
}
