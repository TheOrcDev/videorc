export const PREVIEW_INTERACTION_STRESS_PROFILE = Object.freeze({
  floating: Object.freeze({
    positionUpdates: 120,
    cadenceMs: 16,
    burstUpdates: 60,
    burstCadenceMs: 4
  }),
  docked: Object.freeze({
    positionUpdates: 120,
    cadenceMs: 16,
    burstUpdates: 60,
    burstCadenceMs: 4
  }),
  sceneRounds: 10,
  sceneSequence: Object.freeze(['camera-only', 'screen-only', 'side-by-side', 'screen-camera']),
  sampleIntervalMs: 24,
  pixelOracle: Object.freeze({
    maxWidth: 320,
    maxHeight: 180,
    sampleIntervalMs: 200
  }),
  thresholds: Object.freeze({
    minPresentFps: 30,
    maxIntervalP95Ms: 120,
    maxInputToPresentP95Ms: 100,
    maxFrameStallMs: 250,
    maxSampleGapMs: 250,
    maxDroppedFrameDelta: 8,
    maxCompositorFrameLag: 8,
    maxHelperRequestDepth: 1,
    maxInProcessRequestDepth: 2,
    maxSurfaceOffsetPx: 6,
    minOracleCoverage: 0.8
  })
})

export const PREVIEW_TIMELINE_LIMITS = Object.freeze({
  samples: 2_048,
  bounds: 1_000,
  actions: 16,
  oracleSamples: 8_192,
  oracleWindows: 256
})

/** Only the already-authenticated Electron PID establishes owned window roles. */
export function previewCgWindowEvidence(sample, expectedWindowPid) {
  const windows = Array.isArray(sample?.windows) ? sample.windows : []
  const ownedPid = evidenceInteger(expectedWindowPid)
  return {
    receivedAtMs: evidenceNumber(sample?.receivedAt),
    oracleUptimeNs: evidenceInteger(sample?.uptimeNs),
    windows: windows.slice(0, PREVIEW_TIMELINE_LIMITS.oracleWindows).map((window) => {
      const owned = ownedPid !== null && ownedPid > 0 && window.pid === ownedPid
      return {
        order: evidenceInteger(window.order),
        ownerCategory: owned
          ? 'owned-app'
          : ['SecurityAgent', 'loginwindow'].includes(window.owner)
            ? 'system-ui'
            : 'other-or-unknown',
        role: !owned
          ? 'unknown'
          : window.name === 'Videorc Preview'
            ? 'preview'
            : window.name === 'Videorc'
              ? 'main'
              : ['Videorc Native Preview Surface', 'Videorc Preview Surface'].includes(window.name)
                ? 'surface'
                : 'owned-other',
        layer:
          typeof window.layer === 'number' && Number.isSafeInteger(window.layer)
            ? window.layer
            : null,
        alpha: evidenceNumber(window.alpha),
        x: evidenceCoordinate(window.x),
        y: evidenceCoordinate(window.y),
        width: evidenceNumber(window.width),
        height: evidenceNumber(window.height)
      }
    }),
    omittedWindows: Math.max(0, windows.length - PREVIEW_TIMELINE_LIMITS.oracleWindows),
    pixel: sample?.pixel
      ? Object.fromEntries(
          ['sampleCount', 'meanLuma', 'nonDarkFraction', 'blankBaseFraction'].map((key) => [
            key,
            evidenceNumber(sample.pixel[key])
          ])
        )
      : null,
    pixelErrorPresent: typeof sample?.pixelError === 'string'
  }
}

function evidenceCoordinate(value) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? value
    : null
}

const EVIDENCE_STATES = ['unavailable', 'starting', 'live', 'stopped', 'failed', 'sampler-error']
const EVIDENCE_TRANSPORTS = [
  'native-surface',
  'd3d11-shared-texture',
  'electron-proof-surface',
  'latest-jpeg-polling',
  'mjpeg-stream',
  'unavailable'
]
const EVIDENCE_BACKINGS = [
  'cametal-layer',
  'directcomposition-swapchain',
  'electron-browser-window',
  'none'
]
const EVIDENCE_HOSTS = [
  'in-process',
  'helper-process',
  'external-module',
  'proof-surface',
  'backend-d3d11-presenter'
]

/**
 * Diagnostic timelines do not replace the freshness gate. The existing latency
 * is retained-source age plus publication age at present, not action-to-present.
 * Electron monotonic times share one process clock; Node sampling and wall-clock
 * anchors remain separate. Sampling can miss presents and interaction evidence
 * never proves that a particular input caused a particular frame.
 */
export function previewInteractionPhaseEvidence({
  startedAt,
  finishedAt,
  measurement,
  samples = [],
  boundsResults = [],
  clickFocus
}) {
  const measurementStartedAtMs = evidenceNumber(measurement?.measurementStartedAtMs)
  const measurementFinishedAtMs = evidenceNumber(measurement?.measurementFinishedAtMs)
  const reducedSamples = samples.slice(-PREVIEW_TIMELINE_LIMITS.samples).map((sample) => {
    const status = sample?.status ?? {}
    const sampledAtMs = evidenceNumber(sample?.at)
    const presentation = presentationEvidence(status.nativePreviewPresentationEvidence)
    return {
      sampledAtMs,
      sampledBeforeMeasurement: before(sampledAtMs, measurementStartedAtMs),
      sampledAfterMeasurement: before(measurementFinishedAtMs, sampledAtMs),
      state: evidenceEnum(status.state, EVIDENCE_STATES),
      transport: evidenceEnum(status.transport, EVIDENCE_TRANSPORTS),
      backing: evidenceEnum(status.backing, EVIDENCE_BACKINGS),
      hostKind: evidenceEnum(status.nativePreviewHostKind, EVIDENCE_HOSTS),
      presentedFrameId: evidenceInteger(status.presentedFrameId),
      runId: evidenceId(status.nativePreviewCompositorRunId),
      sceneRevision: evidenceInteger(status.nativePreviewPresentedSceneRevision),
      statusUpdatedAtMs: evidenceDate(status.updatedAt),
      currentFreshnessLatencyMs: evidenceNumber(status.inputToPresentLatencyMs),
      mainPresentedStatusAgeMs: evidenceNumber(status.nativePreviewMainPresentedStatusAgeMs),
      mainPresentedFrameAgeP95Ms: evidenceNumber(status.nativePreviewMainPresentedFrameAgeP95Ms),
      mainQueueWaitP95Ms: evidenceNumber(status.nativePreviewMainQueueWaitP95Ms),
      mainPresentP95Ms: evidenceNumber(status.nativePreviewMainPresentP95Ms),
      presentation,
      presentedBeforeMeasurement: before(presentation?.presentedAtMs, measurementStartedAtMs),
      presentedAfterMeasurement: before(measurementFinishedAtMs, presentation?.presentedAtMs),
      presentedAfterSample: before(sampledAtMs, presentation?.presentedAtMs),
      presentationMatchesStatus: presentationIdentityMatches(presentation, status)
    }
  })
  const bounds = boundsResults.slice(0, 2).map((result) => boundsTimingEvidence(result))
  const actions = [
    ...(Array.isArray(clickFocus?.steps) ? clickFocus.steps : []),
    ...(Array.isArray(clickFocus?.restorationActions)
      ? clickFocus.restorationActions.map((action) => ({ label: action.label, action }))
      : [])
  ]
  return {
    version: 1,
    phaseStartedAtMs: evidenceNumber(startedAt),
    phaseFinishedAtMs: evidenceNumber(finishedAt),
    measurementStartedAtMs,
    measurementFinishedAtMs,
    metricMeaning: 'Retained source age plus publication age at present; not interaction latency.',
    clocks: {
      samples: 'Node wall clock',
      presentation: 'Electron wall clock and Electron monotonic clock',
      bounds: 'Electron monotonic clock with separate wall-clock start anchor',
      actions: 'Electron monotonic clock with separate wall-clock action anchor'
    },
    limitations: [
      'Sampled presents only; no causal input/frame attribution.',
      'Wall-clock changes can affect cross-process correlation.',
      'HTTP-storm mode has no per-bounds Electron application timeline.'
    ],
    limits: PREVIEW_TIMELINE_LIMITS,
    sampleCount: samples.length,
    omittedSamples: Math.max(0, samples.length - reducedSamples.length),
    samples: reducedSamples,
    bounds,
    omittedBoundsGroups: Math.max(0, boundsResults.length - bounds.length),
    actions: actions.slice(0, PREVIEW_TIMELINE_LIMITS.actions).map(actionEvidence),
    omittedActions: Math.max(0, actions.length - PREVIEW_TIMELINE_LIMITS.actions)
  }
}

function presentationEvidence(value) {
  if (!value || typeof value !== 'object') return null
  const frameId = evidenceInteger(value.frameId)
  const presentedAtMs = evidenceNumber(value.presentedAtMs)
  const start = evidenceNumber(value.presentStartedMonotonicMs)
  const end = evidenceNumber(value.presentCompletedMonotonicMs)
  if (
    frameId === null ||
    frameId === 0 ||
    presentedAtMs === null ||
    start === null ||
    end === null ||
    end < start
  ) {
    return null
  }
  return {
    frameId,
    runId: evidenceId(value.runId),
    sceneRevision: evidenceInteger(value.sceneRevision),
    frameAgeMs: evidenceNumber(value.frameAgeMs),
    compositorUpdatedAtMs: evidenceDate(value.compositorUpdatedAt),
    presentedAtMs,
    presentStartedMonotonicMs: start,
    presentCompletedMonotonicMs: end,
    inputToPresentLatencyMs: evidenceNumber(value.inputToPresentLatencyMs)
  }
}

function presentationIdentityMatches(presentation, status) {
  const frameId = evidenceInteger(status.presentedFrameId)
  const runId = evidenceId(status.nativePreviewCompositorRunId)
  const revision = evidenceInteger(status.nativePreviewPresentedSceneRevision)
  if (
    !presentation ||
    !frameId ||
    runId === null ||
    revision === null ||
    presentation.runId === null ||
    presentation.sceneRevision === null
  )
    return null
  return (
    presentation.frameId === frameId &&
    presentation.runId === runId &&
    presentation.sceneRevision === revision
  )
}

function boundsTimingEvidence(result) {
  const timing = result?.timing
  if (!timing || !Array.isArray(timing.entries)) return { available: false }
  const start = evidenceNumber(timing.monotonicStartedAtMs)
  const wall = evidenceNumber(timing.wallClockStartedAtMs)
  if (start === null || wall === null) return { available: false }
  let invalid = 0
  let previousIndex = -1
  const entries = timing.entries.slice(-PREVIEW_TIMELINE_LIMITS.bounds).flatMap((row) => {
    const index = evidenceInteger(row?.index)
    const scheduledAtMs = evidenceNumber(row?.scheduledAtMs)
    const appliedAtMs = evidenceNumber(row?.appliedAtMs)
    const completedAtMs = evidenceNumber(row?.completedAtMs)
    if (
      index === null ||
      index <= previousIndex ||
      scheduledAtMs === null ||
      appliedAtMs === null ||
      completedAtMs === null ||
      scheduledAtMs < start ||
      appliedAtMs < start ||
      completedAtMs < appliedAtMs
    ) {
      invalid += 1
      return []
    }
    previousIndex = index
    return [{ index, scheduledAtMs, appliedAtMs, completedAtMs }]
  })
  return {
    available: true,
    monotonicStartedAtMs: start,
    wallClockStartedAtMs: wall,
    applied: evidenceInteger(result.applied),
    elapsedMs: evidenceNumber(result.elapsedMs),
    maxStartLagMs: evidenceNumber(result.maxStartLagMs),
    omitted: evidenceInteger(timing.omitted),
    reducedOmissions: Math.max(0, timing.entries.length - PREVIEW_TIMELINE_LIMITS.bounds),
    invalidEntries: invalid,
    entries
  }
}

function actionEvidence(step) {
  const action = step?.action
  const start = evidenceNumber(action?.appliedAtMs)
  const end = evidenceNumber(action?.completedAtMs)
  const wall = evidenceNumber(action?.wallClockAppliedAtMs)
  return {
    label: evidenceEnum(step?.label, [
      'baseline',
      'main-window-focus',
      'preview-window-focus',
      'preview-window-click',
      'surface-window-click',
      'always-on-top-toggle',
      'preview-window-move',
      'always-on-top-restore',
      'preview-window-move-restore'
    ]),
    action:
      start !== null && end !== null && end >= start && wall !== null
        ? { appliedAtMs: start, completedAtMs: end, wallClockAppliedAtMs: wall }
        : null,
    verificationCompletedAtMs: evidenceNumber(step?.verificationCompletedAtMs),
    verificationCompletedMonotonicMs: evidenceNumber(step?.verificationCompletedMonotonicMs),
    presentation: presentationEvidence(step?.presentationEvidence)
  }
}

/** Preserve known aggregate metrics while excluding raw status/transport payloads. */
export function previewMeasurementEvidence(measurement) {
  if (!measurement) return null
  const keys = [
    'frames',
    'measuredFps',
    'intervalP95Ms',
    'intervalP99Ms',
    'compositorFrames',
    'presentedCompositorFrame',
    'compositorFrameLag',
    'skippedCompositorFrames',
    'inputToPresentLatencyMs',
    'inputToPresentLatencyP50Ms',
    'inputToPresentLatencyP95Ms',
    'inputToPresentLatencyP99Ms',
    'nativePreviewMainQueueWaitP95Ms',
    'nativePreviewMainPresentP95Ms',
    'nativePreviewMainPresentedStatusAgeMs',
    'nativePreviewMainPresentedStatusAgeP95Ms',
    'nativePreviewMainPresentedFrameAgeP95Ms',
    'nativePreviewPlacementRoundTripP95Ms',
    'nativePreviewPresentRoundTripP95Ms',
    'nativePreviewPresentedSceneRevision',
    'measurementStartedAtMs',
    'measurementFinishedAtMs',
    'width',
    'height',
    'blankFrames',
    'nativePreviewRendererPollIntervalP95Ms',
    'nativePreviewRendererPollRoundTripP95Ms',
    'nativePreviewRendererPresentRoundTripP95Ms',
    'nativePreviewRendererPollInFlightSkips',
    'nativePreviewMainQueuedBehindCount',
    'nativePreviewMainCoalescedFrameCount',
    'nativePreviewHelperRoundTripP95Ms',
    'nativePreviewMainStatusFetchP95Ms',
    'nativePreviewMainStatusFetchFailures',
    'nativePreviewMainStatusFetchSuccesses',
    'nativePreviewMainSceneMismatchCount',
    'nativePreviewMainSceneMismatchAgeMs',
    'nativePreviewMainLastSkippedSceneRevision',
    'nativePreviewMainLastSkippedFrameSceneRevision',
    'nativePreviewPlacementEventsReceived',
    'nativePreviewPlacementsCoalesced',
    'nativePreviewPlacementsApplied',
    'nativePreviewIosurfaceCacheHits',
    'nativePreviewIosurfaceImports',
    'nativePreviewIosurfaceInvalidations',
    'nativePreviewIosurfaceImportFailures',
    'nativePreviewIosurfaceImportLiveCount',
    'nativePreviewIosurfaceImportPeakCount',
    'nativePreviewIosurfaceImportCeiling'
  ]
  const projected = Object.fromEntries(keys.map((key) => [key, evidenceNumber(measurement[key])]))
  projected.presentation = presentationEvidence(measurement.nativePreviewPresentationEvidence)
  projected.identity = {
    state: evidenceEnum(measurement.status?.state, EVIDENCE_STATES),
    transport: evidenceEnum(measurement.status?.transport, EVIDENCE_TRANSPORTS),
    backing: evidenceEnum(measurement.status?.backing, EVIDENCE_BACKINGS),
    hostKind: evidenceEnum(measurement.status?.nativePreviewHostKind, EVIDENCE_HOSTS),
    hostAttached:
      typeof measurement.status?.nativePreviewHostAttached === 'boolean'
        ? measurement.status.nativePreviewHostAttached
        : null,
    sourcePixelsPresent:
      typeof measurement.status?.sourcePixelsPresent === 'boolean'
        ? measurement.status.sourcePixelsPresent
        : null
  }
  return projected
}

function evidenceNumber(value) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null
}

function evidenceInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function evidenceId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value) ? value : null
}

function evidenceDate(value) {
  return typeof value === 'string' && value.length <= 64 ? evidenceNumber(Date.parse(value)) : null
}

function evidenceEnum(value, allowed) {
  return allowed.includes(value) ? value : null
}

function before(left, right) {
  return evidenceNumber(left) !== null && evidenceNumber(right) !== null ? left < right : null
}

/** Gate checks run on original values; only this reduced transition reaches disk. */
export function previewSceneTransitionEvidence(transition, expectedKinds = []) {
  const selected = transition?.selected ?? {}
  const surface = transition?.surface ?? {}
  const scene = transition?.scene ?? {}
  const compositor = transition?.compositor ?? {}
  const nativeStatus = transition?.nativeStatus ?? {}
  const sources = Array.isArray(scene.sources) ? scene.sources : []
  const kinds = ['camera', 'screen', 'window', 'test-pattern', 'background', 'image', 'text']
  const collection = (values, project, limit = 128) => {
    const list = Array.isArray(values) ? values : []
    return { values: list.slice(0, limit).map(project), omitted: Math.max(0, list.length - limit) }
  }
  return {
    preset: evidenceLayout(transition?.preset),
    selected: {
      preset: evidenceLayout(selected.preset),
      pressed: evidenceBoolean(selected.pressed),
      disabled: evidenceBoolean(selected.disabled),
      timeline: collection(selected.timeline, intentRowEvidence, 64)
    },
    expectedKinds: collection(expectedKinds, (kind) => evidenceEnum(kind, kinds)),
    observedKinds: collection(sources.map((source) => source.kind).sort(), (kind) =>
      evidenceEnum(kind, kinds)
    ),
    sourceVisibility: collection(sources, (source) => ({
      id: evidenceId(source.id),
      kind: evidenceEnum(source.kind, kinds),
      visible: evidenceBoolean(source.visible)
    })),
    visibleSceneIds: collection(
      sources
        .filter((source) => source.visible !== false)
        .map((source) => source.id)
        .sort(),
      evidenceId
    ),
    visibleSurfaceIds: collection(surface.visibleSourceIds, evidenceId),
    surfaceLayout: evidenceLayout(surface.layoutPreset),
    compositorLayout: evidenceLayout(compositor.sceneLayout?.layoutPreset),
    surfaceRevision: evidenceInteger(surface.sceneRevision),
    sceneRevision: evidenceInteger(scene.revision),
    compositorSceneRevision: evidenceInteger(compositor.sceneRevision),
    frameSceneRevision: evidenceInteger(compositor.frameSceneRevision),
    compositorFrameId: evidenceInteger(compositor.framesRendered),
    compositorRunId: evidenceId(compositor.runId),
    native: previewInteractionPhaseEvidence({ samples: [{ status: nativeStatus }] }).samples[0],
    // Preserve every original contract failure; they are generated by named checks.
    failures: transition?.failures ?? []
  }
}

function intentRowEvidence(row) {
  return {
    at: evidenceNumber(row?.at),
    preset: evidenceLayout(row?.preset),
    phase: evidenceEnum(row?.phase, ['before', 'after', 'committed']),
    disabled: evidenceBoolean(row?.disabled),
    selected: {
      cameraId: evidenceId(row?.selected?.cameraId),
      screenId: evidenceId(row?.selected?.screenId),
      windowId: evidenceId(row?.selected?.windowId),
      cameraOff: evidenceBoolean(row?.selected?.cameraOff),
      testPattern: evidenceBoolean(row?.selected?.testPattern)
    },
    availability: Object.fromEntries(
      ['camera', 'screen', 'window'].map((role) => [
        role,
        evidenceEnum(row?.availability?.[role], ['available', 'unavailable', 'permission-required'])
      ])
    ),
    currentLayout: evidenceLayout(row?.currentLayout),
    pendingLayout: evidenceLayout(row?.pendingLayout),
    intentId: evidenceInteger(row?.intentId),
    awaitingProof: evidenceInteger(row?.awaitingProof),
    confirmedSceneRevision: evidenceInteger(row?.confirmedSceneRevision),
    backendSceneRevision: evidenceInteger(row?.backendSceneRevision),
    sourceRevision: evidenceInteger(row?.sourceRevision),
    sceneGesturePending: evidenceBoolean(row?.sceneGesturePending),
    sceneTransformPending: evidenceBoolean(row?.sceneTransformPending),
    recording: evidenceEnum(row?.recording, [
      'idle',
      'starting',
      'recording',
      'streaming',
      'stopping',
      'failed'
    ])
  }
}

function evidenceLayout(value) {
  return evidenceEnum(value, [
    'camera-only',
    'screen-only',
    'side-by-side',
    'screen-camera',
    'freeform'
  ])
}

function evidenceBoolean(value) {
  return typeof value === 'boolean' ? value : null
}

export function pixelOracleCaptureSize(
  width,
  height,
  {
    maxWidth = PREVIEW_INTERACTION_STRESS_PROFILE.pixelOracle.maxWidth,
    maxHeight = PREVIEW_INTERACTION_STRESS_PROFILE.pixelOracle.maxHeight
  } = {}
) {
  const sourceWidth = Math.max(1, finiteNumber(width) ?? 1)
  const sourceHeight = Math.max(1, finiteNumber(height) ?? 1)
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight)
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale))
  }
}

/**
 * A 30 fps recording intentionally caps the shared compositor at 30 fps. Use
 * a small sampling tolerance at that cap, while preserving the full configured
 * floor for the normal 60 fps idle preview path.
 */
export function effectivePresentFpsFloor(configuredFloor, targetFps) {
  const configured = finiteNumber(configuredFloor)
  if (configured === null) return 0
  const target = finiteNumber(targetFps)
  if (target === null || target > configured) return configured
  return Math.min(configured, target * 0.95)
}

export function analyzeNativeStatusSamples(
  samples,
  {
    maxFrameStallMs,
    maxSampleGapMs,
    maxDroppedFrameDelta,
    maxCompositorFrameLag = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds.maxCompositorFrameLag,
    maxHelperRequestDepth = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds.maxHelperRequestDepth,
    maxInProcessRequestDepth = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds
      .maxInProcessRequestDepth
  } = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds
) {
  const failures = []
  if (samples.length < 2) {
    failures.push(`native status sampler returned ${samples.length} sample(s), expected at least 2`)
    return {
      failures,
      sampleCount: samples.length,
      maxFrameStallMs: 0,
      maxSampleGapMs: 0,
      droppedFrameDelta: 0,
      maxCompositorFrameLag: 0,
      maxHelperRequestDepth: 0
    }
  }

  let previous = samples[0]
  let currentFrame = presentedFrame(previous.status)
  let currentRunId = compositorRunId(previous.status)
  let compositorRunTransitions = 0
  let frameUnchangedSince = previous.at
  let maxFrameStallObservedMs = 0
  let maxSampleGapObservedMs = 0
  let maxLagObserved = finiteNumber(previous.status.compositorFrameLag) ?? 0
  let maxDepthObserved = finiteNumber(previous.status.pendingHostCommandCount) ?? 0

  for (const [index, sample] of samples.entries()) {
    const status = sample.status ?? {}
    const prefix = `sample ${index + 1}`
    if (status.state !== 'live') {
      failures.push(`${prefix} state ${status.state ?? 'missing'}, expected live`)
    }
    if (status.transport !== 'native-surface') {
      failures.push(`${prefix} transport ${status.transport ?? 'missing'}, expected native-surface`)
    }
    if (status.backing !== 'cametal-layer') {
      failures.push(`${prefix} backing ${status.backing ?? 'missing'}, expected cametal-layer`)
    }
    if (status.sourcePixelsPresent !== true) {
      failures.push(`${prefix} did not report source pixels present`)
    }

    const depth = finiteNumber(status.pendingHostCommandCount)
    if (depth !== null) {
      maxDepthObserved = Math.max(maxDepthObserved, depth)
      const inProcess = status.nativePreviewHostKind === 'in-process'
      const maxRequestDepth = inProcess ? maxInProcessRequestDepth : maxHelperRequestDepth
      if (depth > maxRequestDepth) {
        failures.push(
          `${prefix} ${inProcess ? 'in-process' : 'helper'} request depth ${depth} exceeded ${maxRequestDepth}`
        )
      }
    }

    const lag = finiteNumber(status.compositorFrameLag)
    if (lag !== null) {
      maxLagObserved = Math.max(maxLagObserved, lag)
      if (lag > maxCompositorFrameLag) {
        failures.push(`${prefix} compositor frame lag ${lag} exceeded ${maxCompositorFrameLag}`)
      }
    }

    if (index === 0) continue

    const gapMs = sample.at - previous.at
    maxSampleGapObservedMs = Math.max(maxSampleGapObservedMs, gapMs)
    const frame = presentedFrame(status)
    const runId = compositorRunId(status)
    if (runId !== null && currentRunId !== null && runId !== currentRunId) {
      // Frame ids are local to a compositor run. Layout/drawable changes may
      // replace that run without interrupting the native surface, so a new
      // run starting at frame 1 is forward progress rather than regression.
      compositorRunTransitions += 1
      currentRunId = runId
      currentFrame = frame
      frameUnchangedSince = sample.at
    } else if (frame < currentFrame) {
      failures.push(`${prefix} presented frame moved backwards from ${currentFrame} to ${frame}`)
      currentFrame = frame
      frameUnchangedSince = sample.at
    } else if (frame > currentFrame) {
      currentFrame = frame
      frameUnchangedSince = sample.at
    } else {
      maxFrameStallObservedMs = Math.max(maxFrameStallObservedMs, sample.at - frameUnchangedSince)
    }
    previous = sample
  }

  if (maxFrameStallObservedMs > maxFrameStallMs) {
    failures.push(
      `presented-frame stall ${maxFrameStallObservedMs}ms exceeded ${maxFrameStallMs}ms`
    )
  }
  if (maxSampleGapObservedMs > maxSampleGapMs) {
    failures.push(
      `native status sampling gap ${maxSampleGapObservedMs}ms exceeded ${maxSampleGapMs}ms`
    )
  }

  const firstDropped = finiteNumber(samples[0].status?.droppedFrames) ?? 0
  const lastDropped = finiteNumber(samples.at(-1).status?.droppedFrames) ?? firstDropped
  const droppedFrameDelta = Math.max(0, lastDropped - firstDropped)
  if (droppedFrameDelta > maxDroppedFrameDelta) {
    failures.push(`dropped-frame spike ${droppedFrameDelta} exceeded ${maxDroppedFrameDelta}`)
  }

  return {
    failures: unique(failures),
    sampleCount: samples.length,
    maxFrameStallMs: maxFrameStallObservedMs,
    maxSampleGapMs: maxSampleGapObservedMs,
    droppedFrameDelta,
    maxCompositorFrameLag: maxLagObserved,
    maxHelperRequestDepth: maxDepthObserved,
    compositorRunTransitions,
    firstPresentedFrame: presentedFrame(samples[0].status),
    lastPresentedFrame: presentedFrame(samples.at(-1).status)
  }
}

function compositorRunId(status) {
  return typeof status?.nativePreviewCompositorRunId === 'string' &&
    status.nativePreviewCompositorRunId.trim()
    ? status.nativePreviewCompositorRunId
    : null
}

export function analyzeCgWindowObservations(
  observations,
  {
    helperOwner = 'native_preview_host_helper',
    expectedHostKind = 'in-process',
    expectedWindowPid,
    maxSurfaceOffsetPx = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds.maxSurfaceOffsetPx,
    requirePixelOracle = false,
    maxBlankBaseFraction = 0.9,
    minOracleCoverage = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds.minOracleCoverage
  } = {}
) {
  const failures = []
  const observedHostKinds = new Set()
  let inProcessSamples = 0
  let helperProcessSamples = 0
  let unexpectedHostKindSamples = 0
  let inProcessHelperWindowSamples = 0
  let inProcessHelperProcessSamples = 0
  let inProcessWindowCountMismatchSamples = 0
  let inProcessNonNormalLayerSamples = 0
  let helperMissingSamples = 0
  let baseMissingSamples = 0
  let zOrderGapSamples = 0
  let misalignedSamples = 0
  let maxSurfaceOffsetObservedPx = 0
  let pixelSampleCount = 0
  let darkPixelSamples = 0
  let blankBasePixelSamples = 0
  let eligibleObservationCount = 0
  let oracleObservedSamples = 0
  let oracleUnavailableSamples = 0

  for (const [index, observation] of observations.entries()) {
    const bounds = observation.expectedBounds
    const windows = observation.windows ?? []
    if (!bounds) continue
    eligibleObservationCount += 1
    if (observation.oracleObserved === false) {
      oracleUnavailableSamples += 1
      continue
    }
    oracleObservedSamples += 1
    const hostKind = observation.hostKind ?? 'missing'
    observedHostKinds.add(hostKind)
    if (hostKind !== expectedHostKind) unexpectedHostKindSamples += 1

    const helpers = windows.filter((window) => window.owner === helperOwner && window.alpha > 0)
    if (hostKind === 'in-process') {
      inProcessSamples += 1
      if (helpers.length > 0) inProcessHelperWindowSamples += 1
      const bases = findInProcessPreviewWindows(windows, expectedWindowPid)
      if (bases.length !== 1) {
        inProcessWindowCountMismatchSamples += 1
        if (bases.length === 0) baseMissingSamples += 1
      }
      const base = bases[0]
      if (base && base.layer !== 0) inProcessNonNormalLayerSamples += 1
      if (
        base &&
        helperDescendants(observation.processes ?? [], base.pid, helperOwner).length > 0
      ) {
        inProcessHelperProcessSamples += 1
      }
      if (finiteNumber(observation.pixel?.sampleCount) > 0) {
        pixelSampleCount += 1
        if ((finiteNumber(observation.pixel?.nonDarkFraction) ?? 0) < 0.01) {
          darkPixelSamples += 1
        }
        if ((finiteNumber(observation.pixel?.blankBaseFraction) ?? 0) >= maxBlankBaseFraction) {
          blankBasePixelSamples += 1
        }
      }
      // The CAMetalLayer is attached inside this one Electron NSView. There is
      // no second OS window whose placement can trail it, so OS-level offset is
      // exactly zero by construction; drawable bounds remain covered by the
      // native driver/unit gates.
      continue
    }

    if (hostKind === 'proof-surface') {
      continue
    }

    // The helper geometry/z-order oracle is transitional and runs only for an
    // explicit helper-process host (plus a missing host kind on the historical
    // pre-fix baseline, which is still rejected by expectedHostKind above).
    helperProcessSamples += 1
    const helper = helpers.sort(
      (left, right) => boundsError(left, bounds) - boundsError(right, bounds)
    )[0]
    if (!helper) {
      helperMissingSamples += 1
      continue
    }

    const surfaceOffset = boundsError(helper, bounds)
    maxSurfaceOffsetObservedPx = Math.max(maxSurfaceOffsetObservedPx, surfaceOffset)
    if (surfaceOffset > maxSurfaceOffsetPx) {
      misalignedSamples += 1
    }

    const base = findPreviewBaseWindows(windows, bounds, {
      excludedPid: helper.pid,
      requiredLayer: helper.layer
    })[0]
    if (!base) {
      baseMissingSamples += 1
      continue
    }
    if (helper.order >= base.order) {
      zOrderGapSamples += 1
      if (zOrderGapSamples <= 3) {
        failures.push(
          `CGWindow sample ${index + 1} placed helper order ${helper.order} behind preview base order ${base.order}`
        )
      }
    }
  }

  if (unexpectedHostKindSamples > 0) {
    failures.push(
      `native preview host kind was ${[...observedHostKinds].join(', ')}, expected ${expectedHostKind} in ${unexpectedHostKindSamples}/${observations.length} sample(s)`
    )
  }
  const oracleCoverage =
    eligibleObservationCount > 0 ? oracleObservedSamples / eligibleObservationCount : 0
  if (oracleCoverage < minOracleCoverage) {
    failures.push(
      `CGWindow oracle coverage ${formatPercent(oracleCoverage)} was below ${formatPercent(minOracleCoverage)} (${oracleObservedSamples}/${eligibleObservationCount} fresh sample(s))`
    )
  }
  if (inProcessHelperWindowSamples > 0) {
    failures.push(
      `in-process host exposed 1 helper CGWindow or more in ${inProcessHelperWindowSamples}/${inProcessSamples} sample(s)`
    )
  }
  if (inProcessHelperProcessSamples > 0) {
    failures.push(
      `in-process host spawned native_preview_host_helper in ${inProcessHelperProcessSamples}/${inProcessSamples} sample(s)`
    )
  }
  if (inProcessWindowCountMismatchSamples > 0) {
    failures.push(
      `in-process host did not resolve to exactly one Electron preview window in ${inProcessWindowCountMismatchSamples}/${inProcessSamples} sample(s)`
    )
  }
  // The preview's one Electron window legitimately changes CGWindow levels
  // when the always-on-top preference is exercised. Atomic ownership is the
  // invariant: exactly one Electron window and no helper window/process.
  if (requirePixelOracle && pixelSampleCount === 0) {
    failures.push('pixel oracle returned no preview-region samples in device mode')
  }
  if (requirePixelOracle && blankBasePixelSamples > 0) {
    failures.push(
      `pixel oracle observed the preview base in ${blankBasePixelSamples}/${pixelSampleCount} sample(s)`
    )
  }

  if (helperMissingSamples > 0) {
    failures.push(
      `CGWindow oracle missed the native helper in ${helperMissingSamples}/${observations.length} sample(s)`
    )
  }
  if (baseMissingSamples > 0) {
    failures.push(
      `CGWindow oracle could not identify the Electron preview base in ${baseMissingSamples}/${observations.length} sample(s)`
    )
  }
  if (misalignedSamples > 0) {
    failures.push(
      `native helper exceeded ${maxSurfaceOffsetPx}px alignment tolerance in ${misalignedSamples}/${observations.length} sample(s); max offset ${maxSurfaceOffsetObservedPx}px`
    )
  }
  if (zOrderGapSamples > 0) {
    failures.push(
      `native helper fell behind the Electron preview base in ${zOrderGapSamples}/${observations.length} sample(s)`
    )
  }

  return {
    failures: unique(failures),
    observationCount: observations.length,
    oracleObservedSamples,
    oracleUnavailableSamples,
    oracleCoverage,
    observedHostKinds: [...observedHostKinds],
    expectedHostKind,
    inProcessSamples,
    helperProcessSamples,
    unexpectedHostKindSamples,
    inProcessHelperWindowSamples,
    inProcessHelperProcessSamples,
    inProcessWindowCountMismatchSamples,
    inProcessNonNormalLayerSamples,
    pixelSampleCount,
    darkPixelSamples,
    blankBasePixelSamples,
    helperMissingSamples,
    baseMissingSamples,
    misalignedSamples,
    zOrderGapSamples,
    maxSurfaceOffsetPx: maxSurfaceOffsetObservedPx
  }
}

export function cgOraclePreviewReady(
  sample,
  {
    hostKind,
    helperOwner = 'native_preview_host_helper',
    expectedWindowPid,
    requirePixels = false,
    maxBlankBaseFraction = 0.9
  }
) {
  if (!sample) return false
  const windows = sample.windows ?? []
  const hostReady =
    hostKind === 'in-process'
      ? findInProcessPreviewWindows(windows, expectedWindowPid).length === 1
      : hostKind === 'helper-process'
        ? windows.some((window) => window.owner === helperOwner && window.alpha > 0)
        : false
  if (!hostReady) return false
  if (!requirePixels) return true
  return (
    (finiteNumber(sample.pixel?.sampleCount) ?? 0) > 0 &&
    (finiteNumber(sample.pixel?.blankBaseFraction) ?? 1) < maxBlankBaseFraction
  )
}

function findInProcessPreviewWindows(windows, expectedWindowPid) {
  const expectedPid = finiteNumber(expectedWindowPid)
  return windows.filter((window) => {
    const owner = String(window.owner ?? '').toLowerCase()
    const name = String(window.name ?? '').toLowerCase()
    return (
      window.alpha > 0 &&
      (expectedPid === null || window.pid === expectedPid) &&
      name.includes('videorc preview') &&
      (owner.includes('electron') || owner.includes('videorc'))
    )
  })
}

function findPreviewBaseWindows(
  windows,
  bounds,
  { excludedPid = null, requiredLayer = null } = {}
) {
  const expectedArea = Math.max(1, bounds.width * bounds.height)
  const candidates = windows.filter((window) => {
    if (
      window.pid === excludedPid ||
      (requiredLayer !== null && window.layer !== requiredLayer) ||
      window.alpha <= 0 ||
      !looksLikeVideorcWindow(window)
    ) {
      return false
    }
    return containsBounds(window, bounds, 90) && windowArea(window) <= expectedArea * 1.75
  })
  return candidates.sort((left, right) => windowArea(left) - windowArea(right))
}

function helperDescendants(processes, rootPid, helperOwner) {
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (descendants.has(process.ppid) && !descendants.has(process.pid)) {
        descendants.add(process.pid)
        changed = true
      }
    }
  }
  return processes.filter(
    (process) =>
      descendants.has(process.pid) &&
      String(process.command ?? '')
        .split('/')
        .at(-1) === helperOwner
  )
}

function looksLikeVideorcWindow(window) {
  const owner = String(window.owner ?? '').toLowerCase()
  const name = String(window.name ?? '').toLowerCase()
  return owner.includes('electron') || owner.includes('videorc') || name.includes('videorc')
}

function containsBounds(window, bounds, margin) {
  return (
    window.x <= bounds.x + margin &&
    window.y <= bounds.y + margin &&
    window.x + window.width >= bounds.x + bounds.width - margin &&
    window.y + window.height >= bounds.y + bounds.height - margin
  )
}

function windowArea(window) {
  return Math.max(0, window.width) * Math.max(0, window.height)
}

function boundsError(actual, expected) {
  return Math.max(
    Math.abs(actual.x - expected.x),
    Math.abs(actual.y - expected.y),
    Math.abs(actual.width - expected.width),
    Math.abs(actual.height - expected.height)
  )
}

function presentedFrame(status) {
  return finiteNumber(status?.presentedFrameId) ?? finiteNumber(status?.framesRendered) ?? -1
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatPercent(value) {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`
}

function unique(values) {
  return [...new Set(values)]
}

/** Reduced per-click ownership evidence; safe to serialize into renderer eval. */
export function layoutIntentDiagnostic(state, preset, phase, disabled, at) {
  const sources = state?.visual?.sources ?? {}
  const diagnostics = state?.diagnostics ?? {}
  const scalarId = (value) => (typeof value === 'string' ? value : null)
  const revision = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
  const availability = (value) =>
    ['available', 'unavailable', 'permission-required'].includes(value) ? value : null
  return {
    at: revision(at),
    preset: scalarId(preset),
    phase: scalarId(phase),
    disabled: typeof disabled === 'boolean' ? disabled : null,
    selected: {
      cameraId: scalarId(sources.cameraId),
      screenId: scalarId(sources.screenId),
      windowId: scalarId(sources.windowId),
      cameraOff: sources.cameraOff === true,
      testPattern: sources.testPattern === true
    },
    availability: {
      camera: availability(diagnostics.selectedDeviceAvailability?.camera),
      screen: availability(diagnostics.selectedDeviceAvailability?.screen),
      window: availability(diagnostics.selectedDeviceAvailability?.window)
    },
    currentLayout: scalarId(state?.visual?.layout?.layoutPreset),
    pendingLayout: scalarId(state?.pendingLayout),
    intentId: revision(diagnostics.layoutIntentId),
    awaitingProof: revision(diagnostics.layoutIntentAwaitingProof),
    confirmedSceneRevision: revision(diagnostics.confirmedSceneRevision),
    backendSceneRevision: revision(diagnostics.backendSceneRevision),
    sourceRevision: revision(diagnostics.sourceSelectionState?.snapshot?.sourceRevision),
    sceneGesturePending: diagnostics.sceneGesturePending === true,
    sceneTransformPending: diagnostics.sceneTransformPending === true,
    recording: scalarId(state?.recording)
  }
}
