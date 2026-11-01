import { useSyncExternalStore } from 'react'

// Plan 210 D10: "Follow the app in front", per device. On by default, and
// nothing is stored until the streamer changes it (like
// `privacy-settings.ts`). The Scene list header's switch edits it; S10's
// follower reads it on every front-app change. macOS only (D12): other
// platforms never read it.

export const FOLLOW_SETTINGS_STORAGE_KEY = 'videorc.followSettings.v1'

export type FollowSettings = {
  /** D10's switch: the stream follows the app in front. */
  followFrontApp: boolean
}

export const DEFAULT_FOLLOW_SETTINGS: FollowSettings = { followFrontApp: true }

/** Parses what was stored; anything unreadable is the default. */
export function parseFollowSettings(value: unknown): FollowSettings {
  if (!value || typeof value !== 'object') return DEFAULT_FOLLOW_SETTINGS
  const record = value as Record<string, unknown>
  return {
    followFrontApp:
      typeof record.followFrontApp === 'boolean'
        ? record.followFrontApp
        : DEFAULT_FOLLOW_SETTINGS.followFrontApp
  }
}

export function loadFollowSettings(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage
): FollowSettings {
  try {
    const raw = storage?.getItem(FOLLOW_SETTINGS_STORAGE_KEY)
    return raw ? parseFollowSettings(JSON.parse(raw)) : DEFAULT_FOLLOW_SETTINGS
  } catch {
    return DEFAULT_FOLLOW_SETTINGS
  }
}

/** Stores the settings; the default stores nothing, so a fresh device keeps none. */
export function saveFollowSettings(
  settings: FollowSettings,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage
): void {
  try {
    if (settings.followFrontApp === DEFAULT_FOLLOW_SETTINGS.followFrontApp)
      storage?.removeItem(FOLLOW_SETTINGS_STORAGE_KEY)
    else storage?.setItem(FOLLOW_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage can be unavailable in a hardened renderer; the change still
    // holds for this window's lifetime.
  }
}

export function setFollowFrontApp(settings: FollowSettings, on: boolean): FollowSettings {
  return settings.followFrontApp === on ? settings : { ...settings, followFrontApp: on }
}

let current: FollowSettings | null = null
const listeners = new Set<() => void>()

/** The settings now (the follower reads them on each front-app change). */
export function getFollowSettings(): FollowSettings {
  current ??= loadFollowSettings()
  return current
}

/** Changes the settings, stores them and tells every reader. */
export function updateFollowSettings(change: (settings: FollowSettings) => FollowSettings): void {
  const previous = getFollowSettings()
  const next = change(previous)
  if (next === previous) return
  current = next
  saveFollowSettings(next)
  for (const listener of listeners) listener()
}

export function subscribeFollowSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The settings for a component, re-rendered on every change. */
export function useFollowSettings(): FollowSettings {
  return useSyncExternalStore(subscribeFollowSettings, getFollowSettings, getFollowSettings)
}

/** Tests start from the stored value again. */
export function resetFollowSettingsForTest(): void {
  current = null
  listeners.clear()
}
