const fs = require('node:fs')
const path = require('node:path')
const { suite } = require('./support/harness')

suite('folders — nesting survives moves, sync and archives', async ({ check, section, subject, tmpDir }) => {
  const { repo, getDb, syncRecords, exporter, importer } = subject
  getDb()

  section('parents and safe moves')
  const root = repo.createFolder('Work')
  const child = repo.createFolder('Research', root.id)
  const leaf = repo.createFolder('Notes / drafts', child.id)
  const thread = repo.createThread('Deeply filed chat')
  repo.insertMessage({ threadId: thread.id, role: 'user', content: 'Keep this conversation.' })
  repo.setThreadFolder(thread.id, leaf.id)
  const edited = repo.getThread(thread.id).updatedAt
  check('existing root folders have no parent', root.parentId === null)
  check('subfolders remember their parent', repo.getFolder(child.id).parentId === root.id)
  check('creating under a missing parent is refused', repo.createFolder('Lost', 'missing') === null)
  check('moving into itself is refused', repo.updateFolder(root.id, { parentId: root.id }) === null)
  check('moving into a descendant is refused', repo.updateFolder(root.id, { parentId: leaf.id }) === null)
  check('moving into a missing parent is refused', repo.updateFolder(child.id, { parentId: 'missing' }) === null)
  check('a refused move leaves the hierarchy intact', repo.getFolder(child.id).parentId === root.id)
  repo.updateFolder(child.id, { parentId: null })
  check('a subfolder can move to the root', repo.getFolder(child.id).parentId === null)
  check('its own subfolders move with it', repo.getFolder(leaf.id).parentId === child.id)
  check('and chats stay filed with their dates unchanged',
    repo.getThread(thread.id).folderId === leaf.id && repo.getThread(thread.id).updatedAt === edited)
  repo.updateFolder(child.id, { parentId: root.id })
  repo.updateFolder(child.id, { name: 'Sources', pinned: true })
  check('renaming and pinning preserve the parent', repo.getFolder(child.id).parentId === root.id)

  section('sync can deliver children first')
  const records = [root, child, leaf].map((folder) => syncRecords.readRecord('folder', folder.id))
  check('the parent travels in the sync record', records[2].data.parent_id === child.id)
  repo.wipeAllData()
  syncRecords.applyRecord(records[2])
  check('a child keeps a parent that has not arrived', repo.getFolder(leaf.id).parentId === child.id)
  syncRecords.applyRecord(records[1])
  syncRecords.applyRecord(records[0])
  check('the full hierarchy is restored after its parents arrive',
    repo.getFolder(leaf.id).parentId === child.id && repo.getFolder(child.id).parentId === root.id)
  syncRecords.applyRecord({ ...records[0], rev: records[0].rev + 100, data: { ...records[0].data, parent_id: leaf.id } })
  check('a conflicting synced move cannot close a cycle', repo.getFolder(root.id).parentId === null)
  const legacy = { ...records[2], data: { ...records[2].data } }
  delete legacy.data.parent_id
  syncRecords.applyRecord(legacy)
  check('old sync records still create root folders', repo.getFolder(leaf.id).parentId === null)
  syncRecords.applyRecord(records[2])

  section('archive round trip with duplicate names and a slash')
  const duplicate = repo.createFolder('Notes / drafts')
  const archivedThread = repo.createThread('Archived nested chat')
  repo.insertMessage({ threadId: archivedThread.id, role: 'user', content: 'An archived question.' })
  repo.setThreadFolder(archivedThread.id, leaf.id)
  const file = exporter.archiveFor(archivedThread.id, 'test')
  const serialized = JSON.parse(file.contents)
  check('the archive keeps each path segment separately',
    JSON.stringify(serialized.threads[0].folderPath) === JSON.stringify(['Work', 'Sources', 'Notes / drafts']))
  const destination = path.join(tmpDir, file.filename)
  fs.writeFileSync(destination, file.contents)
  repo.deleteThread(archivedThread.id)
  const imported = importer.importFile(destination, new Set())
  check('the archive imports successfully', imported.threadsCreated === 1, imported)
  const restored = repo.listThreads().find((item) => item.title === 'Archived nested chat')
  check('the matching nested folder is reused', restored.folderId === leaf.id)
  check('a root folder with the same name is not used', restored.folderId !== duplicate.id)
  repo.wipeAllData()
  importer.importFile(destination, new Set())
  const rebuilt = repo.listThreads()[0]
  const rebuiltLeaf = repo.getFolder(rebuilt.folderId)
  const rebuiltChild = repo.getFolder(rebuiltLeaf.parentId)
  check('an empty library recreates all three levels',
    rebuiltLeaf.name === 'Notes / drafts' && rebuiltChild.name === 'Sources' &&
    repo.getFolder(rebuiltChild.parentId).name === 'Work')

  section('deleting a parent keeps children and conversations')
  repo.deleteFolder(rebuiltChild.id)
  check('the direct child moves to the top level', repo.getFolder(rebuiltLeaf.id).parentId === null)
  check('its chat and messages survive', repo.getThread(rebuilt.id).folderId === rebuiltLeaf.id &&
    repo.getMessages(rebuilt.id).length === 1)
})
