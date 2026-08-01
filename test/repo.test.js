const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { suite } = require('./support/harness')

/**
 * Read-only access to an attached directory. The containment checks matter most:
 * everything the model asks for is a string it chose, so the boundary is the
 * only thing between a chat about a codebase and reading the rest of the disk.
 */
suite('attached repository — read-only access', async ({ check, section, subject }) => {
  const { repoTools } = subject

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-repo-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-outside-'))

  fs.mkdirSync(path.join(root, 'src'))
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true })
  fs.mkdirSync(path.join(root, '.git'))
  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n\nA test repository.\n')
  fs.writeFileSync(path.join(root, 'src', 'main.c'), 'int main(void) {\n  return 0;\n}\n')
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export const answer = 42\n')
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=super-secret\n')
  fs.writeFileSync(path.join(root, 'server.pem'), '-----BEGIN PRIVATE KEY-----\n')
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'huge.js'), 'x'.repeat(5000))
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]\n')
  fs.writeFileSync(path.join(outside, 'secrets.txt'), 'do not read me')
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))
  // A symlink pointing out of the repository — the classic escape.
  try { fs.symlinkSync(outside, path.join(root, 'escape')) } catch { /* ignore */ }

  const roots = [root]

  section('containment')
  const refuses = (p) => {
    try { repoTools.resolveWithinRoots(roots, p); return false } catch { return true }
  }
  check('a file inside resolves', repoTools.resolveWithinRoots(roots, 'README.md').endsWith('README.md'))
  check('.. cannot climb out', refuses('../'))
  check('a deep .. cannot climb out', refuses('../../../../etc/passwd'))
  check('an absolute path outside is refused', refuses(path.join(outside, 'secrets.txt')))
  check('an absolute path inside is allowed', !refuses(path.join(root, 'README.md')))
  check('a symlink pointing outside is refused', refuses('escape/secrets.txt'))
  check('a path that does not exist is refused', refuses('nope/missing.txt'))
  check('with nothing attached, everything is refused',
    (() => { try { repoTools.resolveWithinRoots([], 'README.md'); return false } catch { return true } })())

  section('what is never read')
  check('.env is recognised as a secret', repoTools.isSecretName('.env'))
  check('.env.production too', repoTools.isSecretName('.env.production'))
  check('private keys too', repoTools.isSecretName('server.pem') && repoTools.isSecretName('id_rsa'))
  check('ordinary source is not', !repoTools.isSecretName('main.c') && !repoTools.isSecretName('README.md'))

  const readFails = (p) => {
    try { repoTools.runRepoRead(roots, { path: p }); return false } catch { return true }
  }
  check('reading .env is refused even when asked directly', readFails('.env'))
  check('reading a private key is refused', readFails('server.pem'))
  check('reading a binary file is refused', readFails('binary.bin'))

  section('the tree')
  const tree = repoTools.runRepoTree(roots, {})
  check('lists real files', tree.includes('README.md') && tree.includes('main.c'), tree.slice(0, 200))
  check('omits node_modules', !tree.includes('node_modules'), tree)
  check('omits .git', !tree.includes('.git'), tree)
  check('omits secrets', !tree.includes('.env') && !tree.includes('server.pem'), tree)

  const scoped = repoTools.runRepoTree(roots, { path: 'src' })
  check('can be scoped to a subdirectory', scoped.includes('main.c') && !scoped.includes('README.md'), scoped)

  section('reading')
  const read = repoTools.runRepoRead(roots, { path: 'src/main.c' })
  check('returns the contents', read.includes('int main(void)'), read)
  check('numbers the lines', /^\s+1\s+int main/m.test(read), read)
  check('names the file and its length', /main\.c \(\d+ lines\)/.test(read), read.split('\n')[0])

  const ranged = repoTools.runRepoRead(roots, { path: 'src/main.c', start_line: 2, end_line: 2 })
  check('honours a line range', ranged.includes('return 0') && !ranged.includes('int main(void)'), ranged)

  section('searching')
  const hits = repoTools.runRepoSearch(roots, { pattern: 'answer' })
  check('finds a match with file and line', /util\.ts:1:/.test(hits), hits)
  check('does not search node_modules', !hits.includes('node_modules'), hits)
  check('reports honestly when there is nothing',
    repoTools.runRepoSearch(roots, { pattern: 'zzzz-not-here' }).includes('No matches'))
  check('a bad regular expression is explained, not thrown raw',
    (() => { try { repoTools.runRepoSearch(roots, { pattern: '([' }); return false }
             catch (e) { return /valid regular expression/.test(e.message) } })())

  const scopedHits = repoTools.runRepoSearch(roots, { pattern: '.', glob: '.c' })
  check('can be limited by extension', scopedHits.includes('main.c') && !scopedHits.includes('util.ts'), scopedHits)

  section('finding by name')
  const found = repoTools.runRepoFind(roots, { name: 'util' })
  check('finds by partial path', found.includes('util.ts'), found)
  check('says so when nothing matches', repoTools.runRepoFind(roots, { name: 'nonexistent' }).includes('No files'))

  section('the prompt segment')
  const segment = repoTools.repoPromptSegment(roots, repoTools.treeSummary(roots))
  check('states it is read-only', /read-only/.test(segment))
  check('says there is no way to write', /cannot change it/.test(segment))
  check('includes the layout so the model starts oriented', segment.includes('README.md'))

  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})
