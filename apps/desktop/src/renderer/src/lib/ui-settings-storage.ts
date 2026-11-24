// What the key families read and write their product state through (plan 220
// S1.4b): this window's UI settings store, in the `Storage` shape the
// families were written against, so every key keeps its name and every value
// its string shape (the S1.4a migration copied each value verbatim as a JSON
// string, and the families keep writing strings).
//
// The window's store lives here, in a module with no runtime imports beyond
// the store's limits, so a lib like capture.ts can read through it without
// pulling the engine transport in. `ui-settings-window.ts` provides the
// factory (each window entry imports it before its first render); tests and
// the node smokes put a store of their own in its place.

import type { UiSettingsValue } from '../../../shared/backend'
import { migrationRefusal } from './ui-settings-limits'
import type { UiSettingsStore } from './ui-settings-store'

/** The slice of `Storage` the key families use. */
export interface UiSettingsKeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

let store: UiSettingsStore | null = null
let createStore: (() => UiSettingsStore) | null = null

/** `ui-settings-window.ts` hands over how this window builds its store. */
export function provideWindowUiSettingsStore(create: () => UiSettingsStore): void {
  createStore = create
}

/** This window's one store; built on first use. */
export function windowUiSettingsStore(): UiSettingsStore {
  if (store) return store
  if (!createStore) {
    throw new Error(
      'This window has no UI settings store: its entry must import lib/ui-settings-window before any key family is read.'
    )
  }
  store = createStore()
  return store
}

/** Tests and node smokes only: this window's store becomes `next` (null: built again on next use). */
export function setWindowUiSettingsStoreForTests(next: UiSettingsStore | null): void {
  store = next
}

/** True once this window's store holds the engine's snapshot. */
export function windowUiSettingsHydrated(): boolean {
  return windowUiSettingsStore().status().hydration.state === 'hydrated'
}

/** A stored value as the string the family wrote (anything else, written by a newer UI, as its JSON). */
export function uiSettingsValueAsString(value: UiSettingsValue | undefined): string | null {
  if (value === undefined) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * A `Storage`-shaped view over a store. A write the engine would refuse (a
 * key or value past its limits) throws here, at once, the way full web
 * storage threw, so the families' existing "could not save" paths
 * still run; every other write lands in the cache synchronously and reaches
 * the engine in the tick's batch.
 *
 * Before the store holds the engine's snapshot (a window that rendered past
 * the hydrate deadline) every family read its defaults, and the writes it
 * makes from them would overwrite the profile's real values once the engine
 * answers. Those writes are refused (named once in the console) instead; the
 * window reloads when the snapshot arrives (`ui-settings-window.ts`).
 */
export function uiSettingsKeyValue(
  resolve: () => Pick<UiSettingsStore, 'get' | 'set' | 'remove' | 'status'>
): UiSettingsKeyValueStorage {
  const refusedBeforeSnapshot = new Set<string>()
  const writable = (key: string): boolean => {
    const store = resolve()
    if (store.status().hydration.state === 'hydrated') return true
    if (!refusedBeforeSnapshot.has(key)) {
      refusedBeforeSnapshot.add(key)
      console.warn(
        `[ui-settings] "${key}" was not saved: the store has no snapshot yet, so this window's value may be a default.`
      )
    }
    return false
  }
  return {
    getItem: (key) => uiSettingsValueAsString(resolve().get(key)),
    setItem: (key, value) => {
      const text = String(value)
      const refusal = migrationRefusal(key, text)
      if (refusal) throw new Error(`UI setting "${key}" was not saved: ${refusal}`)
      if (writable(key)) resolve().set(key, text)
    },
    removeItem: (key) => {
      if (writable(key)) resolve().remove(key)
    }
  }
}

const windowStorage = uiSettingsKeyValue(windowUiSettingsStore)

/** This window's store as `Storage`: every product key family reads and writes through it. */
export function uiSettingsStorage(): UiSettingsKeyValueStorage {
  return windowStorage
}

/** Calls `listener` when another window (or this one) changes `key`. */
export function subscribeUiSetting(key: string, listener: () => void): () => void {
  return windowUiSettingsStore().subscribe((keys) => {
    if (keys.has(key)) listener()
  })
}
