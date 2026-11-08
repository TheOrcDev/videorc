import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  CAPTURE_CONFIG_STORAGE_KEY,
  RELOAD_KEEPING_SEED_JS,
  reloadKeepingSeedJs,
  WORKING_SCENE_STORAGE_KEY
} from './renderer-profile-seed.mjs'

const renderer = resolve(import.meta.dirname, '../../apps/desktop/src/renderer/src')

test('the seed keys are the renderer storage keys', () => {
  const presets = readFileSync(resolve(renderer, 'lib/scene-presets.ts'), 'utf8')
  assert.match(presets, /export const WORKING_SCENE_KEY = '([^']+)'/)
  assert.equal(
    presets.match(/export const WORKING_SCENE_KEY = '([^']+)'/)[1],
    WORKING_SCENE_STORAGE_KEY
  )
  const capture = readFileSync(resolve(renderer, 'lib/capture.ts'), 'utf8')
  assert.equal(capture.match(/captureConfig: '([^']+)'/)?.[1], CAPTURE_CONFIG_STORAGE_KEY)
})

function runSeedSnippet(stored, snippet = RELOAD_KEEPING_SEED_JS) {
  const store = new Map(Object.entries(stored))
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  }
  const listeners = new Map()
  const window = { addEventListener: (type, listener) => listeners.set(type, listener) }
  const timers = []
  const setTimeout = (callback, delayMs) => timers.push({ callback, delayMs })
  let reloads = 0
  const location = { reload: () => (reloads += 1) }
  new Function('localStorage', 'window', 'setTimeout', 'location', snippet)(
    localStorage,
    window,
    setTimeout,
    location
  )
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
  run.store.set(CAPTURE_CONFIG_STORAGE_KEY, JSON.stringify({ layout: { layoutPreset: 'screen-camera' } }))
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
