import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  CAPTURE_CONFIG_STORAGE_KEY,
  ONBOARDING_STORAGE_KEY,
  PRE_PAINT_COPY_KEYS,
  RELOAD_KEEPING_SEED_JS,
  reloadKeepingSeedJs,
  seedUiSettingsJs,
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

/** The page's `window.__videorcUiSettings` over a map, as `ui-settings-window.ts` installs it. */
function fakeSeam(store) {
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    keys: () => [...store.keys()],
    clear: () => store.clear(),
    flush: async () => {}
  }
}

function runSeedSnippet(stored, snippet = RELOAD_KEEPING_SEED_JS) {
  const store = new Map(Object.entries(stored))
  const listeners = new Map()
  const window = {
    __videorcUiSettings: fakeSeam(store),
    addEventListener: (type, listener) => listeners.set(type, listener)
  }
  const timers = []
  const setTimeout = (callback, delayMs) => timers.push({ callback, delayMs })
  let reloads = 0
  const location = { reload: () => (reloads += 1) }
  new Function('window', 'setTimeout', 'location', snippet)(window, setTimeout, location)
  return { store, listeners, timers, reloads: () => reloads }
}

test('the reload snippet forgets the working scene and reloads', () => {
  const seed = JSON.stringify({ layout: { layoutPreset: 'screen-only' } })
  const run = runSeedSnippet({
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
test('the seed survives the renderer persisting its old config before the reload', () => {
  const seed = JSON.stringify({ layout: { layoutPreset: 'screen-only' } })
  const run = runSeedSnippet({ [CAPTURE_CONFIG_STORAGE_KEY]: seed })
  run.store.set(
    CAPTURE_CONFIG_STORAGE_KEY,
    JSON.stringify({ layout: { layoutPreset: 'screen-camera' } })
  )
  run.store.set(WORKING_SCENE_STORAGE_KEY, '{"visual":{}}')
  run.listeners.get('pagehide')()
  assert.equal(run.store.get(CAPTURE_CONFIG_STORAGE_KEY), seed)
  assert.equal(run.store.has(WORKING_SCENE_STORAGE_KEY), false)
})

test('a seed that keeps the remembered scene keeps it, and reloads after its delay', () => {
  const seed = JSON.stringify({ streaming: { enabled: true } })
  const run = runSeedSnippet(
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
