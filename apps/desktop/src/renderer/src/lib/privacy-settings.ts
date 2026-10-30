import { useSyncExternalStore } from 'react'

import { BUILT_IN_PASSWORD_MANAGERS, type FollowFrontAppContext } from './follow-front-app'

// Plan 210 D11: Hide screen for password managers, per device. On by
// default, with a built-in list the streamer can add apps to and take apps
// off. Nothing is stored until they change something, and an empty list
// means the built-in one (owner rule, 2026-10-24: an empty user list never
// means silence). The Scene page edits it; S10's follower reads it through
// `passwordManagerFollowContext`.

export const PRIVACY_SETTINGS_STORAGE_KEY = 'videorc.privacySettings.v1'

/** An app the streamer added, kept with its name so the list can show it while it isn't running. */
export type AddedPasswordManager = { bundleId: string; name: string }

export type PrivacySettings = {
  /** D11's switch: hide while a password manager is in front. */
  hideForPasswordManagers: boolean
  /** Apps added beyond the built-in list, in the order they were added. */
  addedPasswordManagers: AddedPasswordManager[]
  /** Built-in bundle ids taken off the list (every variant of one app). */
  removedPasswordManagerBundleIds: string[]
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  hideForPasswordManagers: true,
  addedPasswordManagers: [],
  removedPasswordManagerBundleIds: []
}

/**
 * The built-in list by name: each product once, with every bundle id it
 * ships under. One copy, the follower's (`follow-front-app.ts`).
 */
export { BUILT_IN_PASSWORD_MANAGERS }

/** One row of the list: a built-in app (all its variants) or an added one. */
export type PasswordManagerEntry = {
  /** The first bundle id, stable across launches: the row's key and `removePasswordManager`'s argument. */
  id: string
  name: string
  bundleIds: readonly string[]
  builtIn: boolean
}

const MAX_ADDED = 100
const MAX_BUNDLE_ID = 255
const MAX_NAME = 120

const key = (bundleId: string): string => bundleId.toLowerCase()

function builtInFor(bundleId: string) {
  const wanted = key(bundleId)
  return BUILT_IN_PASSWORD_MANAGERS.find((app) => app.bundleIds.some((id) => key(id) === wanted))
}

function entriesOf(settings: PrivacySettings): PasswordManagerEntry[] {
  const removed = new Set(settings.removedPasswordManagerBundleIds.map(key))
  const builtIn = BUILT_IN_PASSWORD_MANAGERS.filter(
    (app) => !app.bundleIds.every((id) => removed.has(key(id)))
  ).map((app) => ({
    id: app.bundleIds[0],
    name: app.name,
    bundleIds: app.bundleIds,
    builtIn: true
  }))
  const added = settings.addedPasswordManagers.map((app) => ({
    id: app.bundleId,
    name: app.name,
    bundleIds: [app.bundleId],
    builtIn: false
  }))
  return [...builtIn, ...added]
}

/**
 * The list as the Scene page shows it: the built-in apps still on it, by
 * name, then the added ones. Never empty: with nothing left it is the
 * built-in list again.
 */
export function passwordManagerEntries(settings: PrivacySettings): PasswordManagerEntry[] {
  const entries = entriesOf(settings)
  return entries.length > 0 ? entries : entriesOf(DEFAULT_PRIVACY_SETTINGS)
}

/** Whether any built-in app was taken off the list (the list offers to restore them). */
export function builtInPasswordManagersRemoved(settings: PrivacySettings): boolean {
  return (
    entriesOf(settings).filter((entry) => entry.builtIn).length < BUILT_IN_PASSWORD_MANAGERS.length
  )
}

/**
 * What S10's follower passes to `reduceFollowFrontApp`: the switch, the
 * additions and the removals. An effective list that would be empty gives
 * the built-in one back instead of silence.
 */
export function passwordManagerFollowContext(
  settings: PrivacySettings
): Required<
  Pick<
    FollowFrontAppContext,
    'passwordManagerHideEnabled' | 'passwordManagerBundleIds' | 'removedPasswordManagerBundleIds'
  >
> {
  const empty = entriesOf(settings).length === 0
  return {
    passwordManagerHideEnabled: settings.hideForPasswordManagers,
    passwordManagerBundleIds: settings.addedPasswordManagers.map((app) => app.bundleId),
    removedPasswordManagerBundleIds: empty ? [] : [...settings.removedPasswordManagerBundleIds]
  }
}

/**
 * Puts an app on the list. A built-in app that was taken off comes back
 * whole (every variant); one already on the list changes nothing.
 */
export function addPasswordManager(
  settings: PrivacySettings,
  app: AddedPasswordManager
): PrivacySettings {
  const bundleId = app.bundleId.trim()
  const name = app.name.trim() || bundleId
  if (!bundleId || bundleId.length > MAX_BUNDLE_ID) return settings
  const builtIn = builtInFor(bundleId)
  if (builtIn) {
    const variants = new Set(builtIn.bundleIds.map(key))
    const removed = settings.removedPasswordManagerBundleIds.filter((id) => !variants.has(key(id)))
    return removed.length === settings.removedPasswordManagerBundleIds.length
      ? settings
      : { ...settings, removedPasswordManagerBundleIds: removed }
  }
  if (settings.addedPasswordManagers.some((entry) => key(entry.bundleId) === key(bundleId)))
    return settings
  if (settings.addedPasswordManagers.length >= MAX_ADDED) return settings
  return {
    ...settings,
    addedPasswordManagers: [
      ...settings.addedPasswordManagers,
      { bundleId, name: name.slice(0, MAX_NAME) }
    ]
  }
}

/**
 * Takes one row off the list by its `id`: an added app is forgotten, a
 * built-in one is remembered as removed. The last row stays (an empty list
 * would mean the built-in one): the switch is how to stop hiding.
 */
export function removePasswordManager(settings: PrivacySettings, id: string): PrivacySettings {
  if (!canRemovePasswordManager(settings)) return settings
  const builtIn = builtInFor(id)
  if (builtIn) {
    const removed = new Set(settings.removedPasswordManagerBundleIds.map(key))
    const additions = builtIn.bundleIds.filter((bundleId) => !removed.has(key(bundleId)))
    return additions.length === 0
      ? settings
      : {
          ...settings,
          removedPasswordManagerBundleIds: [
            ...settings.removedPasswordManagerBundleIds,
            ...additions
          ]
        }
  }
  const added = settings.addedPasswordManagers.filter((app) => key(app.bundleId) !== key(id))
  return added.length === settings.addedPasswordManagers.length
    ? settings
    : { ...settings, addedPasswordManagers: added }
}

/** Whether a row can come off: never the last one. */
export function canRemovePasswordManager(settings: PrivacySettings): boolean {
  return entriesOf(settings).length > 1
}

/** Every built-in app back on the list; added apps stay. */
export function restoreBuiltInPasswordManagers(settings: PrivacySettings): PrivacySettings {
  return settings.removedPasswordManagerBundleIds.length === 0
    ? settings
    : { ...settings, removedPasswordManagerBundleIds: [] }
}

export function setHideForPasswordManagers(
  settings: PrivacySettings,
  on: boolean
): PrivacySettings {
  return settings.hideForPasswordManagers === on
    ? settings
    : { ...settings, hideForPasswordManagers: on }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((item) => {
    if (typeof item !== 'string') return []
    const id = item.trim()
    if (!id || id.length > MAX_BUNDLE_ID || seen.has(key(id))) return []
    seen.add(key(id))
    return [id]
  })
}

/** Parses what was stored; anything unreadable is the default, field by field. */
export function parsePrivacySettings(value: unknown): PrivacySettings {
  if (!value || typeof value !== 'object') return DEFAULT_PRIVACY_SETTINGS
  const record = value as Record<string, unknown>
  const added = Array.isArray(record.addedPasswordManagers) ? record.addedPasswordManagers : []
  let settings: PrivacySettings = {
    hideForPasswordManagers:
      typeof record.hideForPasswordManagers === 'boolean'
        ? record.hideForPasswordManagers
        : DEFAULT_PRIVACY_SETTINGS.hideForPasswordManagers,
    addedPasswordManagers: [],
    removedPasswordManagerBundleIds: stringList(record.removedPasswordManagerBundleIds).filter(
      (id) => builtInFor(id) !== undefined
    )
  }
  for (const app of added) {
    if (!app || typeof app !== 'object') continue
    const { bundleId, name } = app as Record<string, unknown>
    if (typeof bundleId !== 'string' || builtInFor(bundleId)) continue
    settings = addPasswordManager(settings, {
      bundleId,
      name: typeof name === 'string' ? name : bundleId
    })
  }
  return settings
}

export function loadPrivacySettings(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage
): PrivacySettings {
  try {
    const raw = storage?.getItem(PRIVACY_SETTINGS_STORAGE_KEY)
    return raw ? parsePrivacySettings(JSON.parse(raw)) : DEFAULT_PRIVACY_SETTINGS
  } catch {
    return DEFAULT_PRIVACY_SETTINGS
  }
}

/** Stores the settings; the defaults store nothing, so a fresh device keeps none. */
export function savePrivacySettings(
  settings: PrivacySettings,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage
): void {
  try {
    const isDefault =
      settings.hideForPasswordManagers === DEFAULT_PRIVACY_SETTINGS.hideForPasswordManagers &&
      settings.addedPasswordManagers.length === 0 &&
      settings.removedPasswordManagerBundleIds.length === 0
    if (isDefault) storage?.removeItem(PRIVACY_SETTINGS_STORAGE_KEY)
    else storage?.setItem(PRIVACY_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage can be unavailable in a hardened renderer; the change still
    // holds for this window's lifetime.
  }
}

// One copy per window, read once and kept in step with every change, so the
// Scene page and S10's follower agree without a context.
let current: PrivacySettings | null = null
const listeners = new Set<() => void>()

/** The settings now (S10's follower reads them on each front-app change). */
export function getPrivacySettings(): PrivacySettings {
  current ??= loadPrivacySettings()
  return current
}

/** Changes the settings, stores them and tells every reader. */
export function updatePrivacySettings(
  change: (settings: PrivacySettings) => PrivacySettings
): void {
  const previous = getPrivacySettings()
  const next = change(previous)
  if (next === previous) return
  current = next
  savePrivacySettings(next)
  for (const listener of listeners) listener()
}

export function subscribePrivacySettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The settings for a component, re-rendered on every change. */
export function usePrivacySettings(): PrivacySettings {
  return useSyncExternalStore(subscribePrivacySettings, getPrivacySettings, getPrivacySettings)
}

/** Tests start from the stored value again. */
export function resetPrivacySettingsForTest(): void {
  current = null
  listeners.clear()
}
