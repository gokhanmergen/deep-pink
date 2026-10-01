import type { SettingsTab } from '../../store'

export interface SettingsPage {
  label: string
  description: string
  keywords: string
  experimental?: boolean
}

export const SETTINGS_PAGES: Record<SettingsTab, SettingsPage> = {
  general: {
    label: 'General',
    description: 'Everyday chat preferences.',
    keywords: 'enter send paste date time experimental lazy load performance setup wizard'
  },
  models: {
    label: 'Models',
    description: 'Choose your models and how conversations begin.',
    keywords: 'default model comparison side by side thread names titles naming'
  },
  appearance: {
    label: 'Appearance',
    description: 'Make the conversation comfortable to read.',
    keywords: 'color colour accent font text size spacing width theme animation reply statistics'
  },
  keys: {
    label: 'Shortcuts',
    description: 'Keyboard controls for the way you work.',
    keywords: 'keyboard keybind hotkey shortcut'
  },
  account: {
    label: 'Account',
    description: 'Your OpenRouter connection and privacy preferences.',
    keywords: 'api key account openrouter billing credits attribution privacy'
  },
  data: {
    label: 'Data',
    description: 'Your library, stored on this device.',
    keywords: 'data database storage backup import export chatgpt delete conversations'
  },
  about: {
    label: 'Updates & about',
    description: 'Keep Deep Pink up to date.',
    keywords: 'update upgrade download install version release about license source'
  },
  prompts: {
    label: 'Instructions',
    description: 'Set the instructions shared by your conversations.',
    keywords: 'prompt system instructions behavior behaviour personality'
  },
  context: {
    label: 'Context & memory',
    description: 'Manage how long conversations are summarized.',
    keywords:
      'context memory compaction summary summarize summarise threshold limit recent messages'
  },
  advanced: {
    label: 'Generation',
    description: 'Fine-tune model output and reasoning.',
    keywords:
      'generation temperature randomness output tokens limit reasoning thinking effort budget stream'
  },
  web: {
    label: 'Web search',
    description: 'Search the web and read pages in a conversation.',
    keywords:
      'web search fetch internet provider brave bing duckduckgo searxng openrouter domains experimental',
    experimental: true
  },
  skills: {
    label: 'Skills',
    description: 'Reusable instructions and charts.',
    keywords: 'skill charts custom instructions load on demand every turn experimental',
    experimental: true
  },
  keyPoint: {
    label: 'Highlights',
    description: 'Mark the key sentences in a reply.',
    keywords: 'highlights key point important sentence jev typesafe experimental',
    experimental: true
  },
  sync: {
    label: 'Sync',
    description: 'Keep your library in sync across devices.',
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
