import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  CAPTURE_CONFIG_STORAGE_KEY,
  ONBOARDING_STORAGE_KEY,
  PRE_PAINT_COPY_KEYS,
  readUiSettingJs,
  RELOAD_KEEPING_SEED_JS,
  reloadKeepingSeedJs,
  seedUiSettingsJs,
  UI_SETTINGS_READY_JS,
  uiSettingsReadyJs,
  WORKING_SCENE_STORAGE_KEY,
  SCENES_STORAGE_KEY
} from './renderer-profile-seed.mjs'

const renderer = resolve(import.meta.dirname, '../../apps/desktop/src/renderer/src')

test('the seed keys are the renderer storage keys', () => {
  const presets = readFileSync(resolve(renderer, 'lib/scene-presets.ts'), 'utf8')
  assert.match(presets, /export const WORKING_SCENE_KEY = '([^']+)'/)
  assert.equal(
    presets.match(/export const WORKING_SCENE_KEY = '([^']+)'/)[1],
    WORKING_SCENE_STORAGE_KEY,
    SCENES_STORAGE_KEY
  )
  const capture = readFileSync(resolve(renderer, 'lib/capture.ts'), 'utf8')
  assert.equal(capture.match(/captureConfig: '([^']+)'/)?.[1], CAPTURE_CONFIG_STORAGE_KEY)
  assert.equal(capture.match(/onboarding: '([^']+)'/)?.[1], ONBOARDING_STORAGE_KEY)
  assert.equal(capture.match(/theme: '([^']+)'/)?.[1], PRE_PAINT_COPY_KEYS[0])
})

/**
 * The page's `window.__videorcUiSettings` over a map, as `ui-settings-window.ts`
 * installs it: a write before the snapshot throws, and `ready()` resolves once
 * the window rendered with it (`hydrate()` puts it there), or rejects with
 * `rendered` when it rendered without it.
 */
function fakeSeam(store, { hydrated = true, rendered = null } = {}) {
  let state = hydrated ? 'hydrated' : 'hydrating'
  const waiters = []
  const writable = () => {
    if (state !== 'hydrated') {
      throw new Error(
        `This window's UI settings store has no snapshot yet (${state}); write after it hydrates.`
      )
    }
  }
  return {
    getItem: (key) => (state === 'hydrated' && store.has(key) ? store.get(key) : null),
    setItem: (key, value) => (writable(), store.set(key, String(value))),
    removeItem: (key) => (writable(), store.delete(key)),
    keys: () => [...store.keys()],
    clear: () => (writable(), store.clear()),
    flush: async () => {},
    status: () => ({ hydration: { state } }),
    ready: () =>
      rendered
        ? Promise.reject(new Error(rendered))
        : state === 'hydrated'
          ? Promise.resolve()
          : new Promise((resolve) => waiters.push(resolve)),
    hydrate: () => {
      state = 'hydrated'
      for (const resolve of waiters.splice(0)) resolve()
    }
  }
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

/** Runs `snippet` as the statements of an `eval-js` body (an async function). */
async function runSeedSnippet(stored, snippet = RELOAD_KEEPING_SEED_JS) {
  const store = new Map(Object.entries(stored))
  const listeners = new Map()
  const window = {
    __videorcUiSettings: fakeSeam(store),
    addEventListener: (type, listener) => listeners.set(type, listener)
  }
  // The page's timers: the wait's own deadline is cleared, the reload is kept.
  const timers = []
  const setTimeout = (callback, delayMs) => timers.push({ callback, delayMs, cleared: false })
  const clearTimeout = (id) => {
    if (timers[id - 1]) timers[id - 1].cleared = true
  }
  let reloads = 0
  const location = { reload: () => (reloads += 1) }
  await new AsyncFunction('window', 'setTimeout', 'clearTimeout', 'location', snippet)(
    window,
    setTimeout,
    clearTimeout,
    location
  )
  return {
    store,
    listeners,
    timers: timers.filter((timer) => !timer.cleared),
    reloads: () => reloads
  }
}

test('the reload snippet forgets the working scene and reloads', async () => {
  const seed = JSON.stringify({ layout: { layoutPreset: 'screen-only' } })
  const run = await runSeedSnippet({
    [CAPTURE_CONFIG_STORAGE_KEY]: seed,
    [WORKING_SCENE_STORAGE_KEY]: '{"visual":{}}'
  })
  assert.equal(run.store.get(CAPTURE_CONFIG_STORAGE_KEY), seed)
  assert.equal(run.store.has(WORKING_SCENE_STORAGE_KEY), false)
  assert.equal(run.timers.length, 1)
  run.timers[0].callback()
  assert.equal(run.reloads(), 1)
})

// Retest 154 (plan 0008): the running renderer persisted its own capture
// config 64 ms after the seed, before the reload, and the reload loaded
// screen + camera. Whatever the page writes before it unloads, the seed wins.
test('the seed survives the renderer persisting its old config before the reload', async () => {
  const seed = JSON.stringify({ layout: { layoutPreset: 'screen-only' } })
  const run = await runSeedSnippet({ [CAPTURE_CONFIG_STORAGE_KEY]: seed })
  run.store.set(
    CAPTURE_CONFIG_STORAGE_KEY,
    JSON.stringify({ layout: { layoutPreset: 'screen-camera' } })
  )
  run.store.set(WORKING_SCENE_STORAGE_KEY, '{"visual":{}}')
  run.listeners.get('pagehide')()
  assert.equal(run.store.get(CAPTURE_CONFIG_STORAGE_KEY), seed)
  assert.equal(run.store.has(WORKING_SCENE_STORAGE_KEY), false)
})

test('a seed that keeps the remembered scene keeps it, and reloads after its delay', async () => {
  const seed = JSON.stringify({ streaming: { enabled: true } })
  const run = await runSeedSnippet(
    { [CAPTURE_CONFIG_STORAGE_KEY]: seed, [WORKING_SCENE_STORAGE_KEY]: '{"visual":{}}' },
    reloadKeepingSeedJs({ forgetWorkingScene: false, delayMs: 150 })
  )
  run.store.set(CAPTURE_CONFIG_STORAGE_KEY, '{"streaming":{"enabled":false}}')
  run.listeners.get('pagehide')()
  assert.equal(run.store.get(CAPTURE_CONFIG_STORAGE_KEY), seed)
  assert.equal(run.store.get(WORKING_SCENE_STORAGE_KEY), '{"visual":{}}')
  assert.deepEqual(
    run.timers.map((timer) => timer.delayMs),
    [150]
  )
  assert.throws(() => reloadKeepingSeedJs({ delayMs: -1 }), /Not a reload delay/)
})

// Retest 154: smoke:agent-mcp lost its seeded destinations to the same race.
// A script that seeds the capture config reloads through the helper, never
// through its own timer.
test('no smoke seeds the capture config and reloads on its own timer', () => {
  const scripts = resolve(import.meta.dirname, '..')
  const offenders = readdirSync(scripts)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => {
      const source = readFileSync(resolve(scripts, name), 'utf8')
      return (
        source.includes(CAPTURE_CONFIG_STORAGE_KEY) &&
        /setTimeout\(\s*\(\)\s*=>\s*(window\.)?location\.reload\(\)/.test(source)
      )
    })
  assert.deepEqual(offenders, [])
})

// A stale v2 library must not override a deterministic capture seed (D15).
test('a clean seed clears v2 again on pagehide; a real-source seed preserves it', () => {
  const stored = { [SCENES_STORAGE_KEY]: '{"version":2}', [WORKING_SCENE_STORAGE_KEY]: '{}' }
  const clean = runSeedSnippet(stored)
  assert.equal(clean.store.has(SCENES_STORAGE_KEY), false)
  clean.store.set(SCENES_STORAGE_KEY, 'late renderer write')
  clean.listeners.get('pagehide')()
  assert.equal(clean.store.has(SCENES_STORAGE_KEY), false)
  const kept = runSeedSnippet(stored, reloadKeepingSeedJs({ forgetWorkingScene: false }))
  kept.listeners.get('pagehide')()
  assert.equal(kept.store.get(SCENES_STORAGE_KEY), stored[SCENES_STORAGE_KEY])
  const migration = runSeedSnippet(
    stored,
    reloadKeepingSeedJs({ forgetWorkingScene: false, forgetScenes: true })
  )
  assert.equal(migration.store.has(SCENES_STORAGE_KEY), false)
  assert.equal(migration.store.get(WORKING_SCENE_STORAGE_KEY), '{}')
})

test('a settings seed writes the store, the pre-paint copy, and replaces a profile', async () => {
  const store = new Map([['videorc.firstRun', '{"status":"completed"}']])
  const web = new Map([['videorc.settingsTab', 'audio']])
  const localStorage = {
    setItem: (key, value) => web.set(key, String(value)),
    clear: () => web.clear()
  }
  const window = { __videorcUiSettings: fakeSeam(store) }
  const run = (snippet) =>
    new Function('window', 'localStorage', `return ${snippet}`)(window, localStorage)
  assert.equal(await run(seedUiSettingsJs({ [ONBOARDING_STORAGE_KEY]: 'creator-ux-v1' })), true)
  assert.equal(store.get(ONBOARDING_STORAGE_KEY), 'creator-ux-v1')
  assert.equal(store.get('videorc.firstRun'), '{"status":"completed"}')
  assert.equal(web.has(ONBOARDING_STORAGE_KEY), false)

  await run(seedUiSettingsJs({ 'videorc.theme': 'light' }, { replace: true }))
  assert.deepEqual(Object.fromEntries(store), { 'videorc.theme': 'light' })
  assert.deepEqual(Object.fromEntries(web), { 'videorc.theme': 'light' })
  assert.throws(() => seedUiSettingsJs({ 'videorc.aiConsent': 1 }), /Not a stored string/)
})

// S1.4b.2: smoke:agent-mcp, smoke:buddy-act and smoke:record-latency seeded
// while the window was still hydrating (or before its entry installed the
// seam) and failed at step 1 with "no snapshot yet (hydrating)". Every seed
// waits for the seam and the snapshot first.
test('a seed waits for the seam and the snapshot, then writes', async () => {
  const store = new Map([[CAPTURE_CONFIG_STORAGE_KEY, '{"video":{"fps":60}}']])
  const seam = fakeSeam(store, { hydrated: false })
  const window = {}
  const web = new Map()
  const localStorage = { setItem: (key, value) => web.set(key, value), clear: () => web.clear() }
  const page = (snippet) =>
    new AsyncFunction('window', 'localStorage', snippet)(window, localStorage)

  const seeding = page(`return ${seedUiSettingsJs({ 'videorc.theme': 'dark' })}`)
  // The window's entry installs the seam a moment later, still hydrating.
  await new Promise((resolve) => setTimeout(resolve, 120))
  window.__videorcUiSettings = seam
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(store.has('videorc.theme'), false, 'nothing is written before the snapshot')
  seam.hydrate()
  assert.equal(await seeding, true)
  assert.equal(store.get('videorc.theme'), 'dark')
  assert.equal(web.get('videorc.theme'), 'dark')

  // A seed's read waits too: before the snapshot every key reads null.
  const late = fakeSeam(store, { hydrated: false })
  window.__videorcUiSettings = late
  const reading = page(`return ${readUiSettingJs(CAPTURE_CONFIG_STORAGE_KEY)}`)
  setTimeout(() => late.hydrate(), 50)
  assert.equal(await reading, '{"video":{"fps":60}}')

  // And a hand-written seed through the shared wait, with the reload helper.
  const third = fakeSeam(store, { hydrated: false })
  window.__videorcUiSettings = third
  window.addEventListener = () => {}
  const reloadSeed = new AsyncFunction(
    'window',
    'location',
    `const settings = await ${UI_SETTINGS_READY_JS};
    settings.setItem(${JSON.stringify(CAPTURE_CONFIG_STORAGE_KEY)}, '{"layout":{}}');
    ${reloadKeepingSeedJs({ delayMs: 0 })}
    return true;`
  )
  const reloaded = new Promise((resolve) => {
    const result = reloadSeed(window, { reload: resolve })
    result.catch(resolve)
  })
  setTimeout(() => third.hydrate(), 50)
  await reloaded
  assert.equal(store.get(CAPTURE_CONFIG_STORAGE_KEY), '{"layout":{}}')
})

test('a seed in a window that rendered without its snapshot fails, naming why', async () => {
  const reason =
    'This window rendered without its UI settings snapshot (The engine did not answer within 15000 ms; still waiting.); it reloads once the snapshot arrives, so seed the reloaded window.'
  const store = new Map()
  const window = { __videorcUiSettings: fakeSeam(store, { rendered: reason }) }
  const localStorage = { setItem() {}, clear() {} }
  await assert.rejects(
    new AsyncFunction(
      'window',
      'localStorage',
      `return ${seedUiSettingsJs({ 'videorc.aiConsent': '1' })}`
    )(window, localStorage),
    { message: reason }
  )
  assert.equal(store.size, 0)
})

test('a seed gives up at its deadline, naming what it last saw', async () => {
  const wait = (window) =>
    new AsyncFunction('window', `return ${uiSettingsReadyJs({ timeoutMs: 120 })}`)(window)
  await assert.rejects(
    wait({}),
    /no UI settings store seam \(window\.__videorcUiSettings\) after 120 ms/
  )
  await assert.rejects(
    wait({ __videorcUiSettings: fakeSeam(new Map(), { hydrated: false }) }),
    /did not hydrate within 120 ms \(last seen: hydrating\)/
  )
  assert.throws(() => uiSettingsReadyJs({ timeoutMs: 0 }), /Not a UI settings wait/)
  assert.throws(() => readUiSettingJs(''), /Not a UI settings key/)
})

// Plan 220 S1.4b: the renderer reads its product keys from the UI settings
// store, so a smoke that writes one into localStorage changes nothing the app
// reads (and one that reads it there reads a stale copy). Only the theme's
// pre-paint copy, set with the storage event next-themes follows, and the
// per-device conveniences may still be touched there.
test('no script touches a renderer product key through localStorage', () => {
  const allowed = new Set([
    ...PRE_PAINT_COPY_KEYS,
    'videorc.settingsTab',
    'videorc.orcleTab',
    'videorc.livestreamView',
    'videorc.livestream.technicalDetails',
    'videorc.cleanCutDrafts',
    'videorc.reactPerfTrack'
  ])
  const roots = [
    resolve(import.meta.dirname, '..'),
    resolve(import.meta.dirname, '../live-lab/lib')
  ]
  const offenders = []
  for (const root of roots) {
    for (const name of readdirSync(root).filter((entry) => entry.endsWith('.mjs'))) {
      if (name.endsWith('.test.mjs') || name === 'renderer-profile-seed.mjs') continue
      const source = readFileSync(resolve(root, name), 'utf8')
      for (const match of source.matchAll(
        /localStorage\.(getItem|setItem|removeItem)\(\s*([^,)]*)/g
      )) {
        const key = match[2].trim().match(/^['"`]([^'"`$]+)['"`]$/)?.[1]
        if (!key || !allowed.has(key)) offenders.push(`${name}: ${match[0]}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})
