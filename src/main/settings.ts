import { DEFAULT_KEYBINDS, DEFAULT_SETTINGS } from '@shared/defaults'
import type { Settings, SettingsPatch } from '@shared/types'
import { getSetting, setSetting } from './db/repo'
import { hasApiKey } from './secrets'

const KEY = 'settings'

/** Stored settings merged over defaults, so new options appear on upgrade. */
export function loadSettings(): Settings {
  const stored = getSetting<Partial<Settings>>(KEY, {})
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    // Always reflect reality rather than whatever was persisted.
    hasApiKey: hasApiKey(),
    defaultProviderRouting: {
      ...DEFAULT_SETTINGS.defaultProviderRouting,
      ...stored.defaultProviderRouting
    },
    modelProviderRouting: stored.modelProviderRouting ?? {},
    web: { ...DEFAULT_SETTINGS.web, ...stored.web },
    compaction: { ...DEFAULT_SETTINGS.compaction, ...stored.compaction },
    ui: { ...DEFAULT_SETTINGS.ui, ...stored.ui },
    keybinds: { ...DEFAULT_KEYBINDS, ...stored.keybinds }
  }
}

export function saveSettings(patch: SettingsPatch): Settings {
  const current = loadSettings()
  const next: Settings = {
    ...current,
    ...patch,
    defaultProviderRouting: { ...current.defaultProviderRouting, ...patch.defaultProviderRouting },
    modelProviderRouting: patch.modelProviderRouting ?? current.modelProviderRouting,
    web: { ...current.web, ...patch.web },
    compaction: { ...current.compaction, ...patch.compaction },
    ui: { ...current.ui, ...patch.ui },
    keybinds: { ...current.keybinds, ...patch.keybinds }
  }

  // `hasApiKey` is derived, never authoritative.
  const { hasApiKey: _derived, ...persistable } = next
  setSetting(KEY, persistable)
  return next
}
