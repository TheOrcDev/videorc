import assert from 'node:assert/strict'
import { test } from 'node:test'

import { scenePresetStateReadCode } from './scene-presets-smoke-state.mjs'

const readState = (state) =>
  new Function('window', scenePresetStateReadCode)({
    __videorcSmokeScenePresets: { state: () => state, apply: () => true }
  })

test('renderer state read validates the full data without rewriting undefined or nested values', () => {
  const state = {
    pendingId: undefined,
    scenes: [{ visual: { sources: { cameraOff: true }, layout: { cameraZoom: 125 } } }],
    diagnostics: { sourceSwitchReasons: { camera: null }, pending: false }
  }
  const result = readState(state)
  assert.equal(result, state)
  assert.deepEqual(structuredClone(result), state)
})

for (const field of ['sourceSwitchReason', 'retrySourceStatus']) {
  test(`renderer state read names ${field} before a transfer without exposing values`, () => {
    assert.throws(() => readState({ diagnostics: { [field]: () => 'private-value' } }), {
      message: `Scene-preset smoke state is not serializable at state.diagnostics.${field}`
    })
  })
}

test('renderer state read checks nested scene arrays', () => {
  assert.throws(() => readState({ scenes: [{ visual: { background: { action: () => true } } }] }), {
    message:
      'Scene-preset smoke state is not serializable at state.scenes[0].visual.background.action'
  })
})

test('renderer state read finds an uncloneable diagnostic beyond a cyclic reference', () => {
  const state = { diagnostics: {} }
  state.diagnostics.self = state
  state.diagnostics.action = () => true
  assert.throws(() => readState(state), {
    message: 'Scene-preset smoke state is not serializable at state.diagnostics.action'
  })
})

test('renderer state read preserves the not-ready value for startup polling', () => {
  assert.equal(new Function('window', scenePresetStateReadCode)({}), undefined)
})
