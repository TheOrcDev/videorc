// Run: node --test scripts/lib/live-background-smoke.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RING_SQUARES,
  SPARSE_RING_MOTION,
  afterTakeLiveBackgroundState,
  busiestRingSquare,
  chromiumGpuDisabled,
  compositorDrawsNoLiveBackground,
  idlePreviewLiveBackgroundReporter,
  liveBackgroundSampleMismatches,
  liveBackgroundContinuityFailures,
  liveBackgroundTimingSummary,
  parseLiveBackgroundGuardReport,
  proofSurfaceLiveBackgroundVerdict,
  sceneCarriesBackground,
  smokeMicrophoneEnv,
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

test('the synthetic microphone brings the flags that open it and give it a tone', () => {
  const flags = { VIDEORC_CAPTION_CONTRACT_TEST: '1', VIDEORC_LIVE_SOURCE_SWITCH_TEST: '1' }
  assert.deepEqual(smokeMicrophoneEnv('darwin'), flags)
  assert.deepEqual(smokeMicrophoneEnv('win32'), flags)
  assert.deepEqual(smokeMicrophoneEnv('linux'), {})
})

test('the ring squares sit inside the stage margin, square on a 16:9 frame', () => {
  for (const { name, rect } of RING_SQUARES) {
    const inSideMargin = rect.x + rect.w <= 0.1 || rect.x >= 0.9
    const inTopOrBottomMargin = rect.y + rect.h <= 0.1 || rect.y >= 0.9
    assert(inSideMargin || inTopOrBottomMargin, `${name} is in the stage`)
    assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= 1 && rect.y + rect.h <= 1, name)
    assert(Math.abs(rect.w * 16 - rect.h * 9) < 0.01, `${name} is not square`)
  }
  assert.equal(RING_SQUARES[0].name, 'left', "the smoke's long-standing square comes first")
})

// 2026-11-26: Ghost Fibers' dots left the left square black (0.00) while the
// bottom-left one moved (0.70); a still margin measures 0.00-0.01.
test('the busiest ring square judges a sparse background; a still ring still fails', () => {
  const measured = (motions) =>
    RING_SQUARES.map((square, index) => ({ ...square, motion: motions[index] ?? 0 }))
  const dots = busiestRingSquare(measured([0, 0.01, 0, 0.53, 0, 0.1, 0.7, 0]))
  assert.equal(dots.name, 'bottom-left')
  assert(dots.motion > SPARSE_RING_MOTION)
  const still = busiestRingSquare(measured([0, 0.01, 0, 0, 0.01, 0, 0, 0]))
  assert(still.motion < SPARSE_RING_MOTION)
  assert.equal(busiestRingSquare(measured([0.5, 0.5])).name, 'left', 'the first of a tie')
  assert.equal(busiestRingSquare([{ name: 'x', motion: Number.NaN }]), null)
})

test('Q186 allows high p95 and Half recovery while rejecting any sampled poster', () => {
  const sample = (rendering, p95Ms = 100) => ({ liveBackground: { rendering, p95Ms } })
  assert.deepEqual(
    liveBackgroundContinuityFailures([sample('shader'), sample('half'), sample('shader')]),
    []
  )
  assert.deepEqual(liveBackgroundContinuityFailures([sample('half')]), [])
  assert.equal(
    liveBackgroundContinuityFailures([sample('shader'), sample('still'), sample('shader')]).length,
    1
  )
  for (const rendering of ['poster', 'starting', undefined]) {
    assert.equal(liveBackgroundContinuityFailures([sample(rendering)]).length, 1)
  }
  assert.equal(liveBackgroundContinuityFailures([{}]).length, 1)
  assert.equal(liveBackgroundContinuityFailures([]).length, 1)
})

test('Q186 rejects a Still transition between polls even when shader status recovers', () => {
  const samples = [{ liveBackground: { rendering: 'shader' } }]
  assert.equal(
    liveBackgroundContinuityFailures(samples, {
      guardReports: [
        { before: 'Half', after: 'Still' },
        { before: 'Still', after: 'Full' }
      ]
    }).length,
    1
  )
  assert.deepEqual(
    liveBackgroundContinuityFailures(samples, {
      guardReports: [
        { before: 'Full', after: 'Half' },
        { before: 'Half', after: 'Full' }
      ]
    }),
    []
  )
})

test('the explicit forced-still diagnostic retains its inverse rendering gate', () => {
  assert.deepEqual(
    liveBackgroundContinuityFailures([{ liveBackground: { rendering: 'still' } }], {
      forced: true
    }),
    []
  )
  assert.equal(
    liveBackgroundContinuityFailures([{ liveBackground: { rendering: 'shader' } }], {
      forced: true
    }).length,
    1
  )
})

test('guard log diagnostics preserve measured median and p95, including transition direction', () => {
  const report = parseLiveBackgroundGuardReport(
    '[backend:info] INFO live background Some(LiquidChrome) at 1920x1080: guard Full -> Half (median 4.12 ms, p95 4.55 ms, 120 frames, 7 late, frame 16.7 ms)'
  )
  assert.deepEqual(report, {
    id: 'liquid-chrome',
    width: 1920,
    height: 1080,
    before: 'Full',
    after: 'Half',
    p50Ms: 4.12,
    p95Ms: 4.55,
    frames: 120
  })
  assert.equal(parseLiveBackgroundGuardReport('unrelated median 9 ms'), null)
  const missing = parseLiveBackgroundGuardReport(
    'live background Some(Silk) at 1920x1080: guard Still -> Half (median NaN ms, p95 NaN ms, 0 frames'
  )
  assert.equal(missing.p50Ms, null)
  assert.equal(missing.p95Ms, null)
})

test('timing summary is informational and never labels a median of p95 polls as p50', () => {
  assert.deepEqual(liveBackgroundTimingSummary({ p95Ms: 4.5486 }, [], 2.75), {
    p50Ms: null,
    p50Source: 'unavailable: status exposes p95 only; no guard transition',
    p95Ms: 4.5486,
    p95Source: 'last status window',
    referenceMs: 2.75,
    timingGated: false
  })
  const summary = liveBackgroundTimingSummary(
    { p95Ms: 9 },
    [{ p50Ms: 3 }, { p50Ms: 4 }, { p50Ms: null }],
    2.75
  )
  assert.equal(summary.p50Ms, 4)
  assert.equal(summary.p50Source, 'last guard transition window')
  assert.equal(summary.p95Ms, 9)
  assert.equal(summary.timingGated, false)
})
