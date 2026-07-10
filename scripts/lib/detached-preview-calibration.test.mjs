import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createDetachedPreviewCalibrationEvidence,
  detachedPreviewCalibrationProvenance,
  DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS,
  DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE,
  DETACHED_PREVIEW_CALIBRATION_WINDOW_SIZE,
  inspectDetachedPreviewCalibrationSample
} from './detached-preview-calibration.mjs'

describe('detached preview calibration', () => {
  it('accepts aligned, visible 960x540 preview and native bounds', () => {
    const inspection = inspectDetachedPreviewCalibrationSample(windowState(), surfaceStatus())

    assert.equal(inspection.ready, true)
    assert.deepEqual(inspection.failures, [])
    assert.deepEqual(DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE, { width: 960, height: 540 })
    assert.deepEqual(DETACHED_PREVIEW_CALIBRATION_WINDOW_SIZE, { width: 960, height: 568 })
  })

  it('rejects the intermittent 440x247 native-preview size', () => {
    const inspection = inspectDetachedPreviewCalibrationSample(
      windowState({ contentBounds: bounds({ width: 440, height: 247 }) }),
      surfaceStatus({ bounds: nativeBounds({ width: 440, height: 247 }) })
    )

    assert.equal(inspection.ready, false)
    assert.deepEqual(inspection.failures, [
      'preview content was 440x247; expected 960x540',
      'native surface was 440x247; expected 960x540'
    ])
  })

  it('rejects hidden or non-native surfaces', () => {
    const inspection = inspectDetachedPreviewCalibrationSample(
      windowState({ visible: false }),
      surfaceStatus({ state: 'fallback', transport: 'live-jpeg', backing: 'none', bounds: null })
    )

    assert.equal(inspection.ready, false)
    assert.deepEqual(inspection.failures, [
      'preview window was not open and visible',
      'native surface was fallback/live-jpeg/none',
      'native surface bounds were not visible',
      'native surface bounds were missing or incomplete'
    ])
  })

  it('changes the stability key when either surface moves', () => {
    const first = inspectDetachedPreviewCalibrationSample(windowState(), surfaceStatus())
    const moved = inspectDetachedPreviewCalibrationSample(
      windowState({ contentBounds: bounds({ x: 101 }) }),
      surfaceStatus({ bounds: nativeBounds({ screenX: 101 }) })
    )

    assert.equal(first.ready, true)
    assert.equal(moved.ready, true)
    assert.notEqual(first.stabilityKey, moved.stabilityKey)
  })

  it('proves the same exact geometry before, at the start of, and after measurement', () => {
    const evidence = createDetachedPreviewCalibrationEvidence(calibrationPhases())

    assert.equal(evidence.pass, true)
    assert.deepEqual(evidence.failures, [])
    assert.deepEqual(evidence.contract.phaseSampleCounts, {
      beforeWarmup: 5,
      measurementStart: 1,
      measurementEnd: 5
    })
    assert.deepEqual(detachedPreviewCalibrationProvenance(evidence), {
      schemaVersion: 1,
      pass: true,
      mode: 'detached',
      surfaceSize: { width: 960, height: 540 },
      windowSize: { width: 960, height: 568 },
      phaseSampleCounts: DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS,
      transport: 'native-surface',
      backing: 'cametal-layer',
      scaleFactor: 2,
      visible: true,
      aligned: true,
      stableAcrossMeasurement: true
    })
  })

  it('rejects aligned geometry that moved during measurement', () => {
    const phases = calibrationPhases()
    phases.measurementEnd.samples = phaseSamples(5, {
      windowPatch: { contentBounds: bounds({ x: 180 }) },
      surfacePatch: { bounds: nativeBounds({ screenX: 180 }) }
    })

    const evidence = createDetachedPreviewCalibrationEvidence(phases)

    assert.equal(evidence.pass, false)
    assert.match(evidence.failures.join('\n'), /measurementEnd sample 1 geometry drifted/)
    assert.equal(detachedPreviewCalibrationProvenance(evidence).stableAcrossMeasurement, false)
  })

  it('rejects a display-scale change during measurement', () => {
    const phases = calibrationPhases()
    phases.measurementEnd.samples = phaseSamples(5, {
      surfacePatch: { bounds: nativeBounds({ scaleFactor: 1 }) }
    })

    const evidence = createDetachedPreviewCalibrationEvidence(phases)

    assert.equal(evidence.pass, false)
    assert.match(evidence.failures.join('\n'), /measurementEnd sample 1 geometry drifted/)
  })

  it('rejects fallback and insufficiently stable end geometry', () => {
    const phases = calibrationPhases()
    phases.measurementEnd = {
      samples: [
        inspectDetachedPreviewCalibrationSample(
          windowState(),
          surfaceStatus({ state: 'fallback', transport: 'live-jpeg', backing: 'none' })
        )
      ]
    }

    const evidence = createDetachedPreviewCalibrationEvidence(phases)

    assert.equal(evidence.pass, false)
    assert.match(evidence.failures.join('\n'), /measurementEnd captured 1\/5/)
    assert.match(evidence.failures.join('\n'), /fallback\/live-jpeg\/none/)
  })
})

function calibrationPhases() {
  return {
    beforeWarmup: { samples: phaseSamples(5) },
    measurementStart: { samples: phaseSamples(1) },
    measurementEnd: { samples: phaseSamples(5) }
  }
}

function phaseSamples(count, { windowPatch = {}, surfacePatch = {} } = {}) {
  return Array.from({ length: count }, () =>
    inspectDetachedPreviewCalibrationSample(
      windowState(windowPatch),
      surfaceStatus({ bounds: nativeBounds({ scaleFactor: 2 }), ...surfacePatch })
    )
  )
}

function windowState(patch = {}) {
  return {
    open: true,
    visible: true,
    mode: 'floating',
    nativeOwnsPlacement: true,
    contentBounds: bounds(),
    ...patch
  }
}

function surfaceStatus(patch = {}) {
  return {
    state: 'live',
    transport: 'native-surface',
    backing: 'cametal-layer',
    bounds: nativeBounds(),
    ...patch
  }
}

function bounds(patch = {}) {
  return { x: 100, y: 128, width: 960, height: 540, ...patch }
}

function nativeBounds(patch = {}) {
  return {
    screenX: 100,
    screenY: 128,
    width: 960,
    height: 540,
    scaleFactor: 2,
    visible: true,
    ...patch
  }
}
