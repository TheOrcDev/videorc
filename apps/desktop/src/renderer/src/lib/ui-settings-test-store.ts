// Tests only (plan 220 S1.4b): the backend's UI settings store in memory, with
// the semantics of `ui_settings.rs` (one revision, `ifAbsent`, the migration
// mark, the change event to every connected window), and a hydrated window
// store over it. `ui-settings-test-setup.ts` gives every test a fresh one, so
// the key families read and write the way they do in a window whose store
// holds the engine's snapshot. A test that wants two windows hands both the
// same engine.

import type {
  UiSettingsChange,
  UiSettingsGetParams,
  UiSettingsSetParams,
  UiSettingsSnapshot,
  UiSettingsValue
} from '../../../shared/backend'
import {
  createUiSettingsStore,
  type UiSettingsStorage,
  type UiSettingsStore,
  type UiSettingsTransport
} from './ui-settings-store'
import { setWindowUiSettingsStoreForTests } from './ui-settings-storage'

export interface MemoryUiSettingsEngine {
  readonly entries: Map<string, UiSettingsValue>
  /** A window's connection to the engine. */
  transport(): UiSettingsTransport
}

export function createMemoryUiSettingsEngine(
  initial: Record<string, UiSettingsValue> = {},
  { localStorageMigrated = true }: { localStorageMigrated?: boolean } = {}
): MemoryUiSettingsEngine {
  const entries = new Map(Object.entries(initial))
  const listeners = new Set<(change: UiSettingsChange) => void>()
  let revision = 0
  let migrated = localStorageMigrated

  function snapshot(params?: UiSettingsGetParams): UiSettingsSnapshot {
    const wanted = params?.keys?.length ? new Set(params.keys) : null
    return {
      entries: Object.fromEntries(
        [...entries].filter(([key]) => wanted === null || wanted.has(key))
      ),
      revision,
      localStorageMigrated: migrated
    }
  }

  function apply(params: UiSettingsSetParams): UiSettingsChange {
    const put: Record<string, UiSettingsValue> = {}
    const deletes: string[] = []
    for (const [key, value] of Object.entries(params.put ?? {})) {
      if (params.ifAbsent && entries.has(key)) continue
      entries.set(key, value)
      put[key] = value
    }
    for (const key of params.delete ?? []) {
      if (entries.delete(key)) deletes.push(key)
    }
    const landed = Object.keys(put).length > 0 || deletes.length > 0
    if (landed || params.localStorageMigrated) revision += 1
    if (params.localStorageMigrated) migrated = true
    const change: UiSettingsChange = { revision, put, delete: deletes }
    if (params.writer !== undefined) change.writer = params.writer
    if (landed || params.localStorageMigrated) {
      for (const listener of [...listeners]) listener(structuredClone(change))
    }
    return change
  }

  return {
    entries,
    transport: () => ({
      get: async (params) => structuredClone(snapshot(params)),
      set: async (params) => structuredClone(apply(params)),
      onChange(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    })
  }
}

/** A window store over `engine`, hydrated (the migration runs from `storage` when the engine says so). */
export async function createHydratedUiSettingsStore(
  engine: MemoryUiSettingsEngine,
  storage: UiSettingsStorage | null = null
): Promise<UiSettingsStore> {
  const store = createUiSettingsStore({
    transport: engine.transport(),
    storage,
    log: { warn: () => {}, error: () => {}, info: () => {} }
  })
  const hydration = await store.hydrate({ timeoutMs: 1_000 })
  if (hydration.state !== 'hydrated') {
    throw new Error(`The test UI settings store did not hydrate: ${JSON.stringify(hydration)}`)
  }
  return store
}

/** Makes a fresh hydrated store this window's (over a new engine unless one is given). */
export async function installTestUiSettingsStore(
  options: {
    entries?: Record<string, UiSettingsValue>
    engine?: MemoryUiSettingsEngine
    storage?: UiSettingsStorage | null
  } = {}
): Promise<{ store: UiSettingsStore; engine: MemoryUiSettingsEngine }> {
  const engine = options.engine ?? createMemoryUiSettingsEngine(options.entries)
  const store = await createHydratedUiSettingsStore(engine, options.storage ?? null)
  setWindowUiSettingsStoreForTests(store)
  return { store, engine }
}
