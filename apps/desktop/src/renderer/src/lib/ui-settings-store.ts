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
// in a per-window journal in `localStorage`, with each key's write time, so a
// window closed before the engine returns loses nothing: the next hydrate
// (any window, next launch) replays the journals of windows no longer open.
// A window holds a Web Lock named for it while it lives, so a journal whose
// lock is held belongs to an open window and is left to it; where the origin
// has no Web Locks, every journal replays. Either way a replay sends each
// key's write time (`unlessUpdatedAfter`), so it never overwrites what the
// store took after it, and a journal is removed only if it did not change
// while it replayed. The hydrate itself is bounded: past the deadline the
// window renders with the store `unavailable` and the hydrate keeps trying.
//
// The one-time `localStorage` migration runs inside the first hydrate of a
// profile the previous release wrote: every `videorc.*` key the store lacks
// (and no journal names) is copied verbatim (a JSON string per key) in
// `ifAbsent` batches marked `localStorageMigrated`, so two windows racing the
// same launch never overwrite each other. A value past the store's limits is
// never dropped: the migration stays open (unmarked, tried again next launch)
// and the window holds that value from `localStorage`, read-only, so nothing
// reads it as missing. A `localStorage` that can't be read fails the hydrate.
// After the migration or a replay wrote, the window reads a fresh snapshot:
// a batch's answer is a delta, never the whole store. The `localStorage`
// values stay where they are, so a rollback to the previous release still
// finds them.

import type {
  UiSettingsChange,
  UiSettingsGetParams,
  UiSettingsSetParams,
  UiSettingsSnapshot,
  UiSettingsValue
} from '../../../shared/backend'
import { UI_SETTINGS_BATCH_MAX_BYTES, UI_SETTINGS_BATCH_MAX_KEYS } from '../../../shared/backend'
import {
  UI_SETTINGS_HYDRATE_TIMEOUT_MS,
  UI_SETTINGS_JOURNAL_PREFIX,
  UI_SETTINGS_LOCAL_STORAGE_PREFIX,
  migrationRefusal,
  utf8Length
} from './ui-settings-limits'

export {
  UI_SETTINGS_HYDRATE_TIMEOUT_MS,
  UI_SETTINGS_JOURNAL_PREFIX,
  UI_SETTINGS_LOCAL_STORAGE_PREFIX,
  migrationRefusal
} from './ui-settings-limits'
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
      /**
       * Keys past the store's limits (named in the console): left in
       * `localStorage`, held read-only in this window, and the migration
       * stays open so the next launch tries again.
       */
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
  /** Resolves once the snapshot is in (at once when it already is), however late. */
  whenHydrated(): Promise<void>
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

/** The Web Locks a window holds for its life, so others know it is open. */
export interface UiSettingsLocks {
  /** Holds `name` until `release` settles. */
  hold(name: string, release: Promise<void>): void
  /** Runs `task` holding `name` when nobody holds it; null when someone does. */
  ifFree<T>(name: string, task: () => Promise<T>): Promise<T | null>
}

export interface UiSettingsStoreDeps {
  transport: UiSettingsTransport
  /** The window's `localStorage` (the migration source and the journal), or null. */
  storage: UiSettingsStorage | null
  writer?: string
  log?: Pick<Console, 'warn' | 'error' | 'info'>
  /** Unix ms: each journaled write's time. */
  now?: () => number
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** Defaults to the window's `navigator.locks`; null where there are none. */
  locks?: UiSettingsLocks | null
}

interface Journal {
  put: Record<string, UiSettingsValue>
  delete: string[]
  /** Each key's write time (Unix ms); a key without one replays only onto a key the store lacks. */
  at: Record<string, number>
}

function writerLockName(writer: string): string {
  return `${UI_SETTINGS_JOURNAL_PREFIX}${writer}`
}

function browserLocks(): UiSettingsLocks | null {
  let manager: LockManager | undefined
  try {
    manager = typeof navigator === 'undefined' ? undefined : navigator.locks
  } catch {
    return null
  }
  if (!manager) return null
  const locks = manager
  return {
    hold(name, release) {
      void locks.request(name, () => release).catch(() => {})
    },
    async ifFree<T>(name: string, task: () => Promise<T>): Promise<T | null> {
      let result: T | null = null
      await locks.request(name, { ifAvailable: true }, async (lock) => {
        if (lock) result = await task()
      })
      return result
    }
  }
}

function newWriterId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `window-${random}`
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
    const at =
      parsed.at && typeof parsed.at === 'object' && !Array.isArray(parsed.at)
        ? Object.fromEntries(
            Object.entries(parsed.at).filter(
              ([, time]) => typeof time === 'number' && Number.isSafeInteger(time) && time >= 0
            )
          )
        : {}
    return { put: put as Record<string, UiSettingsValue>, delete: deletes, at }
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
  const now = deps.now ?? Date.now
  const locks = deps.locks === undefined ? browserLocks() : deps.locks
  const journalKey = `${UI_SETTINGS_JOURNAL_PREFIX}${writer}`

  const entries = new Map<string, UiSettingsValue>()
  const listeners = new Set<(keys: ReadonlySet<string>) => void>()
  // A key with a pending local write keeps the local value until the engine
  // confirms it: a remote change or a migration copy for it is older.
  const pendingPut = new Map<string, UiSettingsValue>()
  const pendingDelete = new Set<string>()
  const pendingAt = new Map<string, number>()
  let releaseWriterLock: (() => void) | null = null
  if (locks) {
    try {
      locks.hold(
        writerLockName(writer),
        new Promise<void>((resolve) => {
          releaseWriterLock = resolve
        })
      )
    } catch (error) {
      log.warn(`[ui-settings] this window could not mark itself open: ${describe(error)}`)
    }
  }
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
  const hydratedWaiters: (() => void)[] = []

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
        delete: [...pendingDelete],
        at: Object.fromEntries(pendingAt)
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
  function localStorageMigrationBatches(journaled: ReadonlySet<string>): {
    batches: Record<string, UiSettingsValue>[]
    skipped: string[]
    held: Map<string, string>
  } {
    const batches: Record<string, UiSettingsValue>[] = []
    const skipped: string[] = []
    const held = new Map<string, string>()
    if (!storage) return { batches, skipped, held }
    let batch: Record<string, UiSettingsValue> = {}
    let batchKeys = 0
    let batchBytes = 0
    for (const key of storageKeys(storage)) {
      if (!key.startsWith(UI_SETTINGS_LOCAL_STORAGE_PREFIX)) continue
      if (key.startsWith(UI_SETTINGS_JOURNAL_PREFIX)) continue
      if (entries.has(key) || pendingPut.has(key) || pendingDelete.has(key)) continue
      // A journal's write or delete of it is newer than the old copy.
      if (journaled.has(key)) continue
      const value = storage.getItem(key)
      if (value === null) continue
      const refusal = migrationRefusal(key, value)
      if (refusal) {
        skipped.push(key)
        held.set(key, value)
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
    return { batches, skipped, held }
  }

  async function migrateLocalStorage(journaled: ReadonlySet<string>): Promise<{
    migrated: number
    skipped: string[]
    held: Map<string, string>
    wrote: boolean
  }> {
    let plan: ReturnType<typeof localStorageMigrationBatches>
    try {
      plan = localStorageMigrationBatches(journaled)
    } catch (error) {
      throw new Error(
        `localStorage could not be read, so the previous version's settings can't move yet: ${describe(error)}`,
        { cause: error }
      )
    }
    // Only a migration that copied every key is marked done.
    const complete = plan.skipped.length === 0
    let migrated = 0
    let wrote = false
    for (const [index, put] of plan.batches.entries()) {
      const mark = complete && index === plan.batches.length - 1
      if (!mark && Object.keys(put).length === 0) continue
      const change = await transport.set({
        put,
        ifAbsent: true,
        localStorageMigrated: mark,
        writer
      })
      wrote = true
      migrated += Object.keys(change.put).length
    }
    if (!complete) {
      log.error(
        `[ui-settings] the localStorage migration stays open: ${plan.skipped.length} key(s) are held read-only from localStorage, and the next launch tries again`
      )
    }
    return { migrated, skipped: plan.skipped, held: plan.held, wrote }
  }

  /** The other windows' journals in this storage, and every key they name. */
  function otherJournals(): { keys: string[]; named: Set<string> } {
    const named = new Set<string>()
    if (!storage) return { keys: [], named }
    const keys = storageKeys(storage).filter(
      (key) => key.startsWith(UI_SETTINGS_JOURNAL_PREFIX) && key !== journalKey
    )
    for (const key of keys) {
      const journal = parseJournal(storage.getItem(key))
      for (const entry of [...Object.keys(journal?.put ?? {}), ...(journal?.delete ?? [])]) {
        named.add(entry)
      }
    }
    return { keys, named }
  }

  /**
   * Replays one journal by its write times, then removes it unless it
   * changed meanwhile. Returns how many of its writes landed.
   */
  async function replayJournal(key: string): Promise<{ replayed: number; wrote: boolean }> {
    if (!storage) return { replayed: 0, wrote: false }
    const raw = storage.getItem(key)
    const journal = parseJournal(raw)
    if (!journal) {
      if (raw !== null && storage.getItem(key) === raw) storage.removeItem(key)
      return { replayed: 0, wrote: false }
    }
    const put = Object.fromEntries(
      Object.entries(journal.put).filter(
        ([entry]) => !pendingPut.has(entry) && !pendingDelete.has(entry)
      )
    )
    const deletes = journal.delete.filter(
      (entry) => !pendingPut.has(entry) && !pendingDelete.has(entry) && !(entry in put)
    )
    let replayed = 0
    let wrote = false
    if (Object.keys(put).length > 0 || deletes.length > 0) {
      const unlessUpdatedAfter = Object.fromEntries(
        [...Object.keys(put), ...deletes].map((entry) => [entry, journal.at[entry] ?? 0])
      )
      const change = await transport.set({ put, delete: deletes, unlessUpdatedAfter, writer })
      wrote = true
      replayed = Object.keys(change.put).length + change.delete.length
    }
    // Its window may have written it again meanwhile: that journal is newer.
    if (storage.getItem(key) === raw) storage.removeItem(key)
    return { replayed, wrote }
  }

  /** A journal whose window is still open is left to it; another one replays. */
  async function replayJournalUnlessOpen(
    key: string
  ): Promise<{ replayed: number; wrote: boolean }> {
    if (locks) {
      const progress = { ran: false }
      try {
        const result = await locks.ifFree(
          writerLockName(key.slice(UI_SETTINGS_JOURNAL_PREFIX.length)),
          () => {
            progress.ran = true
            return replayJournal(key)
          }
        )
        return result ?? { replayed: 0, wrote: false }
      } catch (error) {
        if (progress.ran) throw error
        log.warn(
          `[ui-settings] could not tell whether the window behind ${key} is still open (${describe(error)}); its journal replays by its write times`
        )
      }
    }
    return replayJournal(key)
  }

  /** Puts `snapshot` in the cache whole: keys it lacks go, unless this window has them pending. */
  function loadSnapshot(snapshot: UiSettingsSnapshot): void {
    for (const key of [...entries.keys()]) {
      if (key in snapshot.entries || pendingPut.has(key) || pendingDelete.has(key)) continue
      entries.delete(key)
    }
    for (const [key, value] of Object.entries(snapshot.entries)) {
      if (pendingPut.has(key) || pendingDelete.has(key)) continue
      entries.set(key, value)
    }
    revision = snapshot.revision
  }

  async function hydrateOnce(): Promise<UiSettingsHydration> {
    const snapshot = await transport.get()
    if (disposed) return { state: 'unavailable', reason: 'The window closed.' }
    loadSnapshot(snapshot)
    let journals: ReturnType<typeof otherJournals>
    try {
      journals = otherJournals()
    } catch (error) {
      log.warn(`[ui-settings] could not read the journals: ${describe(error)}`)
      journals = { keys: [], named: new Set() }
    }
    let migration = {
      migrated: 0,
      skipped: [] as string[],
      held: new Map<string, string>(),
      wrote: false
    }
    if (!snapshot.localStorageMigrated) migration = await migrateLocalStorage(journals.named)
    let replayed = 0
    let wrote = migration.wrote
    for (const key of journals.keys) {
      const replay = await replayJournalUnlessOpen(key)
      replayed += replay.replayed
      wrote ||= replay.wrote
    }
    // A batch's answer is a delta: changes from other windows it skipped
    // past are in a fresh snapshot, not in it.
    if (wrote) {
      loadSnapshot(await transport.get())
      if (disposed) return { state: 'unavailable', reason: 'The window closed.' }
    }
    for (const [key, value] of migration.held) {
      if (entries.has(key) || pendingPut.has(key) || pendingDelete.has(key)) continue
      entries.set(key, value)
    }
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
    for (const resolve of hydratedWaiters.splice(0)) resolve()
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
        for (const key of [...sent.put.keys(), ...sent.delete]) {
          if (!pendingPut.has(key) && !pendingDelete.has(key)) pendingAt.delete(key)
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
    whenHydrated() {
      if (hydrated) return Promise.resolve()
      return new Promise<void>((resolve) => hydratedWaiters.push(resolve))
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
      pendingAt.set(key, now())
      writeJournal()
      notify(new Set([key]))
      scheduleFlush()
    },
    remove(key) {
      if (disposed) throw new Error('The UI settings store is disposed.')
      const held = entries.delete(key)
      pendingPut.delete(key)
      pendingDelete.add(key)
      pendingAt.set(key, now())
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
      releaseWriterLock?.()
      transport.close?.()
    }
  }
}
