// The UI settings cache (plan 220 S1.4a): what a window reads its product
// state from now that the backend holds it (`ui.settings.get`/`set`, the
// `app_settings` rows under `ui:`), in place of `localStorage`.
//
// Shape: one store per window. The window hydrates it once before its first
// render (the whole snapshot), reads synchronously from the cache, and writes
// through: a write lands in the cache at once, is coalesced with the other
// writes of the same tick into one `ui.settings.set` batch, and the batch's
// answer is the truth. Every other window hears the batch as
// `ui.settings.changed` and applies it, the way `localStorage`'s `storage`
// event used to reach them; the writing window skips its own echo (`writer`).
//
// Before the engine answers (the window opened before the backend was up, the
// engine is restarting): reads say so (`undefined`, one warning per key, a
// count in `status()`), never a silent default; writes land in the cache and
// in a per-window journal in `localStorage`, so a window closed before the
// engine returns loses nothing: the next hydrate (any window, next launch)
// replays every journal. The hydrate itself is bounded: past the deadline the
// window renders with the store `unavailable` and the hydrate keeps trying.
//
// The one-time `localStorage` migration runs inside the first hydrate of a
// profile the previous release wrote: every `videorc.*` key the store lacks
// is copied verbatim (a JSON string per key) in `ifAbsent` batches marked
// `localStorageMigrated`, so two windows racing the same launch never
// overwrite each other. The `localStorage` values stay where they are, so a
// rollback to the previous release still finds them.

import type {
  UiSettingsChange,
  UiSettingsGetParams,
  UiSettingsSetParams,
  UiSettingsSnapshot,
  UiSettingsValue
} from '../../../shared/backend'
import {
  UI_SETTINGS_BATCH_MAX_BYTES,
  UI_SETTINGS_BATCH_MAX_KEYS,
  UI_SETTINGS_KEY_MAX_CHARS,
  UI_SETTINGS_VALUE_MAX_BYTES
} from '../../../shared/backend'

/** Every migrated key starts with this. */
export const UI_SETTINGS_LOCAL_STORAGE_PREFIX = 'videorc.'
/** A window's journal of writes the engine has not confirmed: `<prefix><writer>`. */
export const UI_SETTINGS_JOURNAL_PREFIX = 'videorc.uiSettings.journal.v1:'
/** How long a window waits for its first snapshot before rendering without it. */
export const UI_SETTINGS_HYDRATE_TIMEOUT_MS = 15_000
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const
const BUFFERED_CHANGES_MAX = 1_000
const READS_BEFORE_HYDRATION_MAX = 64

/** A transport failure no retry can fix (the window has no engine access at all). */
export class UiSettingsPermanentError extends Error {
  readonly name = 'UiSettingsPermanentError'
}

/** How a window reaches the store: its own backend socket, or main's relay. */
export interface UiSettingsTransport {
  get(params?: UiSettingsGetParams): Promise<UiSettingsSnapshot>
  set(params: UiSettingsSetParams): Promise<UiSettingsChange>
  /** Every landed batch, from any window (this one's included). */
  onChange(listener: (change: UiSettingsChange) => void): () => void
  /** The engine is reachable (again): pending writes and a failed hydrate try now. */
  onReconnect?(listener: () => void): () => void
  close?(): void
}

export type UiSettingsStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>

export type UiSettingsHydration =
  | { state: 'idle' }
  | { state: 'hydrating' }
  | {
      state: 'hydrated'
      revision: number
      /** Keys the migration copied in this hydrate (0 on a migrated profile). */
      migrated: number
      /** Keys the migration left in `localStorage` because they are past the store's limits (named in the console). */
      skipped: readonly string[]
      /** Journaled writes replayed in this hydrate. */
      replayed: number
    }
  | { state: 'unavailable'; reason: string }

export interface UiSettingsStatus {
  hydration: UiSettingsHydration
  /** Keys read before the snapshot arrived (each once), the diagnostic. */
  readsBeforeHydration: readonly string[]
  /** Keys written but not yet confirmed by the engine. */
  pendingWrites: readonly string[]
  /** The last send failure, until a send succeeds. */
  lastSendError: string | null
  writer: string
}

export interface UiSettingsStore {
  /** Loads the snapshot once; later calls return the same promise. Never rejects. */
  hydrate(options?: { timeoutMs?: number }): Promise<UiSettingsHydration>
  status(): UiSettingsStatus
  get(key: string): UiSettingsValue | undefined
  has(key: string): boolean
  keys(): string[]
  set(key: string, value: UiSettingsValue): void
  remove(key: string): void
  /** Sends what is pending now; resolves when the engine confirmed it. */
  flush(): Promise<void>
  /** Listeners hear the keys that changed (a late hydrate names every key). */
  subscribe(listener: (keys: ReadonlySet<string>) => void): () => void
  dispose(): void
}

export interface UiSettingsStoreDeps {
  transport: UiSettingsTransport
  /** The window's `localStorage` (the migration source and the journal), or null. */
  storage: UiSettingsStorage | null
  writer?: string
  log?: Pick<Console, 'warn' | 'error' | 'info'>
  now?: () => number
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

interface Journal {
  put: Record<string, UiSettingsValue>
  delete: string[]
}

function newWriterId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `window-${random}`
}

function utf8Length(text: string): number {
  return typeof TextEncoder === 'undefined'
    ? text.length
    : new TextEncoder().encode(text).byteLength
}

/** Why the store would refuse this key or value, or null: mirrors `ui_settings.rs`. */
export function migrationRefusal(key: string, value: string): string | null {
  if (key.length > UI_SETTINGS_KEY_MAX_CHARS) {
    return `the key is ${key.length} characters; the limit is ${UI_SETTINGS_KEY_MAX_CHARS}`
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(key)) return 'the key contains a control character'
  if (key.trim() !== key) return 'the key starts or ends with whitespace'
  const bytes = utf8Length(JSON.stringify(value))
  if (bytes > UI_SETTINGS_VALUE_MAX_BYTES) {
    return `the value is ${bytes} bytes; the limit is ${UI_SETTINGS_VALUE_MAX_BYTES}`
  }
  return null
}

function storageKeys(storage: UiSettingsStorage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null) keys.push(key)
  }
  return keys
}

function parseJournal(raw: string | null): Journal | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Journal>
    if (!parsed || typeof parsed !== 'object') return null
    const put =
      parsed.put && typeof parsed.put === 'object' && !Array.isArray(parsed.put)
        ? Object.fromEntries(
            Object.entries(parsed.put).filter(
              ([key, value]) => typeof key === 'string' && value !== null && value !== undefined
            )
          )
        : {}
    const deletes = Array.isArray(parsed.delete)
      ? parsed.delete.filter((key): key is string => typeof key === 'string')
      : []
    return { put: put as Record<string, UiSettingsValue>, delete: deletes }
  } catch {
    return null
  }
}

export function createUiSettingsStore(deps: UiSettingsStoreDeps): UiSettingsStore {
  const { transport, storage } = deps
  const writer = deps.writer ?? newWriterId()
  const log = deps.log ?? console
  const schedule = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms))
  const unschedule = deps.clearTimeout ?? ((handle) => clearTimeout(handle as number))
  const journalKey = `${UI_SETTINGS_JOURNAL_PREFIX}${writer}`

  const entries = new Map<string, UiSettingsValue>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  // A key with a pending local write keeps the local value until the engine
  // confirms it: a remote change or a migration copy for it is older.
  const pendingPut = new Map<string, UiSettingsValue>()
  const pendingDelete = new Set<string>()
  const readsBeforeHydration: string[] = []
  const bufferedChanges: UiSettingsChange[] = []
  let hydration: UiSettingsHydration = { state: 'idle' }
  let revision = 0
  let hydratePromise: Promise<UiSettingsHydration> | null = null
  let hydrated = false
  let disposed = false
  let lastSendError: string | null = null
  let flushScheduled = false
  let inflight: Promise<void> | null = null
  let retryHandle: unknown = null
  let retryStep = 0
  let unsubscribeChange: (() => void) | null = null
  let unsubscribeReconnect: (() => void) | null = null

  function notify(keys: ReadonlySet<string>): void {
    if (keys.size === 0) return
    for (const listener of listeners) {
      try {
        listener(keys)
      } catch (error) {
        log.error(`[ui-settings] a listener threw: ${describe(error)}`)
      }
    }
  }

  function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  function writeJournal(): void {
    if (!storage) return
    try {
      if (pendingPut.size === 0 && pendingDelete.size === 0) {
        storage.removeItem(journalKey)
        return
      }
      const journal: Journal = {
        put: Object.fromEntries(pendingPut),
        delete: [...pendingDelete]
      }
      storage.setItem(journalKey, JSON.stringify(journal))
    } catch (error) {
      log.warn(`[ui-settings] could not journal the pending writes: ${describe(error)}`)
    }
  }

  /** Applies a landed batch to the cache, skipping keys this window still has pending. */
  function applyChange(change: UiSettingsChange, skipPending: boolean): Set<string> {
    const changed = new Set<string>()
    for (const [key, value] of Object.entries(change.put)) {
      if (skipPending && (pendingPut.has(key) || pendingDelete.has(key))) continue
      entries.set(key, value)
      changed.add(key)
    }
    for (const key of change.delete) {
      if (skipPending && (pendingPut.has(key) || pendingDelete.has(key))) continue
      if (entries.delete(key)) changed.add(key)
    }
    if (change.revision > revision) revision = change.revision
    return changed
  }

  function onRemoteChange(change: UiSettingsChange): void {
    if (disposed) return
    if (change.writer !== undefined && change.writer === writer) return
    if (!hydrated) {
      if (bufferedChanges.length < BUFFERED_CHANGES_MAX) bufferedChanges.push(change)
      else log.warn('[ui-settings] dropped a change that arrived before the snapshot (buffer full)')
      return
    }
    if (change.revision <= revision) return
    notify(applyChange(change, true))
  }

  /**
   * The `localStorage` keys the store lacks, in batches the engine accepts
   * (its limits are checked here first, so a refusal can only mean the engine
   * is away). A key or value past the limits is named and left where it is.
   */
  function localStorageMigrationBatches(): {
    batches: Record<string, UiSettingsValue>[]
    skipped: string[]
  } {
    const batches: Record<string, UiSettingsValue>[] = []
    const skipped: string[] = []
    if (!storage) return { batches, skipped }
    let batch: Record<string, UiSettingsValue> = {}
    let batchKeys = 0
    let batchBytes = 0
    for (const key of storageKeys(storage)) {
      if (!key.startsWith(UI_SETTINGS_LOCAL_STORAGE_PREFIX)) continue
      if (key.startsWith(UI_SETTINGS_JOURNAL_PREFIX)) continue
      if (entries.has(key) || pendingPut.has(key) || pendingDelete.has(key)) continue
      const value = storage.getItem(key)
      if (value === null) continue
      const refusal = migrationRefusal(key, value)
      if (refusal) {
        skipped.push(key)
        log.error(`[ui-settings] "${key}" stays in localStorage, not migrated: ${refusal}`)
        continue
      }
      const bytes = utf8Length(JSON.stringify(value))
      if (
        batchKeys >= UI_SETTINGS_BATCH_MAX_KEYS ||
        batchBytes + bytes > UI_SETTINGS_BATCH_MAX_BYTES
      ) {
        batches.push(batch)
        batch = {}
        batchKeys = 0
        batchBytes = 0
      }
      batch[key] = value
      batchKeys += 1
      batchBytes += bytes
    }
    batches.push(batch)
    return { batches, skipped }
  }

  async function migrateLocalStorage(): Promise<{ migrated: number; skipped: string[] }> {
    let plan: ReturnType<typeof localStorageMigrationBatches>
    try {
      plan = localStorageMigrationBatches()
    } catch (error) {
      log.error(
        `[ui-settings] localStorage could not be read; the migration will try again next launch: ${describe(error)}`
      )
      return { migrated: 0, skipped: [] }
    }
    let migrated = 0
    for (const [index, put] of plan.batches.entries()) {
      const change = await transport.set({
        put,
        ifAbsent: true,
        localStorageMigrated: index === plan.batches.length - 1,
        writer
      })
      migrated += Object.keys(change.put).length
      applyChange(change, true)
    }
    return { migrated, skipped: plan.skipped }
  }

  /** Every window's journal in this storage (this window's included): replayed, then removed. */
  async function replayJournals(): Promise<number> {
    if (!storage) return 0
    let keys: string[]
    try {
      keys = storageKeys(storage).filter((key) => key.startsWith(UI_SETTINGS_JOURNAL_PREFIX))
    } catch (error) {
      log.warn(`[ui-settings] could not read the journals: ${describe(error)}`)
      return 0
    }
    let replayed = 0
    for (const key of keys) {
      if (key === journalKey) continue
      const journal = parseJournal(storage.getItem(key))
      if (!journal) {
        storage.removeItem(key)
        continue
      }
      const put = Object.fromEntries(
        Object.entries(journal.put).filter(
          ([entry]) => !pendingPut.has(entry) && !pendingDelete.has(entry)
        )
      )
      const deletes = journal.delete.filter(
        (entry) => !pendingPut.has(entry) && !pendingDelete.has(entry) && !(entry in put)
      )
      if (Object.keys(put).length > 0 || deletes.length > 0) {
        const change = await transport.set({ put, delete: deletes, writer })
        applyChange(change, true)
        replayed += Object.keys(put).length + deletes.length
      }
      storage.removeItem(key)
    }
    return replayed
  }

  async function hydrateOnce(): Promise<UiSettingsHydration> {
    const snapshot = await transport.get()
    if (disposed) return { state: 'unavailable', reason: 'The window closed.' }
    for (const [key, value] of Object.entries(snapshot.entries)) {
      if (pendingPut.has(key) || pendingDelete.has(key)) continue
      entries.set(key, value)
    }
    revision = snapshot.revision
    let migration = { migrated: 0, skipped: [] as string[] }
    if (!snapshot.localStorageMigrated) migration = await migrateLocalStorage()
    const replayed = await replayJournals()
    hydrated = true
    for (const change of bufferedChanges.splice(0)) {
      if (change.revision > revision) applyChange(change, true)
    }
    const result: UiSettingsHydration = {
      state: 'hydrated',
      revision,
      migrated: migration.migrated,
      skipped: migration.skipped,
      replayed
    }
    hydration = result
    if (readsBeforeHydration.length > 0) {
      log.warn(
        `[ui-settings] ${readsBeforeHydration.length} key(s) were read before the snapshot: ${readsBeforeHydration.join(', ')}`
      )
    }
    notify(new Set(entries.keys()))
    if (pendingPut.size > 0 || pendingDelete.size > 0) scheduleFlush()
    return result
  }

  let hydrateAttempt: Promise<UiSettingsHydration> | null = null

  function attemptHydration(): Promise<UiSettingsHydration> {
    if (hydrateAttempt) return hydrateAttempt
    hydration = { state: 'hydrating' }
    hydrateAttempt = hydrateOnce()
      .catch((error: unknown): UiSettingsHydration => {
        if (disposed) return { state: 'unavailable', reason: 'The window closed.' }
        const reason = describe(error)
        hydration = { state: 'unavailable', reason }
        log.error(`[ui-settings] the snapshot did not arrive: ${reason}`)
        // A window with no engine access at all never gets one by waiting.
        if (!(error instanceof UiSettingsPermanentError)) {
          scheduleRetry(() => void attemptHydration())
        }
        return hydration
      })
      .finally(() => {
        hydrateAttempt = null
      })
    return hydrateAttempt
  }

  function scheduleRetry(action: () => void): void {
    if (disposed || retryHandle !== null) return
    const wait = RETRY_BACKOFF_MS[Math.min(retryStep, RETRY_BACKOFF_MS.length - 1)]
    retryStep += 1
    retryHandle = schedule(() => {
      retryHandle = null
      action()
    }, wait)
  }

  function retryNow(): void {
    if (disposed) return
    if (retryHandle !== null) {
      unschedule(retryHandle)
      retryHandle = null
    }
    retryStep = 0
    if (!hydrated) {
      if (hydratePromise) void attemptHydration()
    } else if (pendingPut.size > 0 || pendingDelete.size > 0) {
      scheduleFlush()
    }
  }

  function scheduleFlush(): void {
    if (flushScheduled || disposed) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      // A failed send is logged, journaled and retried by flush() itself.
      void flush().catch(() => {})
    })
  }

  async function flush(): Promise<void> {
    if (inflight) {
      await inflight
      if (pendingPut.size > 0 || pendingDelete.size > 0) await flush()
      return
    }
    if (!hydrated) {
      // The journal already holds it; the hydrate flushes once the snapshot is in.
      if (hydratePromise) await hydratePromise
      if (!hydrated) {
        throw new Error(
          lastSendError ??
            (hydration.state === 'unavailable'
              ? hydration.reason
              : 'The UI settings store is not hydrated yet.')
        )
      }
    }
    if (pendingPut.size === 0 && pendingDelete.size === 0) return
    const put = Object.fromEntries(pendingPut)
    const deletes = [...pendingDelete]
    const sent = { put: new Map(pendingPut), delete: new Set(pendingDelete) }
    inflight = (async () => {
      try {
        const change = await transport.set({ put, delete: deletes, writer })
        // Writes that arrived while this batch was in flight stay pending.
        for (const [key, value] of sent.put) {
          if (pendingPut.get(key) === value) pendingPut.delete(key)
        }
        for (const key of sent.delete) {
          if (pendingDelete.has(key) && !pendingPut.has(key)) pendingDelete.delete(key)
        }
        if (change.revision > revision) revision = change.revision
        lastSendError = null
        retryStep = 0
        writeJournal()
      } catch (error) {
        lastSendError = describe(error)
        log.error(
          `[ui-settings] ${Object.keys(put).length + deletes.length} write(s) did not land (kept pending and journaled): ${lastSendError}`
        )
        scheduleRetry(() => void flush().catch(() => {}))
        throw error
      } finally {
        inflight = null
      }
    })()
    await inflight
    if (pendingPut.size > 0 || pendingDelete.size > 0) scheduleFlush()
  }

  function warnRead(key: string): void {
    if (readsBeforeHydration.includes(key)) return
    if (readsBeforeHydration.length < READS_BEFORE_HYDRATION_MAX) readsBeforeHydration.push(key)
    log.warn(
      `[ui-settings] "${key}" was read before the snapshot arrived (${hydration.state}); nothing is known about it yet.`
    )
  }

  unsubscribeChange = transport.onChange(onRemoteChange)
  unsubscribeReconnect = transport.onReconnect?.(retryNow) ?? null

  return {
    hydrate(options = {}) {
      if (hydratePromise) return hydratePromise
      const timeoutMs = options.timeoutMs ?? UI_SETTINGS_HYDRATE_TIMEOUT_MS
      const attempt = attemptHydration()
      hydratePromise = new Promise<UiSettingsHydration>((resolve) => {
        let settled = false
        const handle = schedule(() => {
          if (settled) return
          settled = true
          if (!hydrated) {
            hydration = {
              state: 'unavailable',
              reason: `The engine did not answer within ${timeoutMs} ms; still waiting.`
            }
            log.error(`[ui-settings] ${hydration.reason}`)
          }
          resolve(hydration)
        }, timeoutMs)
        void attempt.then((result) => {
          if (settled) return
          settled = true
          unschedule(handle)
          resolve(result)
        })
      })
      return hydratePromise
    },
    status() {
      return {
        hydration,
        readsBeforeHydration: [...readsBeforeHydration],
        pendingWrites: [...new Set([...pendingPut.keys(), ...pendingDelete])],
        lastSendError,
        writer
      }
    },
    get(key) {
      if (!hydrated) warnRead(key)
      return entries.get(key)
    },
    has(key) {
      if (!hydrated) warnRead(key)
      return entries.has(key)
    },
    keys() {
      return [...entries.keys()]
    },
    set(key, value) {
      if (disposed) throw new Error('The UI settings store is disposed.')
      if (value === null || value === undefined) {
        throw new Error(`UI setting "${key}" cannot be set to ${String(value)}; remove it instead.`)
      }
      entries.set(key, value)
      pendingDelete.delete(key)
      pendingPut.set(key, value)
      writeJournal()
      notify(new Set([key]))
      scheduleFlush()
    },
    remove(key) {
      if (disposed) throw new Error('The UI settings store is disposed.')
      const held = entries.delete(key)
      pendingPut.delete(key)
      pendingDelete.add(key)
      writeJournal()
      if (held) notify(new Set([key]))
      scheduleFlush()
    },
    flush,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      unsubscribeChange?.()
      unsubscribeReconnect?.()
      if (retryHandle !== null) {
        unschedule(retryHandle)
        retryHandle = null
      }
      listeners.clear()
      transport.close?.()
    }
  }
}
