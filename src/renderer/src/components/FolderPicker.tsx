import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, Folder as FolderIcon, Search } from 'lucide-react'
import type { Folder } from '@shared/types'
import { folderPath } from '@shared/folders'
import { ICON } from '../icons'

/** All destinations are available here, even when their sidebar rows are off screen. */
interface Props {
  x: number
  y: number
  folders: Folder[]
  currentId: string | null
  onChoose: (folder: Folder) => void
  onClose: () => void
}

export function FolderPicker({ x, y, folders, currentId, onChoose, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [position, setPosition] = useState({ x, y })
  const destinations = useMemo(
    () => folders.map((folder) => ({
      folder,
      path: folderPath(folders, folder.id).join(' / ')
    })).sort((a, b) => a.path.localeCompare(b.path)),
    [folders]
  )
  const matches = destinations.filter(({ path }) =>
    path.toLowerCase().includes(query.trim().toLowerCase())
  )

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    })
  }, [x, y, matches.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!['Escape', 'ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        onClose()
      } else if (event.key === 'ArrowDown' && matches.length) {
        setCursor((index) => (index + 1) % matches.length)
      } else if (event.key === 'ArrowUp' && matches.length) {
        setCursor((index) => (index - 1 + matches.length) % matches.length)
      } else if (event.key === 'Enter') {
        const folder = matches[cursor]?.folder
        if (folder && folder.id !== currentId) onChoose(folder)
      }
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [matches, cursor, currentId, onChoose, onClose])

  useEffect(() => {
    const list = ref.current?.querySelector<HTMLElement>('.folder-picker__list')
    const item = list?.querySelector<HTMLElement>('[data-active="true"]')
    if (!list || !item) return
    const top = item.offsetTop - list.offsetTop
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + item.offsetHeight - list.clientHeight
    }
  }, [cursor, query])

  return (
    <div
      className="context-menu__backdrop"
      onMouseDown={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div
        className="context-menu folder-picker"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Add to folder"
        style={{ left: position.x, top: position.y }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="folder-picker__title">Add to folder</div>
        <label className="folder-picker__search">
          <Search {...ICON} />
          <input
            autoFocus
            aria-label="Find a folder"
            placeholder="Find a folder…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setCursor(0)
            }}
          />
        </label>
        <div className="folder-picker__list">
          {matches.map(({ folder, path }, index) => (
            <button
              key={folder.id}
              className="context-menu__item"
              type="button"
              title={path}
              data-active={index === cursor}
              disabled={folder.id === currentId}
              onMouseEnter={() => setCursor(index)}
              onClick={() => onChoose(folder)}
            >
              <FolderIcon {...ICON} />
              <span className="context-menu__label">{path}</span>
              {folder.id === currentId && <Check {...ICON} aria-label="Current folder" />}
            </button>
          ))}
          {!matches.length && (
            <div className="folder__empty">{folders.length ? 'No matching folders' : 'No folders yet'}</div>
          )}
        </div>
      </div>
    </div>
  )
}
