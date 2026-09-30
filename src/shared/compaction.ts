import { DEFAULT_COMPACTION } from './defaults'
import type { CompactionSettings } from './types'

/** Number inputs and imported settings can bypass the controls' limits. */
export function normalizeCompaction(input: Partial<CompactionSettings>): CompactionSettings {
  const ratio = input.triggerRatio
  const keep = input.keepRecentMessages
  return {
    ...DEFAULT_COMPACTION,
    ...input,
    triggerRatio:
      typeof ratio === 'number' && Number.isFinite(ratio)
        ? Math.min(0.95, Math.max(0.3, ratio))
        : DEFAULT_COMPACTION.triggerRatio,
    keepRecentMessages:
      typeof keep === 'number' && Number.isFinite(keep)
        ? Math.max(2, Math.floor(keep))
        : DEFAULT_COMPACTION.keepRecentMessages
  }
}
