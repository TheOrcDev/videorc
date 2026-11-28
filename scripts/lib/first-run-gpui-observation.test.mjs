import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateFirstRunSmokeStep } from './first-run-smoke-gate.mjs'
import { gpuiFirstRunObservation, gpuiToneFacts } from './first-run-gpui-observation.mjs'

const record = JSON.stringify({
  version: 2,
  status: 'in-progress',
  step: 'permissions',
  goal: null,
  updatedAt: '2026-11-28T09:54:13.092Z'
})
const dark = { theme: 'dark', increaseContrast: false, inverse: false, shaderDim: 0.3, brightness: 1 }
const light = { ...dark, theme: 'light', inverse: true, shaderDim: 0, brightness: 1 }
const rows = ['screen-recording', 'system-audio', 'microphone', 'camera'].map((id) => ({
  id,
  state: 'granted',
  required: id !== 'camera',
  checking: false
}))
const fr = (over = {}) => ({
  open: true,
  mode: 'first-run',
  step: 'permissions',
  position: 1,
  count: 5,
  goal: null,
  primary: 'Continue',
  backdrop: { mode: 'moving', reason: null, presentedFrames: 100, mountToMovingMs: 279 },
  tone: dark,
  look: { layoutPreset: null, liveBackground: null },
  rowsReady: true,
  rows,
  layoutOptions: [],
  record,
  ...over
})

test('the fresh permissions card passes the shared gate', () => {
  const o = gpuiFirstRunObservation(fr(), { recordRaw: record })
  const result = evaluateFirstRunSmokeStep('fresh', o)
  assert.deepEqual(result.failures, [])
  assert.equal(evaluateFirstRunSmokeStep('moving', o).pass, true)
})

test('a backdrop that is still under reduced motion has no canvas', () => {
  const o = gpuiFirstRunObservation(
    fr({ backdrop: { mode: 'still', reason: 'reduced-motion', presentedFrames: null } }),
    { recordRaw: record }
  )
  assert.equal(o.canvasCount, 0)
  assert.equal(evaluateFirstRunSmokeStep('reduced-motion', o).pass, true)
})

test('the tone facts are the CSS the gate expects, dark and light, with more contrast', () => {
  assert.deepEqual(gpuiToneFacts(dark).pictureFilter, 'none')
  assert.match(gpuiToneFacts(dark).posterFilter, /^brightness\(0\.\d+\)$/)
  assert.equal(gpuiToneFacts(light).pictureFilter, 'invert(1)')
  assert.equal(
    gpuiToneFacts({ ...light, increaseContrast: true, brightness: 0.85 }).pictureFilter,
    'invert(1) brightness(0.85)'
  )
  for (const tone of [dark, light, { ...light, increaseContrast: true, brightness: 0.85 }]) {
    const o = gpuiFirstRunObservation(fr({ tone }), { recordRaw: record })
    assert.deepEqual(evaluateFirstRunSmokeStep('tone', o).failures, [], JSON.stringify(tone))
  }
})

test('a closed setup reads as the workspace, its backdrop player gone', () => {
  const o = gpuiFirstRunObservation(
    fr({
      open: false,
      step: null,
      position: null,
      count: null,
      primary: null,
      backdrop: { mode: 'starting', reason: null, presentedFrames: null, mountToMovingMs: null }
    }),
    { recordRaw: JSON.stringify({ ...JSON.parse(record), status: 'done', step: 'destinations' }) }
  )
  assert.equal(o.setup, null)
  assert.equal(o.sidebar, true)
  assert.equal(o.retainedContextsLost, true)
})
