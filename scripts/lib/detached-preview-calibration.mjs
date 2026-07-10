export const DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE = Object.freeze({
  width: 960,
  height: 540
})

// The floating preview BrowserWindow includes the 28px drag bar above its
// video content. Requesting this outer size yields an exact 960x540 surface.
export const DETACHED_PREVIEW_CALIBRATION_WINDOW_SIZE = Object.freeze({
  width: DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE.width,
  height: DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE.height + 28
})

export const DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS = Object.freeze({
  beforeWarmup: 5,
  measurementStart: 1,
  measurementEnd: 5
})

export function inspectDetachedPreviewCalibrationSample(windowState, surfaceStatus) {
  const expected = DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE
  const previewBounds = normalizeBounds(windowState?.contentBounds)
  const nativeBounds = normalizeBounds(surfaceStatus?.bounds, { preferScreenCoordinates: true })
  const nativeScaleFactor = finite(surfaceStatus?.bounds?.scaleFactor)
  const failures = []

  if (windowState?.open !== true || windowState?.visible !== true) {
    failures.push('preview window was not open and visible')
  }
  if (windowState?.mode !== 'floating') {
    failures.push(`preview window mode was ${windowState?.mode ?? 'missing'}; expected floating`)
  }
  if (windowState?.nativeOwnsPlacement !== true) {
    failures.push('native preview did not own placement')
  }
  addBoundsFailures(failures, 'preview content', previewBounds, expected)

  if (
    surfaceStatus?.state !== 'live' ||
    surfaceStatus?.transport !== 'native-surface' ||
    surfaceStatus?.backing !== 'cametal-layer'
  ) {
    failures.push(
      `native surface was ${surfaceStatus?.state ?? 'missing'}/${surfaceStatus?.transport ?? 'missing'}/${surfaceStatus?.backing ?? 'missing'}`
    )
  }
  if (surfaceStatus?.bounds?.visible !== true) {
    failures.push('native surface bounds were not visible')
  }
  if (surfaceStatus?.bounds && !(nativeScaleFactor > 0)) {
    failures.push('native surface scale factor was missing or invalid')
  }
  addBoundsFailures(failures, 'native surface', nativeBounds, expected)

  if (
    previewBounds &&
    nativeBounds &&
    (previewBounds.x !== nativeBounds.x || previewBounds.y !== nativeBounds.y)
  ) {
    failures.push(
      `native surface origin ${formatOrigin(nativeBounds)} did not match preview content ${formatOrigin(previewBounds)}`
    )
  }

  return {
    ready: failures.length === 0,
    failures,
    stabilityKey:
      failures.length === 0
        ? JSON.stringify({ previewBounds, nativeBounds, scaleFactor: nativeScaleFactor })
        : null,
    previewBounds,
    nativeBounds,
    window: {
      open: windowState?.open === true,
      visible: windowState?.visible === true,
      mode: windowState?.mode ?? null,
      nativeOwnsPlacement: windowState?.nativeOwnsPlacement === true
    },
    surface: {
      state: surfaceStatus?.state ?? null,
      transport: surfaceStatus?.transport ?? null,
      backing: surfaceStatus?.backing ?? null,
      visible: surfaceStatus?.bounds?.visible === true,
      scaleFactor: nativeScaleFactor ?? null
    }
  }
}

export function createDetachedPreviewCalibrationEvidence(phases = {}) {
  const failures = []
  let stabilityKey = null

  for (const [phaseName, requiredSamples] of Object.entries(
    DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS
  )) {
    const phase = phases[phaseName]
    const samples = Array.isArray(phase?.samples) ? phase.samples : []
    if (samples.length < requiredSamples) {
      failures.push(
        `${phaseName} captured ${samples.length}/${requiredSamples} required stable geometry samples`
      )
    }
    if (phase?.failure) {
      failures.push(`${phaseName}: ${phase.failure}`)
    }
    for (const [index, sample] of samples.entries()) {
      if (sample?.ready !== true || !sample.stabilityKey) {
        failures.push(
          `${phaseName} sample ${index + 1} was not valid detached native geometry: ${sample?.failures?.join('; ') || 'inspection missing'}`
        )
        continue
      }
      if (stabilityKey === null) {
        stabilityKey = sample.stabilityKey
      } else if (sample.stabilityKey !== stabilityKey) {
        failures.push(
          `${phaseName} sample ${index + 1} geometry drifted from ${stabilityKey} to ${sample.stabilityKey}`
        )
      }
    }
  }

  const pass = failures.length === 0
  return {
    schemaVersion: 1,
    contract: {
      mode: 'detached',
      surfaceSize: DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE,
      windowSize: DETACHED_PREVIEW_CALIBRATION_WINDOW_SIZE,
      phaseSampleCounts: DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS,
      transport: 'native-surface',
      backing: 'cametal-layer'
    },
    pass,
    stabilityKey: pass ? stabilityKey : null,
    phases,
    failures
  }
}

export function detachedPreviewCalibrationProvenance(evidence) {
  const finalSample = evidence?.phases?.measurementEnd?.samples?.at(-1)
  return {
    schemaVersion: 1,
    pass: evidence?.pass === true,
    mode: 'detached',
    surfaceSize: evidence?.contract?.surfaceSize ?? DETACHED_PREVIEW_CALIBRATION_SURFACE_SIZE,
    windowSize: evidence?.contract?.windowSize ?? DETACHED_PREVIEW_CALIBRATION_WINDOW_SIZE,
    phaseSampleCounts:
      evidence?.contract?.phaseSampleCounts ?? DETACHED_PREVIEW_CALIBRATION_PHASE_SAMPLE_COUNTS,
    transport: finalSample?.surface?.transport ?? null,
    backing: finalSample?.surface?.backing ?? null,
    scaleFactor: finalSample?.surface?.scaleFactor ?? null,
    visible: finalSample?.surface?.visible === true,
    aligned:
      finalSample?.ready === true &&
      finalSample.previewBounds?.x === finalSample.nativeBounds?.x &&
      finalSample.previewBounds?.y === finalSample.nativeBounds?.y,
    stableAcrossMeasurement: evidence?.pass === true
  }
}

function normalizeBounds(bounds, { preferScreenCoordinates = false } = {}) {
  if (!bounds || typeof bounds !== 'object') return null
  const x = preferScreenCoordinates ? finite(bounds.screenX, bounds.x) : finite(bounds.x)
  const y = preferScreenCoordinates ? finite(bounds.screenY, bounds.y) : finite(bounds.y)
  const width = finite(bounds.width)
  const height = finite(bounds.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  return { x, y, width, height }
}

function addBoundsFailures(failures, label, bounds, expected) {
  if (!bounds) {
    failures.push(`${label} bounds were missing or incomplete`)
    return
  }
  if (bounds.width !== expected.width || bounds.height !== expected.height) {
    failures.push(
      `${label} was ${bounds.width}x${bounds.height}; expected ${expected.width}x${expected.height}`
    )
  }
}

function finite(...values) {
  return values.find(Number.isFinite)
}

function formatOrigin(bounds) {
  return `${bounds.x},${bounds.y}`
}
