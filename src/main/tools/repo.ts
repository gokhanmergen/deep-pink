import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { ToolParam } from '../providers/openrouter'

/**
 * Read-only access to a directory the user attached to a thread.
 *
 * Deliberately built in rather than delegated to the filesystem MCP server: this
 * hangs off the Attach button, so it has to work with no spawn dependency and no
 * node on PATH. Nothing here writes, renames, deletes or executes — the tools
 * simply do not exist, so no toggle or approval can turn them into a write.
 */

/** Ceilings that keep one tool call from eating a context window. */
export const MAX_FILE_BYTES = 256 * 1024
export const MAX_TREE_ENTRIES = 900
export const MAX_SEARCH_HITS = 60
export const MAX_MATCH_LINE = 240

/**
 * Directories that are never worth sending to a model: build output, vendored
 * dependencies, and version-control internals. Excluding them is as much about
 * cost as noise — `node_modules` alone would exhaust any context window.
 */
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '.turbo',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  '.gradle', '.idea', '.vscode', 'DerivedData', 'Pods', '.terraform',
  'coverage', '.cache', '.parcel-cache', '.pnpm-store'
])

/**
 * Files that commonly hold credentials. Reading one would send it straight to
 * the provider, so they are refused by name even when explicitly asked for.
 */
const SECRET_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^.*\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^credentials(\.json|\.yml|\.yaml)?$/i,
  /^secrets?\.(json|ya?ml|toml|ini)$/i,
  /^service-account.*\.json$/i
]

export function isSecretName(name: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(name))
}

export function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name)
}

/* ------------------------------------------------------------------ *
 * Containment
 * ------------------------------------------------------------------ */

/**
 * Resolves a path the model asked for against the attached roots.
 *
 * Symlinks are resolved before the check, so a link inside the repo pointing at
 * ~/.ssh cannot be followed out. A path that escapes every root is refused
 * rather than clamped, because silently reading something else would be worse.
 */
export function resolveWithinRoots(roots: string[], requested: string): string {
  if (!roots.length) throw new Error('No repository is attached to this thread.')

  const candidates = requested.startsWith('/')
    ? [requested]
    : roots.map((root) => resolve(root, requested))

  for (const candidate of candidates) {
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      continue
    }
    for (const root of roots) {
      let realRoot: string
      try {
        realRoot = realpathSync(root)
      } catch {
        continue
      }
      if (real === realRoot || real.startsWith(realRoot + sep)) return real
    }
  }

  throw new Error(
    `${requested} is outside the attached ${roots.length === 1 ? 'directory' : 'directories'}.`
  )
}

/** How a path should be shown to the model: relative to its root. */
function display(roots: string[], absolute: string): string {
  for (const root of roots) {
    try {
      const realRoot = realpathSync(root)
      if (absolute === realRoot || absolute.startsWith(realRoot + sep)) {
        return join(basename(realRoot), relative(realRoot, absolute))
      }
    } catch {
      /* root has gone away; fall through */
    }
  }
  return absolute
}

/* ------------------------------------------------------------------ *
 * Tool definitions
 * ------------------------------------------------------------------ */

export const REPO_TREE_TOOL: ToolParam = {
  type: 'function',
  function: {
    name: 'repo_tree',
    description:
      'List the files and directories of the attached repository. Use to get oriented before reading anything.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subdirectory to list. Omit for the whole repository.' },
        depth: { type: 'integer', description: 'How many levels deep to descend (1-6).' }
      },
      additionalProperties: false
    }
  }
}

export const REPO_READ_TOOL: ToolParam = {
  type: 'function',
  function: {
    name: 'repo_read',
    description: 'Read a text file from the attached repository.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file, relative to the repository root.' },
        start_line: { type: 'integer', description: 'First line to return (1-based).' },
        end_line: { type: 'integer', description: 'Last line to return.' }
      },
      required: ['path'],
      additionalProperties: false
    }
  }
}

export const REPO_SEARCH_TOOL: ToolParam = {
  type: 'function',
  function: {
    name: 'repo_search',
    description:
      'Search the attached repository for a regular expression, returning matching lines with their file and line number.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Limit the search to this subdirectory.' },
        glob: { type: 'string', description: 'Only search files whose name ends with this, e.g. ".ts".' }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  }
}

export const REPO_FIND_TOOL: ToolParam = {
  type: 'function',
  function: {
    name: 'repo_find',
    description: 'Find files in the attached repository whose path contains the given text.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Text to match against file paths.' }
      },
      required: ['name'],
      additionalProperties: false
    }
  }
}

export const REPO_TOOLS = [REPO_TREE_TOOL, REPO_READ_TOOL, REPO_SEARCH_TOOL, REPO_FIND_TOOL]
export const REPO_TOOL_NAMES = new Set(REPO_TOOLS.map((t) => t.function.name))

export function repoPromptSegment(roots: string[], tree: string): string {
  const names = roots.map((r) => basename(r)).join(', ')
  return `A repository is attached to this conversation, read-only: ${names}

You can call \`repo_tree\`, \`repo_read\`, \`repo_search\` and \`repo_find\` to look at it. You cannot change it — there are no tools to write, move or delete, and there is no shell.

Read before concluding. Say which files you looked at. If something is outside the attached directory, say so rather than guessing.

Its layout:

${tree}`
}

/* ------------------------------------------------------------------ *
 * Walking
 * ------------------------------------------------------------------ */

interface Entry {
  path: string
  isDir: boolean
}

function children(dir: string): Entry[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const entries: Entry[] = []
  for (const name of names.sort()) {
    if (name.startsWith('.') && (isSkippedDir(name) || name === '.DS_Store')) continue
    if (isSecretName(name)) continue

    const full = join(dir, name)
    let isDir: boolean
    try {
      // Not followed: a symlinked directory is reported but not descended, so a
      // link out of the repo cannot widen what is walked.
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir && isSkippedDir(name)) continue
    entries.push({ path: full, isDir })
  }
  return entries
}

function walk(roots: string[], start: string, maxDepth: number, limit: number): string[] {
  const lines: string[] = []
  let truncated = false

  const descend = (dir: string, depth: number, prefix: string): void => {
    if (depth > maxDepth || truncated) return
    for (const entry of children(dir)) {
      if (lines.length >= limit) {
        truncated = true
        return
      }
      const name = basename(entry.path)
      lines.push(`${prefix}${name}${entry.isDir ? '/' : ''}`)
      if (entry.isDir) descend(entry.path, depth + 1, `${prefix}  `)
    }
  }

  descend(start, 1, '')
  if (truncated) {
    lines.push(`… truncated at ${limit} entries; narrow with the path argument`)
  }
  return lines.length ? lines : [`(${display(roots, start)} is empty)`]
}

/** The layout summary seeded into the system prompt when a repo is attached. */
export function treeSummary(roots: string[], maxDepth = 3, limit = 400): string {
  return roots
    .map((root) => {
      try {
        const real = realpathSync(root)
        return [`${basename(real)}/`, ...walk(roots, real, maxDepth, limit).map((l) => `  ${l}`)].join(
          '\n'
        )
      } catch {
        return `${root} (unavailable)`
      }
    })
    .join('\n\n')
}

/* ------------------------------------------------------------------ *
 * Tool implementations
 * ------------------------------------------------------------------ */

function readTextFile(absolute: string): { text: string; truncated: boolean } {
  const size = statSync(absolute).size
  const buffer = readFileSync(absolute)

  // A NUL byte early on means binary; sending it would waste tokens and tell
  // the model nothing.
  if (buffer.subarray(0, 8192).includes(0)) {
    throw new Error(`${basename(absolute)} looks binary, not text.`)
  }

  const text = buffer.subarray(0, MAX_FILE_BYTES).toString('utf8')
  return { text, truncated: size > MAX_FILE_BYTES }
}

export function runRepoTree(roots: string[], args: { path?: string; depth?: number }): string {
  const start = args.path ? resolveWithinRoots(roots, args.path) : null
  const depth = Math.min(Math.max(args.depth ?? 3, 1), 6)

  if (start) {
    return [
      `${display(roots, start)}/`,
      ...walk(roots, start, depth, MAX_TREE_ENTRIES).map((l) => `  ${l}`)
    ].join('\n')
  }
  return treeSummary(roots, depth, MAX_TREE_ENTRIES)
}

export function runRepoRead(
  roots: string[],
  args: { path?: string; start_line?: number; end_line?: number }
): string {
  if (!args.path) throw new Error('repo_read requires a `path`.')

  const absolute = resolveWithinRoots(roots, args.path)
  if (isSecretName(basename(absolute))) {
    throw new Error(
      `${basename(absolute)} looks like it holds credentials, so it is not readable from here.`
    )
  }
  if (statSync(absolute).isDirectory()) {
    throw new Error(`${args.path} is a directory — use repo_tree.`)
  }

  const { text, truncated } = readTextFile(absolute)
  const lines = text.split('\n')

  const from = Math.max(args.start_line ?? 1, 1)
  const to = Math.min(args.end_line ?? lines.length, lines.length)
  const slice = lines.slice(from - 1, to)

  const numbered = slice.map((line, i) => `${String(from + i).padStart(5)}  ${line}`).join('\n')
  const header = `${display(roots, absolute)} (${lines.length} lines)`
  const note = truncated ? `\n\n[file truncated at ${MAX_FILE_BYTES / 1024} KB]` : ''

  return `${header}\n\n${numbered}${note}`
}

function eachFile(start: string, visit: (file: string) => boolean): void {
  const stack = [start]
  while (stack.length) {
    const dir = stack.pop()!
    for (const entry of children(dir)) {
      if (entry.isDir) {
        stack.push(entry.path)
        continue
      }
      if (!visit(entry.path)) return
    }
  }
}

export function runRepoSearch(
  roots: string[],
  args: { pattern?: string; path?: string; glob?: string }
): string {
  if (!args.pattern) throw new Error('repo_search requires a `pattern`.')

  let regex: RegExp
  try {
    regex = new RegExp(args.pattern, 'i')
  } catch (err) {
    throw new Error(`That is not a valid regular expression: ${(err as Error).message}`)
  }

  const start = args.path ? resolveWithinRoots(roots, args.path) : null
  const searchRoots = start ? [start] : roots.map((r) => realpathSync(r))
  const hits: string[] = []

  for (const root of searchRoots) {
    eachFile(root, (file) => {
      if (args.glob && !file.endsWith(args.glob)) return true
      let content: string
      try {
        const buffer = readFileSync(file)
        if (buffer.subarray(0, 4096).includes(0)) return true
        content = buffer.subarray(0, MAX_FILE_BYTES).toString('utf8')
      } catch {
        return true
      }

      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue
        hits.push(`${display(roots, file)}:${i + 1}: ${lines[i].trim().slice(0, MAX_MATCH_LINE)}`)
        if (hits.length >= MAX_SEARCH_HITS) return false
      }
      return true
    })
    if (hits.length >= MAX_SEARCH_HITS) break
  }

  if (!hits.length) return `No matches for /${args.pattern}/.`
  const capped = hits.length >= MAX_SEARCH_HITS ? `\n\n[stopped at ${MAX_SEARCH_HITS} matches]` : ''
  return hits.join('\n') + capped
}

export function runRepoFind(roots: string[], args: { name?: string }): string {
  if (!args.name) throw new Error('repo_find requires a `name`.')

  const needle = args.name.toLowerCase()
  const found: string[] = []

  for (const root of roots.map((r) => realpathSync(r))) {
    eachFile(root, (file) => {
      const shown = display(roots, file)
      if (shown.toLowerCase().includes(needle)) found.push(shown)
      return found.length < MAX_SEARCH_HITS
    })
    if (found.length >= MAX_SEARCH_HITS) break
  }

  return found.length ? found.join('\n') : `No files matching “${args.name}”.`
}
