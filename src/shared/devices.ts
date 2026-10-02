import type { DeviceColor, DeviceIcon, DeviceProfile } from './types'

export const DEFAULT_DEVICE_COLOR: DeviceColor = '#8b8cff'

export function normalizeDeviceColor(value: unknown): DeviceColor {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)
    ? (value.toLowerCase() as DeviceColor)
    : DEFAULT_DEVICE_COLOR
}

export function normalizeDeviceIcon(value: unknown): DeviceIcon {
  return value === 'laptop' ? 'laptop' : 'desktop'
}

export function normalizeDeviceProfiles(value: unknown): DeviceProfile[] {
  if (!Array.isArray(value)) return []
  const profiles = new Map<string, DeviceProfile>()

  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const profile = item as Record<string, unknown>
    if (typeof profile.id !== 'string' || !profile.id.trim()) continue
    profiles.set(profile.id, {
      id: profile.id,
      name: typeof profile.name === 'string' && profile.name.trim() ? profile.name : 'Device',
      icon: normalizeDeviceIcon(profile.icon),
      color: normalizeDeviceColor(profile.color)
    })
  }

  return [...profiles.values()]
}

export function mergeDeviceProfiles(...groups: unknown[]): DeviceProfile[] {
  return normalizeDeviceProfiles(groups.flatMap((group) =>
    Array.isArray(group) ? group : group && typeof group === 'object' ? [group] : []
  ))
}
