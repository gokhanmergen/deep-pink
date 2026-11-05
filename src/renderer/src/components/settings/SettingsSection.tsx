import { Children, isValidElement, type ReactNode } from 'react'
import type { SettingsTab } from '../../store'
import { useStore } from '../../store'
import { ChevronRight } from 'lucide-react'
import {
  SETTINGS_PAGES,
  SETTINGS_CATEGORIES,
  SETTINGS_DISCLOSURES,
  settingsCategory,
  matchesSettingsQuery
} from './catalogue'

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
  if (info.experimental && hideExperimental && !(page === 'codex' && activePage === 'codex'))
    return null
  const searching = Boolean(query.trim())
  if (!searching && settingsCategory(page) !== settingsCategory(activePage)) return null
  const disclosure = SETTINGS_DISCLOSURES[sectionId]
  const searchableText = [
    info.label,
    info.keywords,
    SETTINGS_CATEGORIES[settingsCategory(page)].label,
    disclosure?.title,
    disclosure?.hint,
    keywords,
    labelText(children)
  ].join(' ')
  if (searching && !matchesSettingsQuery(query, searchableText)) return null
  const content = Children.toArray(children)
  const attributes = {
    className: 'settings-card',
    id: sectionId,
    'data-settings-section': true,
    'data-settings-page': page
  }

  // Search results expose matching controls immediately. Direct links from chat
  // also open their destination, including the normally hidden Codex notice.
  if (disclosure && !searching) {
    const first = content[0]
    const hasHeading = isValidElement(first) && first.type === 'h3'
    return (
      <details
        {...attributes}
        className="settings-card settings-disclosure"
        key={activePage}
        open={activePage === page && settingsCategory(page) !== page}
      >
        <summary>
          <ChevronRight size={16} aria-hidden="true" />
          <span>
            <span className="settings-disclosure__title">{disclosure.title}</span>
            <span className="settings-disclosure__hint">{disclosure.hint}</span>
          </span>
          {info.experimental && <span className="settings-disclosure__badge">Experimental</span>}
        </summary>
        <div className="settings-disclosure__body">{hasHeading ? content.slice(1) : content}</div>
      </details>
    )
  }

  return (
    <section {...attributes}>
      {searching && <div className="settings-card__category">{info.label}</div>}
      {content}
    </section>
  )
}
