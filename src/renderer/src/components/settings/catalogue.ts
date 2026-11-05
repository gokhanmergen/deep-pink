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
  codex: {
    label: 'Codex',
    keywords:
      'codex openai app server cli provider enable disable warning notice limitations experimental sign in login web search native built in',
    experimental: true
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
      'web search fetch internet provider brave bing duckduckgo searxng openrouter domains'
  },
  webServer: {
    label: 'Web server',
    keywords:
      'localhost api prompt endpoint reply model system prompt background tray experimental integration',
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

/** Keep stored destinations stable so links from the rest of the app still work. */
export const SETTINGS_CATEGORIES = {
  general: { label: 'General', description: 'Everyday messaging and app preferences.' },
  appearance: { label: 'Appearance', description: 'Colors, text size and conversation layout.' },
  models: { label: 'Models & responses', description: 'Choose your models and customize how they respond.' },
  keys: { label: 'Shortcuts', description: 'Keyboard shortcuts for navigating and writing messages.' },
  account: { label: 'Connections', description: 'Connect OpenRouter and manage provider privacy.' },
  web: { label: 'Tools', description: 'Web search and optional capabilities for your conversations.' },
  data: { label: 'Data & sync', description: 'Manage local storage, import conversations and sync devices.' },
  about: { label: 'Updates & about', description: 'App updates, version information and project links.' }
} as const

export function settingsCategory(page: SettingsTab): keyof typeof SETTINGS_CATEGORIES {
  switch (page) {
    case 'prompts':
    case 'context':
    case 'advanced':
      return 'models'
    case 'codex':
      return 'account'
    case 'skills':
    case 'keyPoint':
    case 'webServer':
      return 'web'
    case 'sync':
      return 'data'
    default:
      return page
  }
}

/** Less common controls stay available without dominating the initial view. */
export const SETTINGS_DISCLOSURES: Record<string, { title: string; hint: string }> = {
  'settings-models-1': { title: 'Compare models', hint: 'Set up side-by-side responses.' },
  'settings-models-2': { title: 'Conversation titles', hint: 'Choose how conversations are named.' },
  'settings-prompts-0': { title: 'Custom instructions', hint: 'Set default instructions for the model.' },
  'settings-context-0': { title: 'Context & memory', hint: 'Control how long conversations are summarized.' },
  'settings-advanced-0': { title: 'Generation controls', hint: 'Adjust reasoning, randomness and response limits.' },
  'settings-appearance-1': { title: 'Response details', hint: 'Choose which statistics appear with replies.' },
  'settings-codex-0': { title: 'Codex', hint: 'Enable Codex and configure its chat features.' },
  'settings-webServer-0': { title: 'Local web server', hint: 'Expose an endpoint for other apps.' },
  'settings-skills-0': { title: 'Skills', hint: 'Manage charts and reusable model instructions.' },
  'settings-keyPoint-0': { title: 'Highlights', hint: 'Configure automatic key-point highlighting.' },
  'settings-data-2': { title: 'Delete conversations', hint: 'Permanently remove all conversation data.' },
  'settings-sync-0': { title: 'Device sync', hint: 'Enable encrypted sync between machines.' },
  'settings-sync-1': { title: 'Sync encryption key', hint: 'Generate or import a key shared by your devices.' },
  'settings-sync-2': { title: 'Sync cloud storage', hint: 'Connect an S3-compatible storage bucket.' },
  'settings-sync-3': { title: 'Sync preferences', hint: 'Choose what travels and identify this device.' },
  'settings-sync-4': { title: 'Sync status', hint: 'Check progress or run a sync now.' },
  'settings-sync-5': { title: 'Disconnect sync', hint: 'Remove sync credentials from this machine.' }
}
