import type { SettingsTab } from '../../store'

export interface SettingsPage {
  label: string
  keywords: string
  experimental?: boolean
}

export const SETTINGS_PAGES: Record<SettingsTab, SettingsPage> = {
  general: {
    label: 'General',
    keywords: 'enter send paste date time experimental lazy load performance setup wizard'
  },
  models: {
    label: 'Models',
    keywords: 'default model comparison side by side thread names titles naming'
  },
  appearance: {
    label: 'Appearance',
    keywords: 'color colour accent font text size spacing width theme animation reply statistics'
  },
  keys: {
    label: 'Shortcuts',
    keywords: 'keyboard keybind hotkey shortcut'
  },
  account: {
    label: 'Account',
    keywords: 'api key account openrouter billing credits attribution privacy'
  },
  data: {
    label: 'Data',
    keywords: 'data database storage backup import export chatgpt delete conversations'
  },
  about: {
    label: 'Updates & about',
    keywords:
      "update upgrade download install version release about license source features whats new what's new release notes changelog"
  },
  prompts: {
    label: 'Instructions',
    keywords: 'prompt system instructions behavior behaviour personality'
  },
  context: {
    label: 'Context & memory',
    keywords:
      'context memory compaction summary summarize summarise threshold limit recent messages'
  },
  advanced: {
    label: 'Generation',
    keywords:
      'generation temperature randomness output tokens limit reasoning thinking effort budget stream'
  },
  web: {
    label: 'Web search',
    keywords:
      'web search fetch internet provider brave bing duckduckgo searxng openrouter domains experimental',
    experimental: true
  },
  skills: {
    label: 'Skills',
    keywords: 'skill charts custom instructions load on demand every turn experimental',
    experimental: true
  },
  keyPoint: {
    label: 'Highlights',
    keywords: 'highlights key point important sentence jev typesafe experimental',
    experimental: true
  },
  sync: {
    label: 'Sync',
    keywords:
      'sync cloud bucket s3 aws r2 backup devices encryption secret credentials experimental',
    experimental: true
  }
}

export function matchesSettingsQuery(query: string, text: string): boolean {
  const normalize = (value: string): string =>
    value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  const haystack = normalize(text)
  return normalize(query)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term))
}
