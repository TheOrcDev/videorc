import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PREVIEW_INTERACTION_STRESS_PROFILE,
  analyzeCgWindowObservations,
  analyzeNativeStatusSamples,
  cgOraclePreviewReady,
  effectivePresentFpsFloor,
  pixelOracleCaptureSize
} from './preview-interaction-stress.mjs'

describe('preview interaction stress contract', () => {
  it('allows measurement tolerance only when recording caps presentation at the floor', () => {
    assert.equal(effectivePresentFpsFloor(30, 60), 30)
    assert.equal(effectivePresentFpsFloor(30, 30), 28.5)
    assert.equal(effectivePresentFpsFloor(30, undefined), 30)
  })

  it('keeps the movement and rapid-scene workload from shrinking', () => {
    assert.deepEqual(PREVIEW_INTERACTION_STRESS_PROFILE.floating, {
      positionUpdates: 120,
      cadenceMs: 16,
      burstUpdates: 60,
      burstCadenceMs: 4
    })
    assert.deepEqual(PREVIEW_INTERACTION_STRESS_PROFILE.docked, {
      positionUpdates: 120,
      cadenceMs: 16,
      burstUpdates: 60,
      burstCadenceMs: 4
    })
    assert.equal(PREVIEW_INTERACTION_STRESS_PROFILE.sceneRounds, 10)
    assert.deepEqual(PREVIEW_INTERACTION_STRESS_PROFILE.sceneSequence, [
      'camera-only',
      'screen-only',
      'side-by-side',
      'screen-camera'
    ])
  })

  it('caps the persistent pixel oracle without changing the preview aspect ratio', () => {
    assert.deepEqual(pixelOracleCaptureSize(1920, 1136), { width: 304, height: 180 })
    assert.deepEqual(pixelOracleCaptureSize(320, 180), { width: 320, height: 180 })
    assert.deepEqual(pixelOracleCaptureSize(4000, 1000), { width: 320, height: 80 })
    assert.deepEqual(PREVIEW_INTERACTION_STRESS_PROFILE.pixelOracle, {
      maxWidth: 320,
      maxHeight: 180,
      sampleIntervalMs: 200
    })
  })

  it('rejects native presentation stalls even when status still claims live', () => {
    const result = analyzeNativeStatusSamples(
      [sample(0, 40), sample(100, 40), sample(260, 40), sample(300, 41)],
      { maxFrameStallMs: 250, maxSampleGapMs: 250, maxDroppedFrameDelta: 8 }
    )

    assert.equal(result.maxFrameStallMs, 260)
    assert.match(result.failures.join('\n'), /presented-frame stall 260ms exceeded 250ms/)
  })

  it('scopes presented frame counters to their compositor run', () => {
    const result = analyzeNativeStatusSamples(
      [sample(0, 40, 'run-a'), sample(20, 41, 'run-a'), sample(40, 1, 'run-b')],
      { maxFrameStallMs: 250, maxSampleGapMs: 250, maxDroppedFrameDelta: 8 }
    )

    assert.equal(result.compositorRunTransitions, 1)
    assert.doesNotMatch(result.failures.join('\n'), /moved backwards/)
  })

  it('still rejects a presented frame regression inside one compositor run', () => {
    const result = analyzeNativeStatusSamples(
      [sample(0, 40, 'run-a'), sample(20, 41, 'run-a'), sample(40, 1, 'run-a')],
      { maxFrameStallMs: 250, maxSampleGapMs: 250, maxDroppedFrameDelta: 8 }
    )

    assert.match(result.failures.join('\n'), /presented frame moved backwards from 41 to 1/)
  })

  it('enforces the production profile frame-stall limit', () => {
    const result = analyzeNativeStatusSamples(
      [sample(0, 40), sample(100, 40), sample(260, 40), sample(300, 41)],
      PREVIEW_INTERACTION_STRESS_PROFILE.thresholds
    )

    assert.match(result.failures.join('\n'), /presented-frame stall 260ms exceeded 250ms/)
  })

  it('rejects silent transport downgrade and unbounded helper work', () => {
    const downgraded = sample(20, 42)
    downgraded.status.transport = 'electron-proof-surface'
    downgraded.status.backing = 'electron-browser-window'
    downgraded.status.pendingHostCommandCount = 2

    const result = analyzeNativeStatusSamples([sample(0, 41), downgraded], {
      maxFrameStallMs: 250,
      maxSampleGapMs: 250,
      maxDroppedFrameDelta: 8
    })

    assert.match(result.failures.join('\n'), /transport electron-proof-surface/)
    assert.match(result.failures.join('\n'), /backing electron-browser-window/)
    assert.match(result.failures.join('\n'), /helper request depth 2 exceeded 1/)
  })

  it('allows one active in-process mutation plus one latest pending placement', () => {
    const bounded = sample(20, 42)
    bounded.status.nativePreviewHostKind = 'in-process'
    bounded.status.pendingHostCommandCount = 2

    const result = analyzeNativeStatusSamples([sample(0, 41), bounded], {
      maxFrameStallMs: 250,
      maxSampleGapMs: 250,
      maxDroppedFrameDelta: 8
    })

    assert.doesNotMatch(result.failures.join('\n'), /request depth/)
  })

  it('rejects a third queued in-process host operation', () => {
    const unbounded = sample(20, 42)
    unbounded.status.nativePreviewHostKind = 'in-process'
    unbounded.status.pendingHostCommandCount = 3

    const result = analyzeNativeStatusSamples([sample(0, 41), unbounded], {
      maxFrameStallMs: 250,
      maxSampleGapMs: 250,
      maxDroppedFrameDelta: 8
    })

    assert.match(result.failures.join('\n'), /in-process request depth 3 exceeded 2/)
  })

  it('treats an in-process host as one OS-atomic Electron window with no helper', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()],
          processes: [{ pid: 10, ppid: 1, command: 'Electron' }]
        }
      ],
      { expectedHostKind: 'in-process' }
    )

    assert.deepEqual(result.failures, [])
    assert.equal(result.maxSurfaceOffsetPx, 0)
    assert.equal(result.inProcessSamples, 1)
  })

  it('scopes the preview oracle to the launched Electron process', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow(), { ...electronWindow(), pid: 99, id: 100 }],
          processes: [
            { pid: 10, ppid: 1, command: 'Electron' },
            { pid: 99, ppid: 1, command: 'Electron' }
          ]
        }
      ],
      { expectedHostKind: 'in-process', expectedWindowPid: 10 }
    )

    assert.deepEqual(result.failures, [])
  })

  it('allows the one Electron preview window to change levels when always-on-top is toggled', () => {
    const raisedWindow = { ...electronWindow(), layer: 3 }
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [raisedWindow],
          processes: [{ pid: 10, ppid: 1, command: 'Electron' }]
        }
      ],
      { expectedHostKind: 'in-process' }
    )

    assert.deepEqual(result.failures, [])
  })

  it('identifies the in-process preview by window identity during a fast sampling race', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 800, y: 700, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()],
          processes: [{ pid: 10, ppid: 1, command: 'Electron' }]
        }
      ],
      { expectedHostKind: 'in-process' }
    )

    assert.deepEqual(result.failures, [])
  })

  it('does not turn a stale oracle join into a vanished preview window', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()]
        },
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          oracleObserved: false,
          windows: []
        },
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()]
        }
      ],
      { expectedHostKind: 'in-process', minOracleCoverage: 0.5 }
    )

    assert.doesNotMatch(result.failures.join('\n'), /exactly one Electron preview window/)
    assert.doesNotMatch(result.failures.join('\n'), /could not identify the Electron preview base/)
    assert.equal(result.oracleUnavailableSamples, 1)
    assert.equal(result.inProcessNonNormalLayerSamples, 0)
  })

  it('fails separately when the persistent oracle has inadequate phase coverage', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()]
        },
        ...Array.from({ length: 3 }, () => ({
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          oracleObserved: false,
          windows: []
        }))
      ],
      { expectedHostKind: 'in-process', minOracleCoverage: 0.8 }
    )

    assert.match(result.failures.join('\n'), /oracle coverage 25\.0% was below 80\.0%/)
  })

  it('rejects a helper window or descendant process on the in-process path', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow(), helperWindow()],
          processes: [
            { pid: 10, ppid: 1, command: 'Electron' },
            { pid: 20, ppid: 10, command: 'native_preview_host_helper' }
          ]
        }
      ],
      { expectedHostKind: 'in-process' }
    )

    assert.match(result.failures.join('\n'), /in-process host exposed 1 helper CGWindow/)
    assert.match(result.failures.join('\n'), /spawned native_preview_host_helper/)
  })

  it('allows legitimately dark camera content in device mode', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()],
          processes: [{ pid: 10, ppid: 1, command: 'Electron' }],
          pixel: {
            sampleCount: 1000,
            meanLuma: 4,
            nonDarkFraction: 0.001,
            blankBaseFraction: 0.02
          }
        }
      ],
      { expectedHostKind: 'in-process', requirePixelOracle: true }
    )

    assert.doesNotMatch(result.failures.join('\n'), /preview base/)
  })

  it('rejects the exposed preview base in device mode', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()],
          processes: [{ pid: 10, ppid: 1, command: 'Electron' }],
          pixel: {
            sampleCount: 1000,
            meanLuma: 13,
            nonDarkFraction: 0,
            blankBaseFraction: 0.99
          }
        }
      ],
      { expectedHostKind: 'in-process', requirePixelOracle: true }
    )

    assert.match(result.failures.join('\n'), /pixel oracle observed the preview base/)
  })

  it('does not start a phase until the exact preview window has visible pixels', () => {
    assert.equal(
      cgOraclePreviewReady(
        {
          windows: [{ ...electronWindow(), name: 'Videorc' }],
          pixel: {
            sampleCount: 1000,
            meanLuma: 30,
            nonDarkFraction: 0.4,
            blankBaseFraction: 0
          }
        },
        { hostKind: 'in-process', requirePixels: true }
      ),
      false
    )
    assert.equal(
      cgOraclePreviewReady(
        {
          windows: [electronWindow()],
          pixel: {
            sampleCount: 1000,
            meanLuma: 13,
            nonDarkFraction: 0,
            blankBaseFraction: 0.99
          }
        },
        { hostKind: 'in-process', requirePixels: true }
      ),
      false
    )
    assert.equal(
      cgOraclePreviewReady(
        {
          windows: [electronWindow()],
          pixel: {
            sampleCount: 1000,
            meanLuma: 3,
            nonDarkFraction: 0,
            blankBaseFraction: 0.01
          }
        },
        { hostKind: 'in-process', requirePixels: true }
      ),
      true
    )
  })
})

function sample(at, frame, runId) {
  return {
    at,
    status: {
      state: 'live',
      transport: 'native-surface',
      backing: 'cametal-layer',
      sourcePixelsPresent: true,
      framesRendered: frame,
      presentedFrameId: frame,
      droppedFrames: 0,
      pendingHostCommandCount: 0,
      ...(runId ? { nativePreviewCompositorRunId: runId } : {})
    }
  }
}

function electronWindow() {
  return {
    order: 2,
    id: 100,
    pid: 10,
    owner: 'Electron',
    name: 'Videorc Preview',
    layer: 0,
    alpha: 1,
    x: 100,
    y: 100,
    width: 640,
    height: 390
  }
}

function helperWindow() {
  return {
    order: 1,
    id: 200,
    pid: 20,
    owner: 'native_preview_host_helper',
    name: '',
    layer: 0,
    alpha: 1,
    x: 100,
    y: 130,
    width: 640,
    height: 360
  }
}
