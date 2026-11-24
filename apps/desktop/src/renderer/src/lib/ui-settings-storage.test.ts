import { describe, expect, it, vi } from 'vitest'

import { UI_SETTINGS_VALUE_MAX_BYTES } from '../../../shared/backend'
import { createUiSettingsStore, type UiSettingsTransport } from './ui-settings-store'
import {
  setWindowUiSettingsStoreForTests,
  subscribeUiSetting,
  uiSettingsKeyValue,
  uiSettingsStorage,
  uiSettingsValueAsString,
  windowUiSettingsHydrated
} from './ui-settings-storage'
import { createMemoryUiSettingsEngine } from './ui-settings-test-store'
import {
  createBackendUiSettingsTransport,
  createUiSettingsSmokeSeam,
  hydrateUiSettingsBeforeFirstRender
} from './ui-settings-window'

const quiet = { warn: () => {}, error: () => {}, info: () => {} }

/** An engine whose first answer waits until `answer()`. */
function lateEngine(entries: Record<string, string>): {
  transport: UiSettingsTransport
  answer: () => void
} {
  const engine = createMemoryUiSettingsEngine(entries)
  const inner = engine.transport()
  let release: () => void = () => {}
  const answered = new Promise<void>((resolve) => (release = resolve))
  return {
    transport: { ...inner, get: async (params) => (await answered, inner.get(params)) },
    answer: () => release()
  }
}

describe('the key families’ storage (plan 220 S1.4b)', () => {
  it('reads and writes the same keys and strings the families kept in web storage', () => {
    const storage = uiSettingsStorage()
    expect(storage.getItem('videorc.aiConsent')).toBeNull()
    storage.setItem('videorc.aiConsent', '1')
    expect(storage.getItem('videorc.aiConsent')).toBe('1')
    storage.removeItem('videorc.aiConsent')
    expect(storage.getItem('videorc.aiConsent')).toBeNull()
    // A value a newer UI stored as JSON reads back as its JSON text.
    expect(uiSettingsValueAsString({ order: ['clock'] })).toBe('{"order":["clock"]}')
    expect(uiSettingsValueAsString(undefined)).toBeNull()
  })

  it('refuses at once what the engine would refuse, as full web storage did', () => {
    const tooLarge = 'x'.repeat(UI_SETTINGS_VALUE_MAX_BYTES)
    expect(() => uiSettingsStorage().setItem('videorc.settings', tooLarge)).toThrow(
      /was not saved: the value is \d+ bytes/
    )
    expect(uiSettingsStorage().getItem('videorc.settings')).toBeNull()
  })

  it('tells a family when its key changes, from this window or another', () => {
    const heard = vi.fn()
    const off = subscribeUiSetting('videorc.cohostSensitivity', heard)
    uiSettingsStorage().setItem('videorc.cohostSensitivity', 'strict')
    uiSettingsStorage().setItem('videorc.aiConsent', '1')
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })

  it('never lets a window without the snapshot overwrite the profile with its defaults', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const late = lateEngine({ 'videorc.captureConfig': '{"recordEnabled":false}' })
    const store = createUiSettingsStore({ transport: late.transport, storage: null, log: quiet })
    setWindowUiSettingsStoreForTests(store)
    void store.hydrate({ timeoutMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(windowUiSettingsHydrated()).toBe(false)

    // What a family read before the snapshot is a default; its write is refused.
    expect(uiSettingsStorage().getItem('videorc.captureConfig')).toBeNull()
    uiSettingsStorage().setItem('videorc.captureConfig', '{"recordEnabled":true}')
    uiSettingsStorage().setItem('videorc.captureConfig', '{"recordEnabled":true}')
    uiSettingsStorage().removeItem('videorc.captureConfig')
    expect(store.status().pendingWrites).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)

    late.answer()
    await store.whenHydrated()
    expect(uiSettingsStorage().getItem('videorc.captureConfig')).toBe('{"recordEnabled":false}')
    uiSettingsStorage().setItem('videorc.captureConfig', '{"recordEnabled":true}')
    expect(store.status().pendingWrites).toEqual(['videorc.captureConfig'])
    warn.mockRestore()
  })

  it('keeps the window adapter’s refusals per store, and a store’s own writes free', () => {
    const store = createUiSettingsStore({
      transport: createMemoryUiSettingsEngine().transport(),
      storage: null,
      log: quiet
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = uiSettingsKeyValue(() => store)
    storage.setItem('videorc.theme', 'light')
    expect(store.get('videorc.theme')).toBeUndefined()
    // The store itself (the migration, the journal) still writes before its snapshot.
    store.set('videorc.theme', 'dark')
    expect(store.get('videorc.theme')).toBe('dark')
    warn.mockRestore()
  })
})

describe('a window that rendered before its snapshot (plan 220 S1.4b)', () => {
  it('reloads once the snapshot arrives, so every family reads the real settings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const late = lateEngine({ 'videorc.firstRun': '{"status":"completed"}' })
    const store = createUiSettingsStore({ transport: late.transport, storage: null, log: quiet })
    setWindowUiSettingsStoreForTests(store)
    const reload = vi.fn()
    const result = await hydrateUiSettingsBeforeFirstRender(1, reload)
    expect(result.state).toBe('unavailable')
    expect(reload).not.toHaveBeenCalled()
    late.answer()
    await store.whenHydrated()
    await Promise.resolve()
    expect(reload).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('never reloads a window that had its snapshot before it rendered', async () => {
    const store = createUiSettingsStore({
      transport: createMemoryUiSettingsEngine().transport(),
      storage: null,
      log: quiet
    })
    setWindowUiSettingsStoreForTests(store)
    const reload = vi.fn()
    expect((await hydrateUiSettingsBeforeFirstRender(1_000, reload)).state).toBe('hydrated')
    await store.whenHydrated()
    await Promise.resolve()
    expect(reload).not.toHaveBeenCalled()
  })
})

// S1.4b.2: smokes seed right after launch or a reload, while the window is
// still hydrating. The seam refuses those writes (loudly) and says when the
// window is ready for them.
describe('the smoke seam (plan 220 S1.4b.2)', () => {
  it('refuses a write while hydrating, and is ready once the window rendered with its snapshot', async () => {
    const late = lateEngine({ 'videorc.aiConsent': '0' })
    const store = createUiSettingsStore({ transport: late.transport, storage: null, log: quiet })
    setWindowUiSettingsStoreForTests(store)
    const rendering = hydrateUiSettingsBeforeFirstRender(60_000, vi.fn())
    const seam = createUiSettingsSmokeSeam()
    expect(() => seam.setItem('videorc.aiConsent', '1')).toThrow(
      "This window's UI settings store has no snapshot yet (hydrating); write after it hydrates."
    )
    let ready = false
    const waiting = seam.ready().then(() => (ready = true))
    await Promise.resolve()
    expect(ready).toBe(false)
    late.answer()
    await waiting
    expect((await rendering).state).toBe('hydrated')
    expect(seam.getItem('videorc.aiConsent')).toBe('0')
    seam.setItem('videorc.aiConsent', '1')
    await seam.flush()
    expect(store.get('videorc.aiConsent')).toBe('1')
    // Ready at once from then on.
    await expect(seam.ready()).resolves.toBeUndefined()
  })

  it('is never ready in a window that rendered without its snapshot, even once it arrives', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const late = lateEngine({})
    const store = createUiSettingsStore({ transport: late.transport, storage: null, log: quiet })
    setWindowUiSettingsStoreForTests(store)
    const reload = vi.fn()
    expect((await hydrateUiSettingsBeforeFirstRender(1, reload)).state).toBe('unavailable')
    const seam = createUiSettingsSmokeSeam()
    const refusal =
      'This window rendered without its UI settings snapshot (The engine did not answer within 1 ms; still waiting.); it reloads once the snapshot arrives, so seed the reloaded window.'
    await expect(seam.ready()).rejects.toThrow(refusal)
    // The snapshot arrives: the window reloads, and this one stays refused.
    late.answer()
    await store.whenHydrated()
    await Promise.resolve()
    expect(reload).toHaveBeenCalledTimes(1)
    await expect(seam.ready()).rejects.toThrow(refusal)
    warn.mockRestore()
  })
})

describe("the main window's own engine connection (plan 220 S1.4b)", () => {
  // The engine reads absent params as null, which is no `UiSettingsGetParams`:
  // a bare read was refused as invalid-params and the main window never
  // hydrated (main's relay already sent `{}`).
  it('reads the whole store with an object, never without params', async () => {
    const requestTyped = vi.fn(async () => ({
      entries: {},
      revision: 0,
      localStorageMigrated: true
    }))
    const client = {
      connected: true,
      connect: async () => {},
      on: () => {},
      close: () => {},
      requestTyped
    }
    const transport = createBackendUiSettingsTransport({
      getConnection: async () => ({ host: '127.0.0.1', port: 1, token: 't' }),
      onConnection: () => () => {},
      createClient: () => client as never
    })
    await transport.get()
    await transport.get({ keys: ['videorc.theme'] })
    expect(requestTyped.mock.calls).toEqual([
      ['ui.settings.get', {}],
      ['ui.settings.get', { keys: ['videorc.theme'] }]
    ])
  })
})
