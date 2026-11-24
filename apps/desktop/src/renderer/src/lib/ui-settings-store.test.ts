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
  let revision = 0
  let localStorageMigrated = false
  const listeners = new Set<(change: UiSettingsChange) => void>()
  const sets: UiSettingsSetParams[] = []
  let online = true
  let holdGet: (() => void) | null = null

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
      if (params.ifAbsent && entries.has(key)) continue
      entries.set(key, value)
      put[key] = value
    }
    for (const key of params.delete ?? []) {
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
        return structuredClone(snapshot(params))
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

  it('leaves a key or value past the limits in localStorage, named, and still hydrates', async () => {
    const engine = fakeEngine()
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
    const store = createUiSettingsStore({
      transport: engine.transport(),
      storage: fakeStorage({
        'videorc.theme': 'dark',
        'videorc.huge': 'x'.repeat(UI_SETTINGS_VALUE_MAX_BYTES),
        [`videorc.${'k'.repeat(UI_SETTINGS_KEY_MAX_CHARS)}`]: '1',
        'videorc.bad\nkey': '1'
      }),
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
    expect(engine.localStorageMigrated).toBe(true)
    expect(log.error).toHaveBeenCalledTimes(3)
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('"videorc.huge" stays in localStorage')
    )
    expect(migrationRefusal('videorc.theme', 'dark')).toBeNull()
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
      delete: []
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
    main.set('videorc.orcleTab', 'chat')
    main.set('videorc.theme', 'dark')
    await main.flush()
    // One batch, the last write per key.
    expect(engine.sets).toHaveLength(migrationBatches + 1)
    expect(engine.sets[migrationBatches]).toMatchObject({
      put: { 'videorc.theme': 'dark', 'videorc.orcleTab': 'chat' },
      writer: 'window-main'
    })
    expect(notes.get('videorc.theme')).toBe('dark')
    expect(notes.get('videorc.orcleTab')).toBe('chat')
    expect(heardByNotes).toEqual([['videorc.orcleTab', 'videorc.theme']])
    // The writer heard its own set() calls, never the echo.
    expect(heardByMain).toEqual([['videorc.theme'], ['videorc.orcleTab'], ['videorc.theme']])

    notes.remove('videorc.orcleTab')
    await notes.flush()
    expect(main.has('videorc.orcleTab')).toBe(false)
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
      JSON.stringify({ put: { 'videorc.orcleTab': 'chat' }, delete: ['videorc.theme'] })
    )
    const next = createUiSettingsStore({
      transport: engine.transport(),
      storage,
      writer: 'window-next',
      log: quiet
    })
    expect(await next.hydrate()).toMatchObject({ state: 'hydrated', replayed: 2 })
    expect(engine.entries.get('videorc.orcleTab')).toBe('chat')
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
    await expect(none.get()).rejects.toThrow('no engine access')
    await expect(windowUiSettingsTransport(undefined).get()).rejects.toThrow('no engine access')

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
      reason: expect.stringContaining('no engine access')
    })
    // Only the hydrate deadline was scheduled, no retry.
    expect(timers).toHaveLength(1)
  })
})
