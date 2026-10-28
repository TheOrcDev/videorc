import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  CAPTURE_CONFIG_STORAGE_KEY,
  FORGET_WORKING_SCENE_JS,
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

test('the forget snippet removes the working scene', () => {
  const removed = []
  const localStorage = { removeItem: (key) => removed.push(key) }
  new Function('localStorage', FORGET_WORKING_SCENE_JS)(localStorage)
  assert.deepEqual(removed, [WORKING_SCENE_STORAGE_KEY])
})
