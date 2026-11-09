// Run: node --test scripts/lib/live-background-smoke.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  afterTakeLiveBackgroundState,
  chromiumGpuDisabled,
  compositorDrawsNoLiveBackground,
  idlePreviewLiveBackgroundReporter,
  liveBackgroundSampleMismatches,
  proofSurfaceLiveBackgroundVerdict,
  sceneCarriesBackground,
  smokeMicrophoneId
} from './live-background-smoke.mjs'

const silk = { id: 'silk', look: 'satin' }

test('the proof surface reports the idle preview on Linux, the compositor elsewhere', () => {
  assert.equal(idlePreviewLiveBackgroundReporter('linux'), 'proof-surface')
  assert.equal(idlePreviewLiveBackgroundReporter('darwin'), 'compositor')
  assert.equal(idlePreviewLiveBackgroundReporter('win32'), 'compositor')
})

test("Chromium's GPU is off only through the launch's explicit switches", () => {
  assert.equal(chromiumGpuDisabled({ VIDEORC_DISABLE_GPU: '1' }), true)
  assert.equal(chromiumGpuDisabled({ VIDEORC_SMOKE_DISABLE_ELECTRON_GPU: '1' }), true)
  assert.equal(chromiumGpuDisabled({ VIDEORC_DISABLE_GPU: '0' }), false)
  assert.equal(chromiumGpuDisabled({}), false)
})

test('a moving proof surface passes whether or not the GPU is off', () => {
  const live = { ...silk, rendering: 'shader', renderer: 'Mesa Intel(R) Graphics' }
  assert.equal(proofSurfaceLiveBackgroundVerdict(live, silk, { gpuDisabled: false }), 'shader')
  assert.equal(proofSurfaceLiveBackgroundVerdict(live, silk, { gpuDisabled: true }), 'shader')
})

test('a software-GPU poster passes only when the launch turned the GPU off', () => {
  // Plan 0007's log: SwiftShader under VIDEORC_DISABLE_GPU=1.
  const live = { ...silk, rendering: 'still', reason: 'software-gpu', detail: 'SwiftShader' }
  assert.equal(proofSurfaceLiveBackgroundVerdict(live, silk, { gpuDisabled: true }), 'host-still')
  assert.equal(proofSurfaceLiveBackgroundVerdict(live, silk, { gpuDisabled: false }), 'failed')
  const none = { ...silk, rendering: 'still', reason: 'no-gpu' }
  assert.equal(proofSurfaceLiveBackgroundVerdict(none, silk, { gpuDisabled: true }), 'host-still')
})

test('an app-side poster fails even with the GPU off', () => {
  for (const reason of ['shader-compile-failed', 'gpu-budget', 'forced', undefined]) {
    const live = { ...silk, rendering: 'still', reason }
    assert.equal(
      proofSurfaceLiveBackgroundVerdict(live, silk, { gpuDisabled: true }),
      'failed',
      String(reason)
    )
  }
})

test('the verdict waits while the surface starts or reports another case', () => {
  const options = { gpuDisabled: true }
  assert.equal(proofSurfaceLiveBackgroundVerdict(null, silk, options), null)
  assert.equal(proofSurfaceLiveBackgroundVerdict(undefined, silk, options), null)
  assert.equal(
    proofSurfaceLiveBackgroundVerdict({ ...silk, rendering: 'starting' }, silk, options),
    null
  )
  const beams = { id: 'beams', look: 'studio', rendering: 'shader' }
  assert.equal(proofSurfaceLiveBackgroundVerdict(beams, silk, options), null)
  const otherLook = { id: 'silk', look: 'midnight', rendering: 'shader' }
  assert.equal(proofSurfaceLiveBackgroundVerdict(otherLook, silk, options), null)
})

test("the scene carries the case's background by its source id", () => {
  // The shape plan 0007's timeout printed.
  const status = {
    sceneSources: [
      { kind: 'test-pattern', id: 'source:test-pattern', state: 'referenced' },
      { kind: 'background-image', id: 'background-image:live-silk-satin', state: 'live' }
    ]
  }
  assert.equal(sceneCarriesBackground(status, 'live-silk-satin'), true)
  assert.equal(sceneCarriesBackground(status, 'live-beams-studio'), false)
  assert.equal(sceneCarriesBackground({ sceneSources: [] }, 'live-silk-satin'), false)
  assert.equal(sceneCarriesBackground({}, 'live-silk-satin'), false)
})

test('the compositor draws no live background only with no status, programs or scratch', () => {
  assert.equal(compositorDrawsNoLiveBackground({ framePipeline: {} }), true)
  assert.equal(
    compositorDrawsNoLiveBackground({
      framePipeline: { liveBackgroundPrograms: 0, liveBackgroundScratchBytes: 0 }
    }),
    true
  )
  // A stopped take that still reports `shader` is not idle.
  assert.equal(
    compositorDrawsNoLiveBackground({
      liveBackground: { id: 'silk', look: 'satin', rendering: 'shader' },
      framePipeline: {}
    }),
    false
  )
  assert.equal(
    compositorDrawsNoLiveBackground({ framePipeline: { liveBackgroundPrograms: 1 } }),
    false
  )
  assert.equal(
    compositorDrawsNoLiveBackground({ framePipeline: { liveBackgroundScratchBytes: 4096 } }),
    false
  )
})

test('after a take, only a scene that kept the background tells a cleared status from a stale one', () => {
  const silkSource = { kind: 'background-image', id: 'background-image:live-silk-satin' }
  const kept = { sceneSources: [silkSource], framePipeline: {} }
  assert.equal(afterTakeLiveBackgroundState(kept, 'live-silk-satin'), 'clear')
  // Plan 0007's stale case: the take's last report outlived its run.
  const stale = {
    ...kept,
    liveBackground: { id: 'silk', look: 'satin', rendering: 'still', reason: 'gpu-budget' }
  }
  assert.equal(afterTakeLiveBackgroundState(stale, 'live-silk-satin'), 'stale')
  assert.equal(
    afterTakeLiveBackgroundState(
      { ...kept, framePipeline: { liveBackgroundPrograms: 1 } },
      'live-silk-satin'
    ),
    'stale'
  )
  // The app's own scene without the background clears the status by itself.
  assert.equal(
    afterTakeLiveBackgroundState({ sceneSources: [], framePipeline: {} }, 'live-silk-satin'),
    'displaced'
  )
  assert.equal(afterTakeLiveBackgroundState(stale, 'live-beams-studio'), 'displaced')
})

test("the take's samples must name the case, and a forced still its reason", () => {
  const shader = { liveBackground: { id: 'silk', rendering: 'shader' } }
  const other = { liveBackground: { id: 'beams', rendering: 'shader' } }
  const forcedStill = { liveBackground: { id: 'silk', rendering: 'still', reason: 'forced' } }
  const budgetStill = { liveBackground: { id: 'silk', rendering: 'still', reason: 'gpu-budget' } }
  assert.deepEqual(liveBackgroundSampleMismatches([shader, shader], { id: 'silk' }), [])
  assert.deepEqual(liveBackgroundSampleMismatches([shader, other], { id: 'silk' }), [other])
  assert.deepEqual(
    liveBackgroundSampleMismatches([forcedStill, budgetStill], { id: 'silk', forced: true }),
    [budgetStill]
  )
  assert.deepEqual(liveBackgroundSampleMismatches([{}], { id: 'silk' }), [{}])
})

test('a Linux take selects no microphone: the CoreAudio fixture id names none there', () => {
  assert.equal(smokeMicrophoneId('linux'), undefined)
  assert.equal(smokeMicrophoneId('darwin'), 'microphone:coreaudio:4294967295')
  assert.equal(smokeMicrophoneId('win32'), 'microphone:coreaudio:4294967295')
})
