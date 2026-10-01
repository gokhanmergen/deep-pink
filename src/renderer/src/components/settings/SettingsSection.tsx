import { Children, isValidElement, type ReactNode } from 'react'
import type { SettingsTab } from '../../store'
import { useStore } from '../../store'
import { SETTINGS_PAGES, matchesSettingsQuery } from './catalogue'

/** Index visible labels, never password values or editable prompt contents. */
function labelText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(labelText).join(' ')
  if (
    !isValidElement<{
      children?: ReactNode
      'aria-label'?: string
      title?: string
    }>(node)
  )
    return ''
  return [node.props['aria-label'], node.props.title, labelText(node.props.children)]
    .filter(Boolean)
    .join(' ')
}

export function SettingsSection({
  page,
  activePage,
  query,
  sectionId,
  keywords,
  children
}: {
  page: SettingsTab
  activePage: SettingsTab
  query: string
  sectionId: string
  keywords: string
  children: ReactNode
}): React.JSX.Element | null {
  const info = SETTINGS_PAGES[page]
  const hideExperimental = useStore((s) => s.settings?.hideExperimental ?? true)
  if (info.experimental && hideExperimental) return null
  const searching = Boolean(query.trim())
  if (!searching && page !== activePage) return null
  if (searching && !matchesSettingsQuery(query, `${info.label} ${keywords} ${labelText(children)}`))
    return null

  return (
    <section
      className="settings-card"
      id={sectionId}
      data-settings-section
      data-settings-page={page}
    >
      {searching && <div className="settings-card__category">{info.label}</div>}
      {Children.toArray(children)}
    </section>
  )
}
