import type { Folder } from './types'

/** The folder itself followed by its parents, stopping safely at missing links. */
export function folderAncestors(folders: Folder[], id: string | null): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const ancestors: string[] = []
  const seen = new Set<string>()
  while (id && !seen.has(id)) {
    seen.add(id)
    ancestors.push(id)
    id = byId.get(id)?.parentId ?? null
  }
  return ancestors
}

export function canMoveFolder(folders: Folder[], id: string, parentId: string | null): boolean {
  if (!folders.some((folder) => folder.id === id)) return false
  if (parentId === null) return true
  return (
    folders.some((folder) => folder.id === parentId) &&
    !folderAncestors(folders, parentId).includes(id)
  )
}

/** Separate names preserve folders whose names themselves contain a slash. */
export function folderPath(folders: Folder[], id: string): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  return folderAncestors(folders, id).reverse().flatMap((ancestor) => {
    const folder = byId.get(ancestor)
    return folder ? [folder.name] : []
  })
}
