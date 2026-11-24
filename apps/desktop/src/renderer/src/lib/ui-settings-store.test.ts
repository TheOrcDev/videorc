import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import type {
  UiSettingsChange,
  UiSettingsGetParams,
  UiSettingsSetParams,
  UiSettingsSnapshot,
  UiSettingsValue
} from '../../../shared/backend'
import { UI_SETTINGS_KEY_MAX_CHARS, UI_SETTINGS_VALUE_MAX_BYTES } from '../../../shared/backend'
import {
  createUiSettingsStore,
  migrationRefusal,
  UI_SETTINGS_JOURNAL_PREFIX,
  type UiSettingsLocks,
  type UiSettingsStorage,
  type UiSettingsTransport
} from './ui-settings-store'
import { createRelayUiSettingsTransport, windowUiSettingsTransport } from './ui-settings-window'

/** The previous release's localStorage, every key (shared with the Rust side). */
const previousReleaseProfile = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../protocol-fixtures/ui-settings-previous-release-profile.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as { localStorage: Record<string, string> }
).localStorage

/** A `localStorage` stand-in (the tests run without a DOM). */
function fakeStorage(seed: Record<string, string> = {}): UiSettingsStorage & {
  dump(): Record<string, string>
} {
  const values = new Map(Object.entries(seed))
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    dump: () => Object.fromEntries(values)
  }
}

/**
 * The backend's store in memory, with the same semantics as `ui_settings.rs`:
 * one revision, `ifAbsent`, the migration mark, and the change event to every
 * connected window (the writer's included). Each window gets its own transport.
 */
function fakeEngine(initial: Record<string, UiSettingsValue> = {}) {
  const entries = new Map(Object.entries(initial))
  // Each key's last change (Unix ms): a write, or its delete (the tombstone).
  // A replayed change is stamped with its journal's write time.
  let clock = 0
  const updatedAt = new Map([...entries.keys()].map((key) => [key, clock]))
  let revision = 0
  let localStorageMigrated = false
  const listeners = new Set<(change: UiSettingsChange) => void>()
  const sets: UiSettingsSetParams[] = []
  let online = true
  let holdGet: (() => void) | null = null
  let holdGetResult: Promise<void> | null = null
  const changedSince = (key: string, params: UiSettingsSetParams): boolean => {
    const written = params.unlessUpdatedAfter?.[key]
    if (written === undefined) return false
    const updated = updatedAt.get(key)
    return updated !== undefined && updated > written
  }

  function snapshot(params?: UiSettingsGetParams): UiSettingsSnapshot {
    const wanted = params?.keys?.length ? new Set(params.keys) : null
    return {
      entries: Object.fromEntries(
        [...entries].filter(([key]) => wanted === null || wanted.has(key))
      ),
      revision,
      localStorageMigrated
    }
  }

  function apply(params: UiSettingsSetParams): UiSettingsChange {
    sets.push(params)
    const put: Record<string, UiSettingsValue> = {}
    const deletes: string[] = []
    for (const [key, value] of Object.entries(params.put ?? {})) {
      if (params.ifAbsent && (entries.has(key) || updatedAt.has(key))) continue
      if (changedSince(key, params)) continue
      entries.set(key, value)
      updatedAt.set(key, params.unlessUpdatedAfter?.[key] ?? clock)
      put[key] = value
    }
    for (const key of params.delete ?? []) {
      if (changedSince(key, params)) continue
      // Held or not, the key's tombstone moves to this delete.
      updatedAt.set(key, params.unlessUpdatedAfter?.[key] ?? clock)
      if (entries.delete(key)) deletes.push(key)
    }
    const landed = Object.keys(put).length > 0 || deletes.length > 0
    if (landed || params.localStorageMigrated) revision += 1
    if (params.localStorageMigrated) localStorageMigrated = true
    const change: UiSettingsChange = { revision, put, delete: deletes }
    if (params.writer !== undefined) change.writer = params.writer
    if (landed || params.localStorageMigrated) {
      for (const listener of [...listeners]) listener(structuredClone(change))
    }
    return change
  }

  function transport(): UiSettingsTransport & { reconnect(): void } {
    const reconnects = new Set<() => void>()
    return {
      async get(params) {
        if (!online) throw new Error("Videorc's engine isn't connected.")
        if (holdGet) await new Promise<void>((resolve) => (holdGet = resolve))
        const taken = structuredClone(snapshot(params))
        if (holdGetResult) {
          const held = holdGetResult
          holdGetResult = null
          await held
        }
        return taken
      },
      async set(params) {
        if (!online) throw new Error("Videorc's engine isn't connected.")
        return structuredClone(apply(params))
      },
      onChange(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onReconnect(listener) {
        reconnects.add(listener)
        return () => reconnects.delete(listener)
      },
      reconnect() {
        for (const listener of reconnects) listener()
      }
    }
  }

  return {
    transport,
    sets,
    entries,
    get revision() {
      return revision
    },
    get localStorageMigrated() {
      return localStorageMigrated
    },
    setOnline(next: boolean) {
      online = next
    },
    /** Moves the engine's clock (and the windows' if they share it). */
    setClock(next: number) {
      clock = next
    },
    /** The next snapshot is taken at once but answered only on release. */
    holdNextGetResult() {
      let release = () => {}
      holdGetResult = new Promise<void>((resolve) => (release = resolve))
      return () => release()
    },
    holdNextGet() {
      holdGet = () => {}
      return () => {
        const release = holdGet
        holdGet = null
        release?.()
      }
    }
  }
}

const quiet = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('UI settings store (plan 220 S1.4a)', () => {
  it('migrates a previous-release profile intact, once, and leaves localStorage in place', async () => {
    expect(Object.keys(previousReleaseProfile).length).toBeGreaterThanOrEqual(33)
    const engine = fakeEngine()
    const storage = fakeStorage(previousReleaseProfile)
    const main = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-main',
      log: quiet
    })

    const result = await main.hydrate({ timeoutMs: 1_000 })
    expect(result).toEqual({
      state: 'hydrated',
      revision: 1,
      migrated: Object.keys(previousReleaseProfile).length,
      skipped: [],
      replayed: 0
    })
    // Every key arrived as the string localStorage held, byte for byte.
    for (const [key, value] of Object.entries(previousReleaseProfile)) {
      expect(engine.entries.get(key)).toBe(value)
      expect(main.get(key)).toBe(value)
    }
    expect(engine.localStorageMigrated).toBe(true)
    expect(engine.sets[0]).toMatchObject({
      ifAbsent: true,
      localStorageMigrated: true,
      writer: 'window-main'
    })
    // A rollback still finds the old values.
    expect(storage.dump()).toEqual(previousReleaseProfile)

    // A second window on the same profile copies nothing more.
    const streamManager = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-stream-manager',
      log: quiet
    })
    expect(await streamManager.hydrate({ timeoutMs: 1_000 })).toMatchObject({
      state: 'hydrated',
      migrated: 0
    })
    expect(engine.sets).toHaveLength(1)
    expect(streamManager.get('videorc.theme')).toBe('dark')
  })

  it('never overwrites a value this release wrote before the migration ran', async () => {
    const engine = fakeEngine({ 'videorc.theme': 'light' })
    const storage = fakeStorage({ 'videorc.theme': 'dark', 'videorc.aiConsent': '1' })
    const store = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'w',
      log: quiet
    })
    expect(await store.hydrate()).toMatchObject({ state: 'hydrated', migrated: 1 })
    expect(store.get('videorc.theme')).toBe('light')
    expect(store.get('videorc.aiConsent')).toBe('1')
  })

  it('copies a profile larger than one batch in several, marking migrated on the last', async () => {
    const seed: Record<string, string> = {}
    for (let index = 0; index < 300; index += 1) seed[`videorc.sources.more.src-${index}`] = '1'
    const engine = fakeEngine()
    const store = createUiSettingsStore({
      transport: engine.transport(),
      storage: fakeStorage(seed),
      writer: 'w',
      log: quiet
    })
    expect(await store.hydrate()).toMatchObject({ state: 'hydrated', migrated: 300 })
    expect(engine.sets.map((batch) => batch.localStorageMigrated)).toEqual([false, true])
    expect(engine.sets.map((batch) => Object.keys(batch.put ?? {}).length)).toEqual([256, 44])
  })

  it('migrates a value past the old 1 MiB limit, such as a large scene library', async () => {
    const engine = fakeEngine()
    const library = JSON.stringify({ scenes: ['x'.repeat(2 * 1024 * 1024)] })
    const store = createUiSettingsStore({
      transport: engine.transport(),
      storage: fakeStorage({ 'videorc.scenes.v2': library }),
      writer: 'w',
      log: quiet
    })
    expect(await store.hydrate()).toMatchObject({ state: 'hydrated', migrated: 1, skipped: [] })
    expect(engine.entries.get('videorc.scenes.v2')).toBe(library)
    expect(engine.localStorageMigrated).toBe(true)
  })

  it('holds a value past the limits read-only from localStorage and leaves the migration open', async () => {
    const engine = fakeEngine()
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
    const huge = 'x'.repeat(UI_SETTINGS_VALUE_MAX_BYTES)
    const storage = fakeStorage({
      'videorc.theme': 'dark',
      'videorc.huge': huge,
      [`videorc.${'k'.repeat(UI_SETTINGS_KEY_MAX_CHARS)}`]: '1',
      'videorc.bad\nkey': '1'
    })
    const store = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'w',
      log
    })
    expect(await store.hydrate()).toMatchObject({
      state: 'hydrated',
      migrated: 1,
      skipped: [
        'videorc.huge',
        `videorc.${'k'.repeat(UI_SETTINGS_KEY_MAX_CHARS)}`,
        'videorc.bad\nkey'
      ]
    })
    expect(engine.entries.get('videorc.theme')).toBe('dark')
    expect(engine.entries.has('videorc.huge')).toBe(false)
    // Never marked done, so nothing reads the held keys as missing for good.
    expect(engine.localStorageMigrated).toBe(false)
    expect(engine.sets.every((batch) => !batch.localStorageMigrated)).toBe(true)
    expect(store.get('videorc.huge')).toBe(huge)
    expect(log.error).toHaveBeenCalledTimes(4)
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('"videorc.huge" stays in localStorage')
    )
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('migration stays open'))
    expect(migrationRefusal('videorc.theme', 'dark')).toBeNull()

    // The next launch tries again, copies nothing twice and still holds it.
    const next = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'w2',
      log: quiet
    })
    expect(await next.hydrate()).toMatchObject({ state: 'hydrated', migrated: 0 })
    expect(next.get('videorc.huge')).toBe(huge)
    expect(engine.localStorageMigrated).toBe(false)
  })

  it('fails the hydrate loudly when localStorage cannot be read, and marks nothing', async () => {
    const engine = fakeEngine()
    const storage: UiSettingsStorage = {
      ...fakeStorage(),
      get length(): number {
        throw new Error('The storage is corrupt.')
      }
    }
    const store = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'w',
      log: quiet,
      locks: null,
      setTimeout: () => 0,
      clearTimeout: () => {}
    })
    expect(await store.hydrate({ timeoutMs: 1_000 })).toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('localStorage could not be read')
    })
    expect(engine.localStorageMigrated).toBe(false)
    expect(engine.sets).toEqual([])
  })

  it('reads say nothing is known before the snapshot, and writes are cached, journaled and flushed after it', async () => {
    const engine = fakeEngine({ 'videorc.theme': 'dark' })
    const storage = fakeStorage()
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
    const release = engine.holdNextGet()
    const store = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-main',
      log
    })
    const hydrating = store.hydrate({ timeoutMs: 1_000 })
    expect(store.status().hydration).toEqual({ state: 'hydrating' })

    expect(store.get('videorc.theme')).toBeUndefined()
    expect(store.get('videorc.theme')).toBeUndefined()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(store.status().readsBeforeHydration).toEqual(['videorc.theme'])

    store.set('videorc.settingsTab', 'recording')
    expect(store.get('videorc.settingsTab')).toBe('recording')
    expect(store.status().pendingWrites).toEqual(['videorc.settingsTab'])
    expect(JSON.parse(storage.getItem(`${UI_SETTINGS_JOURNAL_PREFIX}window-main`)!)).toEqual({
      put: { 'videorc.settingsTab': 'recording' },
      delete: [],
      at: { 'videorc.settingsTab': expect.any(Number) }
    })
    await flushMicrotasks()
    expect(engine.sets).toHaveLength(0)

    release()
    expect(await hydrating).toMatchObject({ state: 'hydrated' })
    expect(store.get('videorc.theme')).toBe('dark')
    await store.flush()
    expect(engine.entries.get('videorc.settingsTab')).toBe('recording')
    expect(store.status().pendingWrites).toEqual([])
    expect(storage.getItem(`${UI_SETTINGS_JOURNAL_PREFIX}window-main`)).toBeNull()
  })

  it('keeps every window in step: a write lands once, the others hear it, the writer skips its echo', async () => {
    const engine = fakeEngine()
    const storage = fakeStorage()
    const main = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-main',
      log: quiet
    })
    const notes = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-notes',
      log: quiet
    })
    await Promise.all([main.hydrate(), notes.hydrate()])
    // Each hydrate sent its (empty) migration batch; count the writes from here.
    const migrationBatches = engine.sets.length
    const revisionAfterHydrate = engine.revision
    const heardByMain: string[][] = []
    const heardByNotes: string[][] = []
    main.subscribe((keys) => heardByMain.push([...keys].sort()))
    notes.subscribe((keys) => heardByNotes.push([...keys].sort()))

    main.set('videorc.theme', 'light')
    main.set('videorc.notesTab', 'chat')
    main.set('videorc.theme', 'dark')
    await main.flush()
    // One batch, the last write per key.
    expect(engine.sets).toHaveLength(migrationBatches + 1)
    expect(engine.sets[migrationBatches]).toMatchObject({
      put: { 'videorc.theme': 'dark', 'videorc.notesTab': 'chat' },
      writer: 'window-main'
    })
    expect(notes.get('videorc.theme')).toBe('dark')
    expect(notes.get('videorc.notesTab')).toBe('chat')
    expect(heardByNotes).toEqual([['videorc.notesTab', 'videorc.theme']])
    // The writer heard its own set() calls, never the echo.
    expect(heardByMain).toEqual([['videorc.theme'], ['videorc.notesTab'], ['videorc.theme']])

    notes.remove('videorc.notesTab')
    await notes.flush()
    expect(main.has('videorc.notesTab')).toBe(false)
    expect(main.status().hydration).toMatchObject({ state: 'hydrated' })
    expect(engine.revision).toBe(revisionAfterHydrate + 2)
  })

  it('applies a change that raced the snapshot only when it is newer, and ignores a stale one', async () => {
    const engine = fakeEngine({ 'videorc.theme': 'dark' })
    const other = createUiSettingsStore({
      transport: engine.transport(),
      storage: null,
      writer: 'other',
      log: quiet
    })
    await other.hydrate()
    const transport = engine.transport()
    const release = engine.holdNextGet()
    const late = createUiSettingsStore({ transport, storage: null, writer: 'late', log: quiet })
    const hydrating = late.hydrate()
    await flushMicrotasks()
    // Lands while `late` waits for its snapshot: the snapshot will carry it.
    other.set('videorc.theme', 'light')
    await other.flush()
    release()
    expect(await hydrating).toMatchObject({ state: 'hydrated', revision: 1 })
    expect(late.get('videorc.theme')).toBe('light')

    // A replayed older change is ignored; a newer one applies.
    const listeners = new Set<(change: UiSettingsChange) => void>()
    const replayTransport: UiSettingsTransport = {
      get: async () => ({
        entries: { 'videorc.theme': 'dark' },
        revision: 5,
        localStorageMigrated: true
      }),
      set: async () => {
        throw new Error('unused')
      },
      onChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    const store = createUiSettingsStore({
      transport: replayTransport,
      storage: null,
      writer: 'w',
      log: quiet
    })
    await store.hydrate()
    for (const listener of listeners) {
      listener({ revision: 4, put: { 'videorc.theme': 'stale' }, delete: [] })
    }
    expect(store.get('videorc.theme')).toBe('dark')
    for (const listener of listeners) {
      listener({ revision: 6, put: { 'videorc.theme': 'newer' }, delete: [] })
    }
    expect(store.get('videorc.theme')).toBe('newer')
    // A key with a pending local write keeps the local value.
    store.set('videorc.theme', 'mine')
    for (const listener of listeners) {
      listener({ revision: 7, put: { 'videorc.theme': 'theirs' }, delete: [] })
    }
    expect(store.get('videorc.theme')).toBe('mine')
  })

  it('never loses a write while the engine is away: pending, journaled, retried, and replayed by the next window', async () => {
    const engine = fakeEngine()
    const storage = fakeStorage()
    const timers: Array<() => void> = []
    const transport = engine.transport()
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
    const store = createUiSettingsStore({
      transport,
      storage,
      writer: 'window-main',
      log,
      setTimeout: (callback) => {
        timers.push(callback)
        return timers.length
      },
      clearTimeout: () => {}
    })
    await store.hydrate()
    engine.setOnline(false)
    store.set('videorc.theme', 'light')
    await expect(store.flush()).rejects.toThrow("isn't connected")
    expect(store.status()).toMatchObject({
      pendingWrites: ['videorc.theme'],
      lastSendError: "Videorc's engine isn't connected."
    })
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(storage.getItem(`${UI_SETTINGS_JOURNAL_PREFIX}window-main`)).toContain('light')
    expect(store.get('videorc.theme')).toBe('light')

    // The engine returns: the reconnect signal flushes it.
    engine.setOnline(true)
    transport.reconnect()
    await flushMicrotasks()
    expect(engine.entries.get('videorc.theme')).toBe('light')
    expect(store.status().pendingWrites).toEqual([])
    expect(store.status().lastSendError).toBeNull()
    expect(storage.getItem(`${UI_SETTINGS_JOURNAL_PREFIX}window-main`)).toBeNull()

    // A window that closed with a journal: the next hydrate replays it.
    storage.setItem(
      `${UI_SETTINGS_JOURNAL_PREFIX}window-closed`,
      JSON.stringify({ put: { 'videorc.notesTab': 'chat' }, delete: ['videorc.theme'] })
    )
    const next = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-next',
      log: quiet
    })
    expect(await next.hydrate()).toMatchObject({ state: 'hydrated', replayed: 2 })
    expect(engine.entries.get('videorc.notesTab')).toBe('chat')
    expect(engine.entries.has('videorc.theme')).toBe(false)
    expect(storage.getItem(`${UI_SETTINGS_JOURNAL_PREFIX}window-closed`)).toBeNull()
  })

  it('renders past the deadline with the store unavailable, then hydrates late and tells the listeners', async () => {
    const engine = fakeEngine({ 'videorc.theme': 'dark' })
    const release = engine.holdNextGet()
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
    const store = createUiSettingsStore({
      transport: engine.transport(),
      storage: fakeStorage(),
      writer: 'w',
      log
    })
    const heard: string[][] = []
    store.subscribe((keys) => heard.push([...keys]))
    const result = await store.hydrate({ timeoutMs: 10 })
    expect(result).toEqual({
      state: 'unavailable',
      reason: 'The engine did not answer within 10 ms; still waiting.'
    })
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('did not answer'))
    expect(store.get('videorc.theme')).toBeUndefined()
    release()
    await flushMicrotasks()
    // Revision 1: the empty migration batch marked the profile migrated.
    expect(store.status().hydration).toMatchObject({ state: 'hydrated', revision: 1 })
    expect(store.get('videorc.theme')).toBe('dark')
    expect(heard).toEqual([['videorc.theme']])
    // The same promise for every later caller.
    expect(await store.hydrate()).toEqual(result)
  })

  it('hydrates with the migrated profile when another window migrated it after this snapshot', async () => {
    const engine = fakeEngine()
    const storage = fakeStorage(previousReleaseProfile)
    const late = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-late',
      log: quiet,
      locks: null
    })
    // `late` reads revision 0, unmigrated; its answer waits.
    const release = engine.holdNextGetResult()
    const lateHydrating = late.hydrate()
    await flushMicrotasks()
    // Meanwhile `main` migrates the profile: revision 1, which `late` buffers.
    const main = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-main',
      log: quiet,
      locks: null
    })
    expect(await main.hydrate()).toMatchObject({ state: 'hydrated', revision: 1 })
    release()
    // `late`'s own migration lands nothing but the mark (revision 2); the
    // profile reaches it all the same.
    expect(await lateHydrating).toMatchObject({ state: 'hydrated', revision: 2, migrated: 0 })
    for (const [key, value] of Object.entries(previousReleaseProfile)) {
      expect(late.get(key)).toBe(value)
    }
  })

  it("leaves an open window's journal to it, and replays a closed window's", async () => {
    const engine = fakeEngine()
    const storage = fakeStorage()
    const held = new Set<string>()
    const locks: UiSettingsLocks = {
      hold(name, release) {
        held.add(name)
        void release.then(() => held.delete(name))
      },
      async ifFree(name, task) {
        if (held.has(name)) return null
        held.add(name)
        try {
          return await task()
        } finally {
          held.delete(name)
        }
      }
    }
    // An open window whose write the engine has not taken yet.
    const base = engine.transport()
    let stall = false
    const stuck: UiSettingsTransport = {
      ...base,
      set: (params) => (stall ? new Promise<UiSettingsChange>(() => {}) : base.set(params))
    }
    const open = createUiSettingsStore({
      transport: stuck,
      storage,
      writer: 'window-open',
      log: quiet,
      locks
    })
    await open.hydrate()
    stall = true
    open.set('videorc.theme', 'light')
    await flushMicrotasks()
    const openJournal = `${UI_SETTINGS_JOURNAL_PREFIX}window-open`
    expect(storage.getItem(openJournal)).toContain('light')

    const next = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-next',
      log: quiet,
      locks
    })
    expect(await next.hydrate()).toMatchObject({ state: 'hydrated', replayed: 0 })
    expect(engine.entries.has('videorc.theme')).toBe(false)
    expect(storage.getItem(openJournal)).toContain('light')

    // Closed: its lock is free, so the next window replays and removes it.
    open.dispose()
    await flushMicrotasks()
    const after = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-after',
      log: quiet,
      locks
    })
    expect(await after.hydrate()).toMatchObject({ state: 'hydrated', replayed: 1 })
    expect(engine.entries.get('videorc.theme')).toBe('light')
    expect(storage.getItem(openJournal)).toBeNull()
  })

  it('never replays a stale journal over a newer write, nor removes a journal rewritten meanwhile', async () => {
    const engine = fakeEngine()
    const storage = fakeStorage()
    let clock = 10
    engine.setClock(clock)
    // Without Web Locks every journal replays, by its write times.
    const writerBase = engine.transport()
    let cutOff = false
    const flaky: UiSettingsTransport = {
      ...writerBase,
      set: async (params) => {
        if (cutOff) throw new Error("Videorc's engine isn't connected.")
        return writerBase.set(params)
      }
    }
    const writer = createUiSettingsStore({
      transport: flaky,
      storage,
      writer: 'window-a',
      log: quiet,
      locks: null,
      now: () => clock,
      setTimeout: () => 0,
      clearTimeout: () => {}
    })
    await writer.hydrate()
    cutOff = true
    writer.set('videorc.theme', 'v1')
    writer.set('videorc.notesTab', 'chat')
    await expect(writer.flush()).rejects.toThrow("isn't connected")
    const journalKey = `${UI_SETTINGS_JOURNAL_PREFIX}window-a`

    // Another window writes the theme later, and the engine takes it.
    clock = 20
    engine.setClock(clock)
    const other = createUiSettingsStore({
      transport: engine.transport(),
      storage: null,
      writer: 'window-b',
      log: quiet,
      locks: null
    })
    await other.hydrate()
    other.set('videorc.theme', 'v2')
    await other.flush()

    // A third window replays window-a's journal; while its batch is in
    // flight, window-a writes again, so the journal changes under it.
    clock = 30
    engine.setClock(clock)
    const base = engine.transport()
    let releaseReplay = () => {}
    const replaying: UiSettingsTransport = {
      ...base,
      set: async (params) => {
        await new Promise<void>((resolve) => (releaseReplay = resolve))
        return base.set(params)
      }
    }
    const replayer = createUiSettingsStore({
      transport: replaying,
      storage,
      writer: 'window-c',
      log: quiet,
      locks: null
    })
    const hydrating = replayer.hydrate()
    await flushMicrotasks()
    writer.set('videorc.orcleTab', 'buddy')
    releaseReplay()
    expect(await hydrating).toMatchObject({ state: 'hydrated', replayed: 1 })
    // The stale v1 never overwrote v2; the absent key landed.
    expect(engine.entries.get('videorc.theme')).toBe('v2')
    expect(replayer.get('videorc.theme')).toBe('v2')
    expect(engine.entries.get('videorc.notesTab')).toBe('chat')
    // The rewritten journal stays for its window.
    expect(storage.getItem(journalKey)).toContain('buddy')
  })

  it('replays orphaned journals in write order whatever their order in storage, and never resurrects a delete', async () => {
    const engine = fakeEngine({ 'videorc.notesTab': 'chat' })
    const journal = (put: Record<string, string>, deletes: string[], at: number) =>
      JSON.stringify({
        put,
        delete: deletes,
        at: Object.fromEntries([...Object.keys(put), ...deletes].map((key) => [key, at]))
      })
    // Enumerated newest first: the t20 journal before the t10 one. orcleTab
    // never existed: its t20 delete must still outrank the t10 put.
    const storage = fakeStorage({
      [`${UI_SETTINGS_JOURNAL_PREFIX}window-new`]: journal(
        { 'videorc.theme': 'v2' },
        ['videorc.orcleTab'],
        20
      ),
      [`${UI_SETTINGS_JOURNAL_PREFIX}window-old`]: journal(
        { 'videorc.theme': 'v1', 'videorc.notesTab': 'stale', 'videorc.orcleTab': 'old' },
        [],
        10
      )
    })
    // Another window deleted notesTab at t15, after the old journal's put.
    engine.setClock(15)
    const deleter = createUiSettingsStore({
      transport: engine.transport(),
      storage: null,
      writer: 'window-deleter',
      log: quiet,
      locks: null
    })
    await deleter.hydrate()
    deleter.remove('videorc.notesTab')
    await deleter.flush()
    expect(engine.entries.has('videorc.notesTab')).toBe(false)

    engine.setClock(30)
    const recovering = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-recovering',
      log: quiet,
      locks: null
    })
    expect(await recovering.hydrate()).toMatchObject({ state: 'hydrated', replayed: 1 })
    // The t20 write stands over the t10 one, and the t15 delete over the t10 put.
    expect(engine.entries.get('videorc.theme')).toBe('v2')
    expect(engine.entries.has('videorc.notesTab')).toBe(false)
    expect(engine.entries.has('videorc.orcleTab')).toBe(false)
    expect(recovering.get('videorc.theme')).toBe('v2')
    expect(recovering.has('videorc.notesTab')).toBe(false)
    // Both journals were replayed whole, so both are gone.
    expect(storage.dump()).toEqual({})
  })

  it('refuses a null or undefined value: that is a remove', async () => {
    const store = createUiSettingsStore({
      transport: fakeEngine().transport(),
      storage: null,
      writer: 'w',
      log: quiet
    })
    await store.hydrate()
    expect(() => store.set('videorc.theme', null as unknown as UiSettingsValue)).toThrow(
      'remove it instead'
    )
  })
})

describe('the window transports', () => {
  it('relays the socket-less windows through main and names a window with neither', async () => {
    const change: UiSettingsChange = { revision: 1, put: {}, delete: [] }
    const api = {
      getUiSettings: vi.fn(async () => ({ entries: {}, revision: 0, localStorageMigrated: true })),
      setUiSettings: vi.fn(async () => change),
      onUiSettingsChanged: vi.fn(() => () => {})
    }
    const relay = createRelayUiSettingsTransport(api)
    await relay.get({ keys: ['videorc.theme'] })
    expect(api.getUiSettings).toHaveBeenCalledWith({ keys: ['videorc.theme'] })
    expect(await relay.set({ put: { 'videorc.theme': 'dark' } })).toBe(change)
    relay.onChange(() => {})
    expect(api.onUiSettingsChanged).toHaveBeenCalledTimes(1)

    const chosen = windowUiSettingsTransport(api)
    expect(await chosen.get()).toEqual({ entries: {}, revision: 0, localStorageMigrated: true })

    const none = windowUiSettingsTransport({})
    await expect(none.get()).rejects.toThrow("can't reach Videorc's settings")
    await expect(windowUiSettingsTransport(undefined).get()).rejects.toThrow(
      "can't reach Videorc's settings"
    )

    // Such a window renders at once with the store unavailable and never retries.
    const timers: unknown[] = []
    const store = createUiSettingsStore({
      transport: none,
      storage: null,
      writer: 'w',
      log: quiet,
      setTimeout: (callback) => {
        timers.push(callback)
        return timers.length
      },
      clearTimeout: () => {}
    })
    expect(await store.hydrate({ timeoutMs: 1_000 })).toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining("can't reach Videorc's settings")
    })
    // Only the hydrate deadline was scheduled, no retry.
    expect(timers).toHaveLength(1)
  })
})
