import { DEFAULT_KEYBINDS, DEFAULT_SETTINGS } from '@shared/defaults'
import type { Settings, SettingsPatch } from '@shared/types'
import { getSetting, setSetting } from './db/repo'
import { hasApiKey } from './secrets'

const KEY = 'settings'

/**
 * Whether an install was already using something experimental.
 *
 * `hideExperimental` arrives switched on, which is right for somebody opening
 * the app for the first time and wrong for everybody already here: it would
 * reach in and turn off a bucket they sync to and a web search they rely on,
 * for the crime of upgrading. So an install that had already switched one of
 * these on is not hiding anything — it has seen them and decided.
 *
 * Read from what is stored rather than from the merged result, because the
 * question is what somebody chose, and a default is not a choice.
 */
function alreadyExperimenting(stored: Partial<Settings>): boolean {
  return Boolean(
    stored.chartsEnabled ||
      stored.keyPointEnabled ||
      stored.web?.enabled ||
      stored.sendAppAttribution === false
  )
}

/** Stored settings merged over defaults, so new options appear on upgrade. */
export function loadSettings(): Settings {
  const raw = getSetting<Partial<Settings> & { docsEnabled?: unknown }>(KEY, {})
  // Older settings can still carry this removed feature's switch. Drop it as
  // the settings are read so the next save also removes it from storage.
  const { docsEnabled: _legacyDocsEnabled, ...stored } = raw
  void _legacyDocsEnabled
  const keybinds = { ...DEFAULT_KEYBINDS, ...stored.keybinds }
  delete keybinds['docs.toggle']
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    hideExperimental: stored.hideExperimental ?? !alreadyExperimenting(stored),
    // Always reflect reality rather than whatever was persisted.
    hasApiKey: hasApiKey(),
    defaultProviderRouting: {
      ...DEFAULT_SETTINGS.defaultProviderRouting,
      ...stored.defaultProviderRouting
    },
    modelProviderRouting: stored.modelProviderRouting ?? {},
    web: { ...DEFAULT_SETTINGS.web, ...stored.web },
    compaction: { ...DEFAULT_SETTINGS.compaction, ...stored.compaction },
    ui: {
      ...DEFAULT_SETTINGS.ui,
      ...stored.ui,
      // One level deeper, so a switch added after somebody last saved arrives
      // with its default rather than as undefined.
      replyChips: { ...DEFAULT_SETTINGS.ui.replyChips, ...stored.ui?.replyChips }
    },
    keybinds
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
    ui: {
      ...current.ui,
      ...patch.ui,
      replyChips: { ...current.ui.replyChips, ...patch.ui?.replyChips }
    },
    keybinds: { ...current.keybinds, ...patch.keybinds }
  }

  // `hasApiKey` is derived, never authoritative.
  const { hasApiKey: _derived, ...persistable } = next
  setSetting(KEY, persistable)
  return next
}
