import { pickDevice } from './source-selection.mjs'

export const CAPTURE_DECAY_CSV_COLUMNS = Object.freeze([
  'elapsedMs',
  'uptimeSec',
  'renderFps',
  'targetFps',
  'recordingProtected',
  'encoderBridgeRequestedVideoOutput',
  'encoderBridgeEffectiveVideoOutput',
  'compositorBackend',
  'previewPresentFps',
  'previewSurfaceState',
  'previewStatusTransport',
  'previewStatusBacking',
  'previewTransport',
  'previewSurfaceBacking',
  'previewFrameAgeMs',
  'previewInputToPresentLatencyP95Ms',
  'compositorWidth',
  'compositorHeight',
  'compositorMetalTargetWidth',
  'compositorMetalTargetHeight',
  'nativePreviewDrawableWidth',
  'nativePreviewDrawableHeight',
  'nativePreviewIosurfaceInvalidations',
  'compositorMetalCachedCaptureSourceImportsLiveCount',
  'compositorMetalCachedCaptureSourceImportsPeakCount',
  'compositorMetalCachedCaptureSourceImportsCeiling',
  'compositorMetalTargetRingSlotsLiveCount',
  'compositorMetalTargetRingSlotsPeakCount',
  'compositorMetalTargetRingSlotsCeiling',
  'encoderBridgeMetalTargetRefsInFlightLiveCount',
  'encoderBridgeMetalTargetRefsInFlightPeakCount',
  'encoderBridgeMetalTargetRefsInFlightCeiling',
  'nativePreviewIosurfaceImportLiveCount',
  'nativePreviewIosurfaceImportPeakCount',
  'nativePreviewIosurfaceImportCeiling',
  'compositorSceneRevision',
  'compositorFrameSceneRevision',
  'compositorCameraSceneDeviceId',
  'compositorScreenSceneDeviceId',
  'cameraStatusState',
  'cameraStatusCameraId',
  'cameraStatusTargetFps',
  'cameraStatusSourceFps',
  'screenStatusState',
  'screenStatusSourceId',
  'screenStatusTargetFps',
  'screenStatusSourceFps',
  'cameraCaptureCallbacks',
  'cameraCaptureCallbackFps',
  'cameraDidDropCallbacks',
  'cameraDidDropPerSec',
  'cameraOutOfBuffers',
  'cameraOutOfBuffersPerSec',
  'cameraPublications',
  'cameraPublicationFps',
  'cameraFreshServes',
  'cameraFreshFps',
  'cameraHeldServes',
  'cameraHeldFps',
  'cameraFrameAgeMs',
  'cameraCaptureCallbackAgeMs',
  'cameraLatestSequence',
  'cameraSurfaceLiveCount',
  'cameraSurfacePeakCount',
  'cameraSurfaceEstimatedBytes',
  'cameraSurfacePeakEstimatedBytes',
  'cameraSurfaceOldestAgeMs',
  'screenCaptureCallbacks',
  'screenCaptureCallbackFps',
  'screenPublications',
  'screenPublicationFps',
  'screenFreshServes',
  'screenFreshFps',
  'screenHeldServes',
  'screenHeldFps',
  'screenFrameAgeMs',
  'screenCaptureCallbackAgeMs',
  'screenLatestSequence',
  'screenCompleteFrames',
  'screenSurfaceLiveCount',
  'screenSurfacePeakCount',
  'screenSurfaceEstimatedBytes',
  'screenSurfacePeakEstimatedBytes',
  'screenSurfaceOldestAgeMs',
  'degradedStage',
  'captureRecoveryRevision',
  'captureRecoveryPhase',
  'captureRecoveryStage',
  'captureRecoveryRetryable',
  'captureRecoveryAttempts',
  'captureRecoverySource',
  'captureRecoveryTrigger',
  'captureRecoverySourceGeneration',
  'captureRecoveryDetectedAt',
  'captureRecoveryUpdatedAt',
  'captureRecoveryLastDurationMs',
  'captureRecoveryLastError',
  'evidenceFailure'
])

const RATE_FIELDS = Object.freeze({
  cameraCaptureCallbackFps: 'previewCameraCaptureCallbackCount',
  cameraPublicationFps: 'previewCameraFrameStorePublications',
  cameraFreshFps: 'compositorCameraSourceFreshServes',
  cameraHeldFps: 'compositorCameraSourceHeldServes',
  screenCaptureCallbackFps: 'previewScreenCaptureCallbackCount',
  screenPublicationFps: 'previewScreenFrameStorePublications',
  screenFreshFps: 'compositorScreenSourceFreshServes',
  screenHeldFps: 'compositorScreenSourceHeldServes'
})

const REAL_SOURCE_PROGRESS_FIELDS = Object.freeze([
  ['camera capture callbacks', 'previewCameraCaptureCallbackCount'],
  ['camera frame-store publications', 'previewCameraFrameStorePublications'],
  ['screen capture callbacks', 'previewScreenCaptureCallbackCount'],
  ['screen frame-store publications', 'previewScreenFrameStorePublications']
])

const NATIVE_PREFIX = Object.freeze({
  camera: 'camera:avfoundation-native:',
  screen: 'screen:screencapturekit:',
  microphone: 'microphone:coreaudio:'
})

export const CAPTURE_DECAY_RETENTION_POINTS = Object.freeze([
  Object.freeze({
    id: 'metalCaptureSourceImports',
    label: 'Metal cached capture-source imports',
    liveField: 'compositorMetalCachedCaptureSourceImportsLiveCount',
    peakField: 'compositorMetalCachedCaptureSourceImportsPeakCount',
    ceilingField: 'compositorMetalCachedCaptureSourceImportsCeiling'
  }),
  Object.freeze({
    id: 'metalTargetRingSlots',
    label: 'Metal IOSurface target-ring slots',
    liveField: 'compositorMetalTargetRingSlotsLiveCount',
    peakField: 'compositorMetalTargetRingSlotsPeakCount',
    ceilingField: 'compositorMetalTargetRingSlotsCeiling'
  }),
  Object.freeze({
    id: 'encoderInflightTargetRefs',
    label: 'encoder in-flight Metal target refs',
    liveField: 'encoderBridgeMetalTargetRefsInFlightLiveCount',
    peakField: 'encoderBridgeMetalTargetRefsInFlightPeakCount',
    ceilingField: 'encoderBridgeMetalTargetRefsInFlightCeiling'
  }),
  Object.freeze({
    id: 'nativePreviewPresenterImports',
    label: 'native-preview presenter cached IOSurface imports',
    liveField: 'nativePreviewIosurfaceImportLiveCount',
    peakField: 'nativePreviewIosurfaceImportPeakCount',
    ceilingField: 'nativePreviewIosurfaceImportCeiling'
  })
])

export const CAPTURE_DECAY_RELEASE_ENV = Object.freeze({
  VIDEORC_SOAK_REAL_SOURCES: '0',
  VIDEORC_SOAK_CAMERA_ID: '',
  VIDEORC_SOAK_SCREEN_ID: '',
  VIDEORC_SOAK_DEBUG_APP_EXECUTABLE: '',
  VIDEORC_SCREEN_MOTION_VERIFY_VISIBLE: '0',
  VIDEORC_SYNTHETIC_HARD_CONTENT: '1',
  VIDEORC_SMOKE_PREVIEW_MOTION: '1',
  VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
  VIDEORC_DISABLE_AUTO_PREVIEW: '1',
  VIDEORC_METAL_COMPOSITOR: '1',
  VIDEORC_SOAK_REQUIRE_NATIVE_PREVIEW: '1',
  VIDEORC_SOAK_REQUIRE_PRESENTER_ADVANCEMENT: '1',
  VIDEORC_SOAK_REQUIRE_METAL_COMPOSITOR: '1',
  VIDEORC_SOAK_MIN_PREVIEW_PRESENT_FPS: '1',
  VIDEORC_SOAK_MAX_PREVIEW_FRAME_AGE_MS: '1000',
  VIDEORC_SOAK_MAX_PREVIEW_LATENCY_P95_MS: '1000',
  VIDEORC_SOAK_MINUTES: '60',
  VIDEORC_SOAK_SAMPLE_SECONDS: '2',
  VIDEORC_SMOKE_TIMEOUT_MS: '420000',
  VIDEORC_SOAK_RPC_TIMEOUT_MS: '5000',
  VIDEORC_SOAK_SOURCE_READY_TIMEOUT_MS: '90000',
  VIDEORC_SOAK_SOURCE_READY_POLL_MS: '2000',
  VIDEORC_SOAK_SOURCE_READY_CONSECUTIVE_POLLS: '3',
  VIDEORC_SOAK_SURFACE_RELEASE_TIMEOUT_MS: '10000',
  VIDEORC_SOAK_REAL_SOURCE_FAILURE_CONSECUTIVE_SAMPLES: '3',
  VIDEORC_SOAK_MAX_RECOVERY_DURATION_MS: '4000',
  VIDEORC_SOAK_MAX_RECOVERY_DETECTION_MS: '6000',
  VIDEORC_SOAK_MIN_SAMPLE_COVERAGE: '0.95',
  VIDEORC_SOAK_MAX_SAMPLE_GAP_MS: '6000',
  VIDEORC_SOAK_MAX_SURFACE_LIVE_COUNT: '12',
  VIDEORC_SOAK_MAX_SURFACE_PEAK_COUNT: '16',
  VIDEORC_SOAK_MAX_SURFACE_SLOPE_PER_MINUTE: '0.05',
  VIDEORC_SOAK_SURFACE_SLOPE_MINIMUM_MINUTES: '10',
  VIDEORC_SOAK_SURFACE_GROWTH_ALLOWANCE: '2',
  VIDEORC_SOAK_MIN_REAL_SOURCE_RATE_FRACTION: '0.6',
  VIDEORC_SOAK_MAX_REAL_SOURCE_AGE_MS: '1000',
  VIDEORC_SOAK_WIDTH: '1280',
  VIDEORC_SOAK_HEIGHT: '720',
  VIDEORC_SOAK_FPS: '30',
  VIDEORC_SOAK_BITRATE_KBPS: '4000'
})

export const LONG_RECORDING_RELEASE_ENV = Object.freeze({
  VIDEORC_SOAK_LONG_RECORDING_MINUTES: '15',
  VIDEORC_DECAY_RECORDING_MS: '900000',
  VIDEORC_DECAY_MIN_RECORDING_RATIO: '0.97',
  VIDEORC_SMOKE_TIMEOUT_MS: '1200000',
  VIDEORC_DECAY_RPC_TIMEOUT_MS: '10000',
  VIDEORC_DECAY_FINALIZATION_TIMEOUT_MS: '60000',
  VIDEORC_DECAY_STATUS_POLL_MS: '2000',
  VIDEORC_DECAY_SESSIONS: '1',
  VIDEORC_DECAY_IDLE_MS: '0',
  VIDEORC_DECAY_REAL_SCREEN: '0',
  VIDEORC_DECAY_REAL_CAMERA: '0',
  VIDEORC_DECAY_CAMERA_ID: '',
  VIDEORC_DECAY_PACKAGED_APP: '0',
  VIDEORC_SMOKE_PACKAGED_APP: '0',
  VIDEORC_PACKAGED_SMOKE_TEST: '0',
  VIDEORC_SOAK_REAL_SOURCES: '0',
  VIDEORC_CAPTURE_DECAY_LONG_RECORDING: '1',
  VIDEORC_PACKAGED_APP_EXECUTABLE: '',
  VIDEORC_SYNTHETIC_HARD_CONTENT: '1',
  VIDEORC_ENCODER_BRIDGE: '1',
  VIDEORC_RECORDING_ENCODER_BRIDGE: '1',
  VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT: 'videotoolbox-h264-mpegts',
  VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
  VIDEORC_DISABLE_AUTO_PREVIEW: '0',
  VIDEORC_METAL_COMPOSITOR: '1',
  VIDEORC_SOAK_REQUIRE_NATIVE_PREVIEW: '1',
  VIDEORC_SOAK_REQUIRE_PRESENTER_ADVANCEMENT: '1',
  VIDEORC_SOAK_REQUIRE_METAL_COMPOSITOR: '1',
  VIDEORC_SOAK_REQUIRE_RELEASE_RECORDING_PATH: '1',
  VIDEORC_SOAK_MIN_PREVIEW_PRESENT_FPS: '1',
  VIDEORC_SOAK_MAX_PREVIEW_FRAME_AGE_MS: '1000',
  VIDEORC_SOAK_MAX_PREVIEW_LATENCY_P95_MS: '1000',
  VIDEORC_DECAY_WIDTH: '1920',
  VIDEORC_DECAY_HEIGHT: '1080',
  VIDEORC_DECAY_FPS: '30',
  VIDEORC_DECAY_BITRATE_KBPS: '6000',
  VIDEORC_SOAK_MIN_SAMPLE_COVERAGE: '0.95',
  VIDEORC_SOAK_MAX_SAMPLE_GAP_MS: '6000',
  VIDEORC_SOAK_MAX_SURFACE_LIVE_COUNT: '12',
  VIDEORC_SOAK_MAX_SURFACE_PEAK_COUNT: '16',
  VIDEORC_SOAK_MAX_SURFACE_SLOPE_PER_MINUTE: '0.05',
  VIDEORC_SOAK_SURFACE_SLOPE_MINIMUM_MINUTES: '10',
  VIDEORC_SOAK_SURFACE_GROWTH_ALLOWANCE: '2'
})

export function realSourceShippingPathFailures(env = {}) {
  const failures = []
  const zeroCopyValue = env.VIDEORC_ZEROCOPY_SOURCES?.trim().toLowerCase()
  if (['0', 'false', 'off', 'no'].includes(zeroCopyValue)) {
    failures.push(
      `VIDEORC_ZEROCOPY_SOURCES=${env.VIDEORC_ZEROCOPY_SOURCES} disables the shipping capture-source IOSurface path`
    )
  }
  for (const name of ['VIDEORC_CAMERA_CAPTURE_CPU_COPY', 'VIDEORC_SCREEN_CAPTURE_CPU_COPY']) {
    const value = env[name]?.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(value)) {
      failures.push(`${name}=${env[name]} forces a non-shipping CPU-copy capture path`)
    }
  }
  return failures
}

export function captureDecaySoakConfig({ env = {}, argv = [] } = {}) {
  const gate = argv.includes('--gate')
  const recoveryGate = argv.includes('--recovery-gate')
  const forceSynthetic = argv.includes('--synthetic')
  const releaseGate = argv.includes('--release-gate')
  if (releaseGate && (!gate || !forceSynthetic || recoveryGate)) {
    throw new Error('--release-gate requires --gate --synthetic and forbids --recovery-gate.')
  }
  const resolvedEnv = releaseGate
    ? lockedReleaseEnvironment(env, CAPTURE_DECAY_RELEASE_ENV, 'capture-decay release gate')
    : env
  const realSources = !forceSynthetic && resolvedEnv.VIDEORC_SOAK_REAL_SOURCES === '1'
  const sampleSeconds = positiveNumber(
    resolvedEnv.VIDEORC_SOAK_SAMPLE_SECONDS,
    gate || realSources ? 2 : 10,
    'VIDEORC_SOAK_SAMPLE_SECONDS'
  )
  return {
    gate,
    recoveryGate,
    releaseGate,
    forceSynthetic,
    realSources,
    soakMinutes: positiveNumber(
      resolvedEnv.VIDEORC_SOAK_MINUTES,
      recoveryGate ? 1 : 60,
      'VIDEORC_SOAK_MINUTES'
    ),
    sampleSeconds,
    launchTimeoutMs: positiveNumber(
      resolvedEnv.VIDEORC_SMOKE_TIMEOUT_MS,
      gate ? 420_000 : 90_000,
      'VIDEORC_SMOKE_TIMEOUT_MS'
    ),
    rpcTimeoutMs: positiveNumber(
      resolvedEnv.VIDEORC_SOAK_RPC_TIMEOUT_MS,
      5_000,
      'VIDEORC_SOAK_RPC_TIMEOUT_MS'
    ),
    sourceReadyTimeoutMs: positiveNumber(
      resolvedEnv.VIDEORC_SOAK_SOURCE_READY_TIMEOUT_MS,
      90_000,
      'VIDEORC_SOAK_SOURCE_READY_TIMEOUT_MS'
    ),
    sourceReadyPollMs: positiveNumber(
      resolvedEnv.VIDEORC_SOAK_SOURCE_READY_POLL_MS,
      2_000,
      'VIDEORC_SOAK_SOURCE_READY_POLL_MS'
    ),
    sourceReadyConsecutivePolls: positiveInteger(
      resolvedEnv.VIDEORC_SOAK_SOURCE_READY_CONSECUTIVE_POLLS,
      3,
      'VIDEORC_SOAK_SOURCE_READY_CONSECUTIVE_POLLS'
    ),
    surfaceReleaseTimeoutMs: positiveNumber(
      resolvedEnv.VIDEORC_SOAK_SURFACE_RELEASE_TIMEOUT_MS,
      10_000,
      'VIDEORC_SOAK_SURFACE_RELEASE_TIMEOUT_MS'
    ),
    realSourceFailureConsecutiveSamples: positiveInteger(
      resolvedEnv.VIDEORC_SOAK_REAL_SOURCE_FAILURE_CONSECUTIVE_SAMPLES,
      3,
      'VIDEORC_SOAK_REAL_SOURCE_FAILURE_CONSECUTIVE_SAMPLES'
    ),
    maximumRecoveryDurationMs: positiveNumber(
      resolvedEnv.VIDEORC_SOAK_MAX_RECOVERY_DURATION_MS,
      4_000,
      'VIDEORC_SOAK_MAX_RECOVERY_DURATION_MS'
    ),
    maximumRecoveryDetectionMs: positiveNumber(
      resolvedEnv.VIDEORC_SOAK_MAX_RECOVERY_DETECTION_MS,
      6_000,
      'VIDEORC_SOAK_MAX_RECOVERY_DETECTION_MS'
    ),
    recoveryRecordingMs: positiveNumber(
      resolvedEnv.VIDEORC_SOAK_RECOVERY_RECORDING_MS,
      60_000,
      'VIDEORC_SOAK_RECOVERY_RECORDING_MS'
    ),
    evidenceGates: captureDecayEvidenceGates({ env: resolvedEnv, sampleSeconds }),
    video: captureDecayVideo(resolvedEnv, { realSources })
  }
}

export function captureDecayEvidenceGates({ env = {}, sampleSeconds = 2 } = {}) {
  return {
    requireNativePreview: env.VIDEORC_SOAK_REQUIRE_NATIVE_PREVIEW === '1',
    requirePresenterAdvancement: env.VIDEORC_SOAK_REQUIRE_PRESENTER_ADVANCEMENT === '1',
    requireMetalCompositor: env.VIDEORC_SOAK_REQUIRE_METAL_COMPOSITOR === '1',
    requireReleaseRecordingPath: env.VIDEORC_SOAK_REQUIRE_RELEASE_RECORDING_PATH === '1',
    minimumPreviewPresentFps: positiveNumber(
      env.VIDEORC_SOAK_MIN_PREVIEW_PRESENT_FPS,
      1,
      'VIDEORC_SOAK_MIN_PREVIEW_PRESENT_FPS'
    ),
    maximumPreviewFrameAgeMs: positiveNumber(
      env.VIDEORC_SOAK_MAX_PREVIEW_FRAME_AGE_MS,
      1_000,
      'VIDEORC_SOAK_MAX_PREVIEW_FRAME_AGE_MS'
    ),
    maximumPreviewLatencyP95Ms: positiveNumber(
      env.VIDEORC_SOAK_MAX_PREVIEW_LATENCY_P95_MS,
      1_000,
      'VIDEORC_SOAK_MAX_PREVIEW_LATENCY_P95_MS'
    ),
    minimumSampleCoverage: fraction(
      env.VIDEORC_SOAK_MIN_SAMPLE_COVERAGE,
      0.95,
      'VIDEORC_SOAK_MIN_SAMPLE_COVERAGE'
    ),
    maximumSampleGapMs: positiveNumber(
      env.VIDEORC_SOAK_MAX_SAMPLE_GAP_MS,
      sampleSeconds * 3_000,
      'VIDEORC_SOAK_MAX_SAMPLE_GAP_MS'
    ),
    maximumSurfaceLiveCount: positiveInteger(
      env.VIDEORC_SOAK_MAX_SURFACE_LIVE_COUNT,
      12,
      'VIDEORC_SOAK_MAX_SURFACE_LIVE_COUNT'
    ),
    maximumSurfacePeakCount: positiveInteger(
      env.VIDEORC_SOAK_MAX_SURFACE_PEAK_COUNT,
      16,
      'VIDEORC_SOAK_MAX_SURFACE_PEAK_COUNT'
    ),
    maximumSurfaceSlopePerMinute: nonNegativeNumber(
      env.VIDEORC_SOAK_MAX_SURFACE_SLOPE_PER_MINUTE,
      0.05,
      'VIDEORC_SOAK_MAX_SURFACE_SLOPE_PER_MINUTE'
    ),
    surfaceSlopeMinimumMinutes: nonNegativeNumber(
      env.VIDEORC_SOAK_SURFACE_SLOPE_MINIMUM_MINUTES,
      10,
      'VIDEORC_SOAK_SURFACE_SLOPE_MINIMUM_MINUTES'
    ),
    surfaceGrowthAllowance: nonNegativeNumber(
      env.VIDEORC_SOAK_SURFACE_GROWTH_ALLOWANCE,
      2,
      'VIDEORC_SOAK_SURFACE_GROWTH_ALLOWANCE'
    ),
    minimumRealSourceRateFraction: fraction(
      env.VIDEORC_SOAK_MIN_REAL_SOURCE_RATE_FRACTION,
      0.6,
      'VIDEORC_SOAK_MIN_REAL_SOURCE_RATE_FRACTION'
    ),
    maximumRealSourceAgeMs: positiveNumber(
      env.VIDEORC_SOAK_MAX_REAL_SOURCE_AGE_MS,
      1_000,
      'VIDEORC_SOAK_MAX_REAL_SOURCE_AGE_MS'
    )
  }
}

export function longRecordingGateConfig({ env = {}, argv = [] } = {}) {
  const endurance = argv.includes('--endurance')
  const releaseGate = argv.includes('--release-gate')
  if (releaseGate && endurance) {
    throw new Error('--release-gate and --endurance are mutually exclusive.')
  }
  const resolvedEnv = releaseGate
    ? lockedReleaseEnvironment(env, LONG_RECORDING_RELEASE_ENV, 'long-recording release gate')
    : env
  const defaultMinutes = endurance ? 60 : 15
  const minutes = positiveNumber(
    resolvedEnv.VIDEORC_SOAK_LONG_RECORDING_MINUTES,
    defaultMinutes,
    'VIDEORC_SOAK_LONG_RECORDING_MINUTES'
  )
  const recordingMs = positiveNumber(
    resolvedEnv.VIDEORC_DECAY_RECORDING_MS,
    minutes * 60_000,
    'VIDEORC_DECAY_RECORDING_MS'
  )
  return {
    endurance,
    releaseGate,
    recordingMs,
    childEnvironment: {
      ...resolvedEnv,
      VIDEORC_DECAY_SESSIONS: '1',
      VIDEORC_DECAY_RECORDING_MS: String(recordingMs),
      VIDEORC_DECAY_IDLE_MS: '0',
      VIDEORC_DECAY_REAL_SCREEN: '0',
      VIDEORC_DECAY_REAL_CAMERA: '0',
      VIDEORC_DECAY_PACKAGED_APP: '0',
      VIDEORC_SMOKE_PACKAGED_APP: '0',
      VIDEORC_PACKAGED_SMOKE_TEST: '0',
      VIDEORC_SOAK_REAL_SOURCES: '0',
      VIDEORC_CAPTURE_DECAY_LONG_RECORDING: '1',
      VIDEORC_DECAY_MIN_RECORDING_RATIO: resolvedEnv.VIDEORC_DECAY_MIN_RECORDING_RATIO ?? '0.97',
      VIDEORC_SMOKE_TIMEOUT_MS:
        resolvedEnv.VIDEORC_SMOKE_TIMEOUT_MS ?? String(recordingMs + 300_000)
    }
  }
}

export function longRecordingEvidenceFailures({
  requestedDurationMs,
  minimumRatio = 0.97,
  sessionId,
  statusSamples,
  artifactDurationSeconds,
  accountingElapsedMs,
  runtimeEvidenceFailures = []
}) {
  const failures = Array.isArray(runtimeEvidenceFailures) ? [...runtimeEvidenceFailures] : []
  if (!positiveFiniteOrNull(requestedDurationMs)) {
    return ['requested long-recording duration must be a finite positive number']
  }
  if (!finiteNumber(minimumRatio) || minimumRatio <= 0 || minimumRatio > 1) {
    return ['long-recording minimum duration ratio must be greater than 0 and at most 1']
  }
  if (!Array.isArray(statusSamples) || statusSamples.length === 0) {
    failures.push('long recording has no active-state samples')
  } else {
    for (const [index, status] of statusSamples.entries()) {
      if (status?.state !== 'recording' || status?.sessionId !== sessionId) {
        failures.push(
          `long recording active-state sample ${index + 1} expected ${sessionId}/recording, got ${status?.sessionId ?? 'missing'}/${status?.state ?? 'missing'}`
        )
        break
      }
    }
  }
  const minimumDurationMs = requestedDurationMs * minimumRatio
  const artifactDurationMs =
    positiveFiniteOrNull(artifactDurationSeconds) === null ? null : artifactDurationSeconds * 1_000
  if (artifactDurationMs === null) {
    failures.push('long recording artifact duration is unavailable')
  } else if (artifactDurationMs < minimumDurationMs) {
    failures.push(
      `long recording artifact duration ${formatMetric(artifactDurationMs)}ms is below ${formatMetric(minimumDurationMs)}ms (${formatPercent(minimumRatio)} of requested)`
    )
  }
  if (positiveFiniteOrNull(accountingElapsedMs) === null) {
    failures.push('long recording final-accounting duration is unavailable')
  } else if (accountingElapsedMs < minimumDurationMs) {
    failures.push(
      `long recording final-accounting duration ${formatMetric(accountingElapsedMs)}ms is below ${formatMetric(minimumDurationMs)}ms (${formatPercent(minimumRatio)} of requested)`
    )
  }
  return failures
}

export function evaluateLongRecordingRuntimeEvidence({
  samples,
  plannedDurationMs,
  sampleIntervalMs,
  activeSurfaceBaseline,
  recoveryObservations,
  laggedEvents = [],
  gates
}) {
  const capture = evaluateCaptureDecayEvidence({
    samples,
    plannedDurationMs,
    sampleIntervalMs,
    activeSurfaceBaseline,
    requireNativePreview: gates.requireNativePreview,
    requireSurfaceEvidence: true,
    gates
  })
  const recovery = evaluateCaptureRecoveryEvidence({ observations: recoveryObservations })
  const failures = [...capture.failures, ...recovery.failures]
  const releasePathFailureSamples = []
  if (gates.requireReleaseRecordingPath) {
    for (const [index, sample] of samples.entries()) {
      const sampleFailures = releaseRecordingPathFailures(sample)
      if (sampleFailures.length > 0) {
        releasePathFailureSamples.push({ index, failures: sampleFailures })
      }
    }
    if (releasePathFailureSamples.length > 0) {
      const first = releasePathFailureSamples[0]
      failures.push(
        `release recording path failed at sample ${first.index + 1}: ${first.failures.join('; ')}`
      )
    }
  }
  if (Array.isArray(laggedEvents) && laggedEvents.length > 0) {
    failures.push(
      `backend event stream lagged ${laggedEvents.length} time(s) during the long recording; runtime evidence is incomplete`
    )
  }
  return {
    failures,
    summary: {
      capture: capture.summary,
      recovery: recovery.summary,
      releasePathFailureSamples: releasePathFailureSamples.length,
      laggedEvents: Array.isArray(laggedEvents) ? laggedEvents.length : 0
    }
  }
}

export function selectNativeSoakSources(
  devices,
  { cameraOverride, screenOverride, microphoneOverride, requireMicrophone = false } = {}
) {
  const camera = pickDevice(devices, 'camera', {
    override: cameraOverride,
    nativePrefix: NATIVE_PREFIX.camera,
    requireNative: true
  })
  const screen = pickDevice(devices, 'screen', {
    override: screenOverride,
    nativePrefix: NATIVE_PREFIX.screen,
    requireNative: true
  })
  const microphone =
    requireMicrophone || microphoneOverride
      ? pickDevice(devices, 'microphone', {
          override: microphoneOverride,
          nativePrefix: NATIVE_PREFIX.microphone,
          requireNative: true
        })
      : null
  const failures = []
  validateNativeSource(camera, 'camera', NATIVE_PREFIX.camera, failures)
  validateNativeSource(screen, 'screen', NATIVE_PREFIX.screen, failures)
  if (requireMicrophone || microphoneOverride) {
    validateNativeSource(microphone, 'microphone', NATIVE_PREFIX.microphone, failures)
  }
  if (failures.length > 0) {
    throw new Error(`Real-source soak requires available native sources: ${failures.join('; ')}`)
  }
  return { camera, screen, microphone }
}

export function createCaptureDecaySample({
  stats,
  surfaceStatus,
  cameraStatus,
  screenStatus,
  compositorStatus,
  recoveryStatus,
  previousStats,
  nowMs,
  previousAtMs,
  startedAtMs
}) {
  const windowSeconds =
    previousStats && finiteNumber(previousAtMs) && nowMs > previousAtMs
      ? (nowMs - previousAtMs) / 1000
      : null
  const rate = (field) => counterRate(stats[field], previousStats?.[field], windowSeconds)
  const cameraSurface = stats.previewCameraSurfaceBacking ?? {}
  const cameraDropReasons = stats.previewCameraDropReasons ?? {}
  const previousCameraDropReasons = previousStats?.previewCameraDropReasons ?? {}
  const screenSurface = stats.previewScreenSurfaceBacking ?? {}
  const sceneSources = Array.isArray(compositorStatus?.sceneSources)
    ? compositorStatus.sceneSources
    : []
  const cameraSceneSource = sceneSources.find((source) => source?.kind === 'camera')
  const screenSceneSource = sceneSources.find(
    (source) => source?.kind === 'screen' || source?.kind === 'window'
  )
  const recoveryPhase =
    typeof recoveryStatus?.phase === 'string'
      ? recoveryStatus.phase
      : typeof stats.captureRecoveryPhase === 'string'
        ? stats.captureRecoveryPhase
        : 'idle'

  return {
    elapsedMs: Math.max(0, nowMs - startedAtMs),
    uptimeSec: Math.max(0, Math.round((nowMs - startedAtMs) / 1000)),
    renderFps: numberOrNull(stats.renderFps),
    // `targetFps` belongs to an active record/stream session. The decay soak
    // intentionally remains idle, so its compositor target is published as
    // `previewTargetFps` instead. Keep one effective target in the evidence
    // row while preserving the backend's distinction between the two owners.
    targetFps: effectiveCompositorTargetFps(stats),
    recordingProtected: stats.recordingProtected === true,
    encoderBridgeRequestedVideoOutput:
      typeof stats.encoderBridgeRequestedVideoOutput === 'string'
        ? stats.encoderBridgeRequestedVideoOutput
        : null,
    encoderBridgeEffectiveVideoOutput:
      typeof stats.encoderBridgeEffectiveVideoOutput === 'string'
        ? stats.encoderBridgeEffectiveVideoOutput
        : null,
    compositorBackend: typeof stats.compositorBackend === 'string' ? stats.compositorBackend : null,
    previewPresentFps: numberOrNull(stats.previewPresentFps),
    previewSurfaceState: typeof surfaceStatus?.state === 'string' ? surfaceStatus.state : null,
    previewStatusTransport:
      typeof surfaceStatus?.transport === 'string' ? surfaceStatus.transport : null,
    previewStatusBacking: typeof surfaceStatus?.backing === 'string' ? surfaceStatus.backing : null,
    previewTransport: typeof stats.previewTransport === 'string' ? stats.previewTransport : null,
    previewSurfaceBacking:
      typeof stats.previewSurfaceBacking === 'string' ? stats.previewSurfaceBacking : null,
    previewFrameAgeMs: numberOrNull(stats.previewFrameAgeMs),
    previewInputToPresentLatencyP95Ms: numberOrNull(stats.previewInputToPresentLatencyP95Ms),
    compositorWidth: numberOrNull(compositorStatus?.width),
    compositorHeight: numberOrNull(compositorStatus?.height),
    compositorMetalTargetWidth: numberOrNull(compositorStatus?.metalTargetWidth),
    compositorMetalTargetHeight: numberOrNull(compositorStatus?.metalTargetHeight),
    nativePreviewDrawableWidth: numberOrNull(surfaceStatus?.nativePreviewDrawableWidth),
    nativePreviewDrawableHeight: numberOrNull(surfaceStatus?.nativePreviewDrawableHeight),
    nativePreviewIosurfaceInvalidations: numberOrNull(
      surfaceStatus?.nativePreviewIosurfaceInvalidations
    ),
    compositorMetalCachedCaptureSourceImportsLiveCount: numberOrNull(
      stats.compositorMetalCachedCaptureSourceImportsLiveCount
    ),
    compositorMetalCachedCaptureSourceImportsPeakCount: numberOrNull(
      stats.compositorMetalCachedCaptureSourceImportsPeakCount
    ),
    compositorMetalCachedCaptureSourceImportsCeiling: numberOrNull(
      stats.compositorMetalCachedCaptureSourceImportsCeiling
    ),
    compositorMetalTargetRingSlotsLiveCount: numberOrNull(
      stats.compositorMetalTargetRingSlotsLiveCount
    ),
    compositorMetalTargetRingSlotsPeakCount: numberOrNull(
      stats.compositorMetalTargetRingSlotsPeakCount
    ),
    compositorMetalTargetRingSlotsCeiling: numberOrNull(
      stats.compositorMetalTargetRingSlotsCeiling
    ),
    encoderBridgeMetalTargetRefsInFlightLiveCount: numberOrNull(
      stats.encoderBridgeMetalTargetRefsInFlightLiveCount
    ),
    encoderBridgeMetalTargetRefsInFlightPeakCount: numberOrNull(
      stats.encoderBridgeMetalTargetRefsInFlightPeakCount
    ),
    encoderBridgeMetalTargetRefsInFlightCeiling: numberOrNull(
      stats.encoderBridgeMetalTargetRefsInFlightCeiling
    ),
    nativePreviewIosurfaceImportLiveCount: numberOrNull(
      surfaceStatus?.nativePreviewIosurfaceImportLiveCount
    ),
    nativePreviewIosurfaceImportPeakCount: numberOrNull(
      surfaceStatus?.nativePreviewIosurfaceImportPeakCount
    ),
    nativePreviewIosurfaceImportCeiling: numberOrNull(
      surfaceStatus?.nativePreviewIosurfaceImportCeiling
    ),
    compositorSceneRevision: numberOrNull(compositorStatus?.sceneRevision),
    compositorFrameSceneRevision: numberOrNull(compositorStatus?.frameSceneRevision),
    compositorCameraSceneDeviceId:
      typeof cameraSceneSource?.deviceId === 'string' ? cameraSceneSource.deviceId : null,
    compositorScreenSceneDeviceId:
      typeof screenSceneSource?.deviceId === 'string' ? screenSceneSource.deviceId : null,
    cameraStatusState: typeof cameraStatus?.state === 'string' ? cameraStatus.state : null,
    cameraStatusCameraId: typeof cameraStatus?.cameraId === 'string' ? cameraStatus.cameraId : null,
    cameraStatusTargetFps: numberOrNull(cameraStatus?.targetFps),
    cameraStatusSourceFps: numberOrNull(cameraStatus?.sourceFps),
    screenStatusState: typeof screenStatus?.state === 'string' ? screenStatus.state : null,
    screenStatusSourceId: typeof screenStatus?.sourceId === 'string' ? screenStatus.sourceId : null,
    screenStatusTargetFps: numberOrNull(screenStatus?.targetFps),
    screenStatusSourceFps: numberOrNull(screenStatus?.sourceFps),
    cameraCaptureCallbacks: numberOrNull(stats.previewCameraCaptureCallbackCount),
    cameraCaptureCallbackFps: rate(RATE_FIELDS.cameraCaptureCallbackFps),
    cameraDidDropCallbacks: numberOrNull(stats.previewCameraDidDropCallbackCount),
    cameraDidDropPerSec: counterRate(
      stats.previewCameraDidDropCallbackCount,
      previousStats?.previewCameraDidDropCallbackCount,
      windowSeconds
    ),
    cameraOutOfBuffers: numberOrNull(cameraDropReasons.outOfBuffers),
    cameraOutOfBuffersPerSec: counterRate(
      cameraDropReasons.outOfBuffers,
      previousCameraDropReasons.outOfBuffers,
      windowSeconds
    ),
    cameraPublications: numberOrNull(stats.previewCameraFrameStorePublications),
    cameraPublicationFps: rate(RATE_FIELDS.cameraPublicationFps),
    cameraFreshServes: numberOrNull(stats.compositorCameraSourceFreshServes),
    cameraFreshFps: rate(RATE_FIELDS.cameraFreshFps),
    cameraHeldServes: numberOrNull(stats.compositorCameraSourceHeldServes),
    cameraHeldFps: rate(RATE_FIELDS.cameraHeldFps),
    cameraFrameAgeMs: numberOrNull(stats.previewCameraFrameAgeMs),
    cameraCaptureCallbackAgeMs: numberOrNull(stats.previewCameraCaptureCallbackAgeMs),
    cameraLatestSequence: numberOrNull(stats.previewCameraLatestSequence),
    cameraSurfaceLiveCount: numberOrNull(cameraSurface.liveCount),
    cameraSurfacePeakCount: numberOrNull(cameraSurface.peakCount),
    cameraSurfaceEstimatedBytes: numberOrNull(cameraSurface.estimatedBytes),
    cameraSurfacePeakEstimatedBytes: numberOrNull(cameraSurface.peakEstimatedBytes),
    cameraSurfaceOldestAgeMs: numberOrNull(cameraSurface.oldestAgeMs),
    screenCaptureCallbacks: numberOrNull(stats.previewScreenCaptureCallbackCount),
    screenCaptureCallbackFps: rate(RATE_FIELDS.screenCaptureCallbackFps),
    screenPublications: numberOrNull(stats.previewScreenFrameStorePublications),
    screenPublicationFps: rate(RATE_FIELDS.screenPublicationFps),
    screenFreshServes: numberOrNull(stats.compositorScreenSourceFreshServes),
    screenFreshFps: rate(RATE_FIELDS.screenFreshFps),
    screenHeldServes: numberOrNull(stats.compositorScreenSourceHeldServes),
    screenHeldFps: rate(RATE_FIELDS.screenHeldFps),
    screenFrameAgeMs: numberOrNull(stats.previewScreenFrameAgeMs),
    screenCaptureCallbackAgeMs: numberOrNull(stats.previewScreenCaptureCallbackAgeMs),
    screenLatestSequence: numberOrNull(stats.previewScreenLatestSequence),
    screenCompleteFrames: numberOrNull(stats.previewScreenFrameStatuses?.complete),
    screenSurfaceLiveCount: numberOrNull(screenSurface.liveCount),
    screenSurfacePeakCount: numberOrNull(screenSurface.peakCount),
    screenSurfaceEstimatedBytes: numberOrNull(screenSurface.estimatedBytes),
    screenSurfacePeakEstimatedBytes: numberOrNull(screenSurface.peakEstimatedBytes),
    screenSurfaceOldestAgeMs: numberOrNull(screenSurface.oldestAgeMs),
    degradedStage:
      typeof stats.capturePipelineDegradedStage === 'string'
        ? stats.capturePipelineDegradedStage
        : null,
    captureRecoveryRevision: numberOrNull(recoveryStatus?.revision),
    captureRecoveryPhase: recoveryPhase,
    captureRecoveryStage: typeof recoveryStatus?.stage === 'string' ? recoveryStatus.stage : null,
    captureRecoveryRetryable: recoveryStatus?.retryable === true,
    captureRecoveryAttempts: numberOrNull(
      recoveryStatus?.attempts ??
        stats.captureRecoveryAttempts ??
        (recoveryPhase === 'idle' ? 0 : null)
    ),
    captureRecoverySource:
      typeof recoveryStatus?.source === 'string' ? recoveryStatus.source : null,
    captureRecoveryTrigger:
      typeof recoveryStatus?.trigger === 'string' ? recoveryStatus.trigger : null,
    captureRecoverySourceGeneration: numberOrNull(recoveryStatus?.sourceGeneration),
    captureRecoveryDetectedAt:
      typeof recoveryStatus?.detectedAt === 'string' ? recoveryStatus.detectedAt : null,
    captureRecoveryUpdatedAt:
      typeof recoveryStatus?.updatedAt === 'string' ? recoveryStatus.updatedAt : null,
    captureRecoveryLastDurationMs: numberOrNull(
      recoveryStatus?.lastDurationMs ?? stats.captureRecoveryLastDurationMs
    ),
    captureRecoveryLastError:
      typeof (recoveryStatus?.lastError ?? stats.captureRecoveryLastError) === 'string'
        ? (recoveryStatus?.lastError ?? stats.captureRecoveryLastError)
        : null,
    evidenceFailure: null
  }
}

export function captureDecayCsvHeader() {
  return CAPTURE_DECAY_CSV_COLUMNS.join(',')
}

export function captureDecayCsvRow(sample) {
  return CAPTURE_DECAY_CSV_COLUMNS.map((column) => csvValue(sample[column])).join(',')
}

export function renderCadenceFailures(stats, { minimumFraction = 0.6 } = {}) {
  const targetFps = effectiveCompositorTargetFps(stats)
  const renderFps = numberOrNull(stats?.renderFps)
  if (targetFps === null || targetFps <= 0) {
    return ['compositor target FPS is unavailable or non-positive']
  }
  if (renderFps === null) return ['compositor render FPS is unavailable']
  const floor = targetFps * minimumFraction
  return renderFps < floor
    ? [`compositor render cadence ${renderFps.toFixed(1)}fps is below ${floor.toFixed(1)}fps`]
    : []
}

export function effectiveCompositorTargetFps(stats) {
  return numberOrNull(stats?.targetFps) ?? numberOrNull(stats?.previewTargetFps)
}

export function nativePreviewFailures({
  stats,
  surfaceStatus,
  requireNative = false,
  requirePresenterAdvancement = false,
  minimumPresentFps = 1,
  maximumFrameAgeMs = 1_000,
  maximumLatencyP95Ms = 1_000
}) {
  const failures = []
  const diagnosticsClaimsNative =
    stats?.previewTransport === 'native-surface' || stats?.previewSurfaceBacking === 'cametal-layer'
  const statusClaimsNative =
    surfaceStatus?.transport === 'native-surface' || surfaceStatus?.backing === 'cametal-layer'
  const native = requireNative || diagnosticsClaimsNative || statusClaimsNative

  if (!native) return failures

  if (surfaceStatus?.state !== 'live') {
    failures.push(
      `preview surface state is ${surfaceStatus?.state ?? 'unavailable'}, expected live`
    )
  }
  if (surfaceStatus?.transport !== 'native-surface') {
    failures.push(
      `preview surface transport is ${surfaceStatus?.transport ?? 'unavailable'}, expected native-surface`
    )
  }
  if (surfaceStatus?.backing !== 'cametal-layer') {
    failures.push(
      `preview surface backing is ${surfaceStatus?.backing ?? 'unavailable'}, expected cametal-layer`
    )
  }
  if (stats?.previewTransport !== 'native-surface') {
    failures.push(
      `diagnostics preview transport is ${stats?.previewTransport ?? 'unavailable'}, expected native-surface`
    )
  }
  if (stats?.previewSurfaceBacking !== 'cametal-layer') {
    failures.push(
      `diagnostics preview backing is ${stats?.previewSurfaceBacking ?? 'unavailable'}, expected cametal-layer`
    )
  }
  if (!nonNegativeFiniteNumber(stats?.previewFrameAgeMs)) {
    failures.push('native preview frame age is not a finite non-negative number')
  }
  if (!nonNegativeFiniteNumber(stats?.previewInputToPresentLatencyP95Ms)) {
    failures.push('native preview input-to-present p95 is not a finite non-negative number')
  }
  if (requirePresenterAdvancement) {
    if (!finiteNumber(stats?.previewPresentFps) || stats.previewPresentFps < minimumPresentFps) {
      failures.push(
        `native preview presenter cadence is ${formatMetric(stats?.previewPresentFps)}fps, expected at least ${formatMetric(minimumPresentFps)}fps`
      )
    }
    if (
      !nonNegativeFiniteNumber(stats?.previewFrameAgeMs) ||
      stats.previewFrameAgeMs > maximumFrameAgeMs
    ) {
      failures.push(
        `native preview frame age is ${formatMetric(stats?.previewFrameAgeMs)}ms, expected at most ${formatMetric(maximumFrameAgeMs)}ms`
      )
    }
    if (
      !nonNegativeFiniteNumber(stats?.previewInputToPresentLatencyP95Ms) ||
      stats.previewInputToPresentLatencyP95Ms > maximumLatencyP95Ms
    ) {
      failures.push(
        `native preview input-to-present p95 is ${formatMetric(stats?.previewInputToPresentLatencyP95Ms)}ms, expected at most ${formatMetric(maximumLatencyP95Ms)}ms`
      )
    }
  }
  return failures
}

export function releaseRecordingPathFailures(sample) {
  const failures = []
  if (sample?.recordingProtected !== true) {
    failures.push('recordingProtected was not true')
  }
  if (sample?.encoderBridgeRequestedVideoOutput !== 'videotoolbox-h264-mpegts') {
    failures.push(
      `requested encoder bridge output was ${sample?.encoderBridgeRequestedVideoOutput ?? 'unavailable'}, expected videotoolbox-h264-mpegts`
    )
  }
  if (sample?.encoderBridgeEffectiveVideoOutput !== 'videotoolbox-h264-mpegts') {
    failures.push(
      `effective encoder bridge output was ${sample?.encoderBridgeEffectiveVideoOutput ?? 'unavailable'}, expected videotoolbox-h264-mpegts`
    )
  }
  if (sample?.compositorBackend !== 'metal') {
    failures.push(
      `compositor backend was ${sample?.compositorBackend ?? 'unavailable'}, expected metal`
    )
  }
  return failures
}

export function sourceSurfaceSnapshot(stats) {
  return {
    camera: surfaceSnapshot(stats?.previewCameraSurfaceBacking),
    screen: surfaceSnapshot(stats?.previewScreenSurfaceBacking)
  }
}

export function surfaceReturnFailures(stats, baseline, { allowance = 0 } = {}) {
  const failures = []
  const current = sourceSurfaceSnapshot(stats)
  for (const source of ['camera', 'screen']) {
    const currentLive = current[source].liveCount
    const baselineLive = baseline?.[source]?.liveCount
    if (!nonNegativeFiniteNumber(currentLive) || !nonNegativeFiniteNumber(baselineLive)) {
      failures.push(`${source} surface live-count return evidence is unavailable`)
      continue
    }
    if (currentLive > baselineLive + allowance) {
      failures.push(
        `${source} surface live count ${currentLive} did not return to baseline ${baselineLive} + ${allowance}`
      )
    }
  }
  return failures
}

export function evaluateCaptureDecayEvidence({
  samples,
  plannedDurationMs,
  sampleIntervalMs,
  activeSurfaceBaseline,
  requireNativePreview = false,
  requirePositiveSourceSurfaces = false,
  requireSurfaceEvidence = true,
  gates
}) {
  const failures = []
  const nativePreviewRequired = requireNativePreview || gates.requireNativePreview === true
  const presenterAdvancementRequired = gates.requirePresenterAdvancement === true
  const expectedSampleCount = Math.max(1, Math.ceil(plannedDurationMs / sampleIntervalMs))
  const requiredSampleCount = Math.max(
    1,
    Math.ceil(expectedSampleCount * gates.minimumSampleCoverage)
  )
  const sampleCoverage = samples.length / expectedSampleCount
  if (samples.length < requiredSampleCount) {
    failures.push(
      `sample coverage ${samples.length}/${expectedSampleCount} (${formatPercent(sampleCoverage)}) is below ${formatPercent(gates.minimumSampleCoverage)}`
    )
  }

  const gaps = sampleGaps(samples, plannedDurationMs)
  const maximumObservedSampleGapMs = gaps.length > 0 ? Math.max(...gaps) : plannedDurationMs
  if (maximumObservedSampleGapMs > gates.maximumSampleGapMs) {
    failures.push(
      `maximum sample gap ${formatMetric(maximumObservedSampleGapMs)}ms exceeds ${formatMetric(gates.maximumSampleGapMs)}ms`
    )
  }

  const degradedStageFailureSamples = []
  for (const [index, sample] of samples.entries()) {
    if (typeof sample?.degradedStage === 'string' && sample.degradedStage.length > 0) {
      degradedStageFailureSamples.push({ index, stage: sample.degradedStage })
    }
  }
  if (degradedStageFailureSamples.length > 0) {
    const first = degradedStageFailureSamples[0]
    failures.push(
      `capture health declared degraded stage ${first.stage} at sample ${first.index + 1}`
    )
  }

  const nativeFailureSamples = []
  let finiteNativeLatencySamples = 0
  for (const [index, sample] of samples.entries()) {
    const sampleFailures = nativePreviewFailures({
      stats: sample,
      surfaceStatus: {
        state: sample.previewSurfaceState,
        transport: sample.previewStatusTransport,
        backing: sample.previewStatusBacking
      },
      requireNative: nativePreviewRequired,
      requirePresenterAdvancement: presenterAdvancementRequired,
      minimumPresentFps: gates.minimumPreviewPresentFps,
      maximumFrameAgeMs: gates.maximumPreviewFrameAgeMs,
      maximumLatencyP95Ms: gates.maximumPreviewLatencyP95Ms
    })
    if (sampleFailures.length === 0 && sample.previewTransport === 'native-surface') {
      finiteNativeLatencySamples += 1
    }
    if (sampleFailures.length > 0) {
      nativeFailureSamples.push({ index, failures: sampleFailures })
    }
  }
  if (nativeFailureSamples.length > 0) {
    const first = nativeFailureSamples[0]
    failures.push(
      `${nativePreviewRequired ? 'native preview identity/latency/presenter' : 'preview claimed native transport without complete identity/latency evidence'} failed at sample ${first.index + 1}: ${first.failures.join('; ')}`
    )
  }

  const metalCompositorFailureSamples = []
  if (gates.requireMetalCompositor) {
    for (const [index, sample] of samples.entries()) {
      if (sample?.compositorBackend !== 'metal') {
        metalCompositorFailureSamples.push({
          index,
          backend: sample?.compositorBackend ?? 'unavailable'
        })
      }
    }
    if (metalCompositorFailureSamples.length > 0) {
      const first = metalCompositorFailureSamples[0]
      failures.push(
        `Metal compositor requirement failed at sample ${first.index + 1}: compositor backend was ${first.backend}, expected metal`
      )
    }
  }

  const sourceSurfaceFailureSamples = []
  if (requirePositiveSourceSurfaces) {
    for (const [index, sample] of samples.entries()) {
      const sampleFailures = realSourceSurfaceBackingFailures(sample)
      if (sampleFailures.length > 0) {
        sourceSurfaceFailureSamples.push({ index, failures: sampleFailures })
      }
    }
    if (sourceSurfaceFailureSamples.length > 0) {
      const first = sourceSurfaceFailureSamples[0]
      failures.push(
        `real-source shipping IOSurface evidence failed at sample ${first.index + 1}: ${first.failures.join('; ')}`
      )
    }
  }

  const surfaceSummary = {}
  for (const source of ['camera', 'screen']) {
    const summary = summarizeSurfaceSamples(samples, source, gates.surfaceSlopeMinimumMinutes)
    surfaceSummary[source] = summary
    if (!requireSurfaceEvidence) continue

    const requiredSurfaceSamples = requiredSampleCount
    if (summary.evidenceSamples < requiredSurfaceSamples) {
      failures.push(
        `${source} surface evidence coverage ${summary.evidenceSamples}/${expectedSampleCount} scheduled samples is below ${formatPercent(gates.minimumSampleCoverage)}`
      )
      continue
    }
    if (summary.maximumLiveCount > gates.maximumSurfaceLiveCount) {
      failures.push(
        `${source} surface live-count ceiling ${summary.maximumLiveCount} exceeds ${gates.maximumSurfaceLiveCount}`
      )
    }
    if (summary.maximumPeakCount > gates.maximumSurfacePeakCount) {
      failures.push(
        `${source} surface peak-count ceiling ${summary.maximumPeakCount} exceeds ${gates.maximumSurfacePeakCount}`
      )
    }
    if (
      summary.slopeEvaluated &&
      summary.liveCountSlopePerMinute > gates.maximumSurfaceSlopePerMinute
    ) {
      failures.push(
        `${source} surface live-count slope ${formatMetric(summary.liveCountSlopePerMinute)}/min exceeds ${formatMetric(gates.maximumSurfaceSlopePerMinute)}/min`
      )
    }
    const activeLive = activeSurfaceBaseline?.[source]?.liveCount
    if (!nonNegativeFiniteNumber(activeLive)) {
      failures.push(`${source} active surface baseline is unavailable`)
    } else if (
      nonNegativeFiniteNumber(summary.finalLiveCount) &&
      summary.finalLiveCount > activeLive + gates.surfaceGrowthAllowance
    ) {
      failures.push(
        `${source} final live count ${summary.finalLiveCount} exceeds active baseline ${activeLive} + ${gates.surfaceGrowthAllowance}`
      )
    }
  }

  const retentionPointList = CAPTURE_DECAY_RETENTION_POINTS.map((point) =>
    summarizeRetentionPoint(samples, point, gates.surfaceSlopeMinimumMinutes)
  )
  const positiveRetentionPoints = new Set(['metalTargetRingSlots'])
  if (nativePreviewRequired) positiveRetentionPoints.add('nativePreviewPresenterImports')
  if (requirePositiveSourceSurfaces) positiveRetentionPoints.add('metalCaptureSourceImports')
  if (samples.some((sample) => sample?.recordingProtected === true)) {
    positiveRetentionPoints.add('encoderInflightTargetRefs')
  }
  for (const point of retentionPointList) {
    if (point.evidenceSamples < requiredSampleCount) {
      failures.push(
        `${point.label} retention evidence coverage ${point.evidenceSamples}/${expectedSampleCount} scheduled samples is below ${formatPercent(gates.minimumSampleCoverage)}`
      )
      continue
    }
    if (!point.withinCeiling) {
      failures.push(
        `${point.label} retention exceeded its reported ceiling (live ${formatMetric(point.maximumLiveCount)}, peak ${formatMetric(point.peakCount)}, ceiling ${formatMetric(point.ceiling)})`
      )
    }
    if (point.slopeEvaluated && point.slopePerMinute > gates.maximumSurfaceSlopePerMinute) {
      failures.push(
        `${point.label} live-count slope ${formatMetric(point.slopePerMinute)}/min exceeds ${formatMetric(gates.maximumSurfaceSlopePerMinute)}/min`
      )
    }
    if (point.finalLiveCount > point.initialLiveCount + gates.surfaceGrowthAllowance) {
      failures.push(
        `${point.label} final live count ${point.finalLiveCount} exceeds initial ${point.initialLiveCount} + ${gates.surfaceGrowthAllowance}`
      )
    }
    if (positiveRetentionPoints.has(point.id) && point.peakCount <= 0) {
      failures.push(`${point.label} retention never became positive on the exercised path`)
    }
  }
  const retentionPoints = Object.fromEntries(retentionPointList.map((point) => [point.id, point]))

  return {
    failures,
    summary: {
      expectedSampleCount,
      requiredSampleCount,
      samplesCollected: samples.length,
      sampleCoverage,
      maximumObservedSampleGapMs,
      degradedStageFailureSamples: degradedStageFailureSamples.length,
      finiteNativeLatencySamples,
      nativeFailureSamples: nativeFailureSamples.length,
      metalCompositorFailureSamples: metalCompositorFailureSamples.length,
      sourceSurfaceFailureSamples: sourceSurfaceFailureSamples.length,
      surfaces: surfaceSummary,
      retentionPoints,
      retentionPointList,
      reconfigurationTimeline: retentionReconfigurationTimeline(samples)
    }
  }
}

export function retentionReconfigurationTimeline(samples) {
  const timeline = []
  let previousSignature = null
  for (const [index, sample] of samples.entries()) {
    const sizing = {
      compositorWidth: numberOrNull(sample?.compositorWidth),
      compositorHeight: numberOrNull(sample?.compositorHeight),
      compositorMetalTargetWidth: numberOrNull(sample?.compositorMetalTargetWidth),
      compositorMetalTargetHeight: numberOrNull(sample?.compositorMetalTargetHeight),
      nativePreviewDrawableWidth: numberOrNull(sample?.nativePreviewDrawableWidth),
      nativePreviewDrawableHeight: numberOrNull(sample?.nativePreviewDrawableHeight),
      nativePreviewIosurfaceInvalidations: numberOrNull(sample?.nativePreviewIosurfaceInvalidations)
    }
    const signature = JSON.stringify(Object.values(sizing))
    if (signature === previousSignature) continue
    previousSignature = signature
    timeline.push({
      index,
      elapsedMs: numberOrNull(sample?.elapsedMs),
      ...sizing,
      retentionPoints: Object.fromEntries(
        CAPTURE_DECAY_RETENTION_POINTS.map((point) => [
          point.id,
          {
            liveCount: numberOrNull(sample?.[point.liveField]),
            peakCount: numberOrNull(sample?.[point.peakField]),
            ceiling: numberOrNull(sample?.[point.ceilingField])
          }
        ])
      )
    })
  }
  return timeline
}

export function nativeRetentionSnapshot(stats, surfaceStatus) {
  return Object.fromEntries(
    CAPTURE_DECAY_RETENTION_POINTS.map((point) => [
      point.id,
      {
        liveCount: numberOrNull(
          point.id === 'nativePreviewPresenterImports'
            ? surfaceStatus?.[point.liveField]
            : stats?.[point.liveField]
        ),
        peakCount: numberOrNull(
          point.id === 'nativePreviewPresenterImports'
            ? surfaceStatus?.[point.peakField]
            : stats?.[point.peakField]
        ),
        ceiling: numberOrNull(
          point.id === 'nativePreviewPresenterImports'
            ? surfaceStatus?.[point.ceilingField]
            : stats?.[point.ceilingField]
        )
      }
    ])
  )
}

export function retentionTeardownFailures(stats, surfaceStatus) {
  const failures = []
  const snapshot = nativeRetentionSnapshot(stats, surfaceStatus)
  for (const point of CAPTURE_DECAY_RETENTION_POINTS) {
    const retained = snapshot[point.id]
    if (!nonNegativeFiniteNumber(retained?.liveCount)) {
      failures.push(`${point.label} teardown live-count evidence is unavailable`)
    } else if (retained.liveCount !== 0) {
      failures.push(`${point.label} retained ${retained.liveCount} object(s) after teardown`)
    }
    if (
      !nonNegativeFiniteNumber(retained?.peakCount) ||
      !nonNegativeFiniteNumber(retained?.ceiling)
    ) {
      failures.push(`${point.label} teardown peak/ceiling evidence is unavailable`)
    } else if (retained.peakCount > retained.ceiling) {
      failures.push(
        `${point.label} teardown peak ${retained.peakCount} exceeds ceiling ${retained.ceiling}`
      )
    }
  }
  return failures
}

export function realSourceProgressFailures({
  before,
  after,
  cameraStatus,
  screenStatus,
  compositorStatus,
  sceneRevision,
  sources
}) {
  const failures = []
  if (cameraStatus?.state !== 'live' || cameraStatus?.cameraId !== sources.camera.id) {
    failures.push(
      `camera status is not live on ${sources.camera.id} (${cameraStatus?.state ?? 'missing'} / ${cameraStatus?.cameraId ?? 'no id'})`
    )
  }
  if (screenStatus?.state !== 'live' || screenStatus?.sourceId !== sources.screen.id) {
    failures.push(
      `screen status is not live on ${sources.screen.id} (${screenStatus?.state ?? 'missing'} / ${screenStatus?.sourceId ?? 'no id'})`
    )
  }
  for (const [label, field] of REAL_SOURCE_PROGRESS_FIELDS) {
    if (!counterAdvanced(before?.[field], after?.[field])) {
      failures.push(
        `${label} did not advance (${formatCounter(before?.[field])} -> ${formatCounter(after?.[field])})`
      )
    }
  }
  for (const [label, backing] of [
    ['camera', after?.previewCameraSurfaceBacking],
    ['screen', after?.previewScreenSurfaceBacking]
  ]) {
    if (
      !nonNegativeFiniteNumber(backing?.liveCount) ||
      !nonNegativeFiniteNumber(backing?.peakCount)
    ) {
      failures.push(`${label} surface-backing counters are unavailable`)
    } else if (backing.liveCount <= 0 || backing.peakCount <= 0) {
      failures.push(
        `${label} surface-backing counters do not prove the shipping IOSurface path (live ${backing.liveCount}, peak ${backing.peakCount})`
      )
    }
  }
  if (sceneRevision !== undefined || compositorStatus !== undefined) {
    failures.push(...sceneAdoptionFailures({ compositorStatus, sceneRevision, sources }))
  }
  return failures
}

export function sceneCommitFailures({ sceneCommitted, sources, video }) {
  const failures = []
  if (sceneCommitted?.applied !== true) {
    failures.push('scene.load_from_capture_config did not confirm applied=true')
  }
  if (sceneCommitted?.mode !== 'idle') {
    failures.push(
      `scene.load_from_capture_config returned mode ${sceneCommitted?.mode ?? 'missing'}, expected idle`
    )
  }
  const sceneRevision = sceneCommitted?.sceneRevision
  if (!Number.isSafeInteger(sceneRevision) || sceneRevision <= 0) {
    failures.push(
      `scene.load_from_capture_config returned invalid scene revision ${formatCounter(sceneRevision)}`
    )
  }
  const sceneSources = Array.isArray(sceneCommitted?.scene?.sources)
    ? sceneCommitted.scene.sources
    : []
  const expectedSources = [
    ['screen', sources?.screen?.id],
    ['camera', sources?.camera?.id]
  ]
  if (sceneSources.length !== expectedSources.length) {
    failures.push(
      `committed scene contained ${sceneSources.length} source(s), expected exactly ${expectedSources.length}`
    )
  }
  for (const [kind, expectedId] of expectedSources) {
    const matching = sceneSources.filter(
      (source) =>
        source?.kind === kind && source?.deviceId === expectedId && source?.visible === true
    )
    if (matching.length !== 1) {
      failures.push(
        `committed scene expected exactly one visible ${kind} ${expectedId ?? 'missing'}, found ${matching.length}`
      )
    }
  }
  const unexpectedSources = sceneSources.filter(
    (source) =>
      !expectedSources.some(
        ([kind, expectedId]) => source?.kind === kind && source?.deviceId === expectedId
      )
  )
  if (unexpectedSources.length > 0) {
    failures.push(
      `committed scene contained unexpected sources ${unexpectedSources
        .map((source) => `${source?.kind ?? 'unknown'}:${source?.deviceId ?? 'missing'}`)
        .join(', ')}`
    )
  }
  if (video) {
    const recordingOutputs = Array.isArray(sceneCommitted?.scene?.outputs)
      ? sceneCommitted.scene.outputs.filter((output) => output?.kind === 'recording')
      : []
    const recordingOutput = recordingOutputs[0]
    if (
      recordingOutputs.length !== 1 ||
      recordingOutput?.width !== video.width ||
      recordingOutput?.height !== video.height ||
      recordingOutput?.fps !== video.fps
    ) {
      failures.push(
        `committed scene recording output was ${recordingOutput?.width ?? 'missing'}x${recordingOutput?.height ?? 'missing'}@${recordingOutput?.fps ?? 'missing'}, expected ${video.width}x${video.height}@${video.fps}`
      )
    }
  }
  if (Number.isSafeInteger(sceneRevision) && sceneRevision > 0) {
    failures.push(
      ...sceneAdoptionFailures({
        compositorStatus: sceneCommitted?.compositorStatus,
        sceneRevision,
        sources
      }).map((failure) => `scene commit response: ${failure}`)
    )
  }
  return failures
}

export function sceneAdoptionFailures({ compositorStatus, sceneRevision, sources }) {
  const failures = []
  if (compositorStatus?.state !== 'live') {
    failures.push(`compositor state is ${compositorStatus?.state ?? 'unavailable'}, expected live`)
  }
  if (compositorStatus?.sceneRevision !== sceneRevision) {
    failures.push(
      `compositor scene revision is ${formatCounter(compositorStatus?.sceneRevision)}, expected ${formatCounter(sceneRevision)}`
    )
  }
  if (compositorStatus?.frameSceneRevision !== sceneRevision) {
    failures.push(
      `rendered frame scene revision is ${formatCounter(compositorStatus?.frameSceneRevision)}, expected ${formatCounter(sceneRevision)}`
    )
  }
  const sceneSources = Array.isArray(compositorStatus?.sceneSources)
    ? compositorStatus.sceneSources
    : []
  for (const kind of ['screen', 'camera']) {
    const expectedId = sources?.[kind]?.id
    const adopted = sceneSources.filter(
      (source) =>
        source?.kind === kind && source?.visible === true && source?.deviceId === expectedId
    )
    if (adopted.length !== 1) {
      const reported = sceneSources
        .filter((source) => source?.kind === kind)
        .map((source) => `${source.deviceId ?? 'no id'}/${source.visible ? 'visible' : 'hidden'}`)
        .join(', ')
      failures.push(
        `compositor expected exactly one visible ${kind} ${expectedId ?? 'missing'} (${reported || 'no matching scene source'})`
      )
    }
  }
  const unexpectedVisibleSources = sceneSources.filter(
    (source) =>
      source?.visible === true &&
      !['screen', 'camera'].some(
        (kind) => source?.kind === kind && source?.deviceId === sources?.[kind]?.id
      )
  )
  if (unexpectedVisibleSources.length > 0) {
    failures.push(
      `compositor adopted unexpected visible sources ${unexpectedVisibleSources
        .map((source) => `${source?.kind ?? 'unknown'}:${source?.deviceId ?? 'missing'}`)
        .join(', ')}`
    )
  }
  return failures
}

export function realSourceCadenceBaseline({
  readinessPolls = [],
  cameraStatus,
  screenStatus,
  compositorTargetFps
}) {
  const readyTail = trailingReadyPolls(readinessPolls).slice(-3)
  const cameraSourceFpsSamples = readyTail
    .map((poll) => poll?.cameraStatus?.sourceFps)
    .filter((value) => positiveFiniteOrNull(value) !== null)
  const screenSourceFpsSamples = readyTail
    .map((poll) => poll?.screenStatus?.sourceFps)
    .filter((value) => positiveFiniteOrNull(value) !== null)
  const stableCameraSourceFps =
    cameraSourceFpsSamples.length === 3 ? median(cameraSourceFpsSamples) : null
  const stableScreenSourceFps =
    screenSourceFpsSamples.length === 3 ? median(screenSourceFpsSamples) : null
  const cameraProducerFps =
    stableCameraSourceFps ??
    positiveFiniteOrNull(cameraStatus?.sourceFps) ??
    positiveFiniteOrNull(cameraStatus?.targetFps)
  const screenProducerFps =
    stableScreenSourceFps ??
    positiveFiniteOrNull(screenStatus?.sourceFps) ??
    positiveFiniteOrNull(screenStatus?.targetFps)
  const compositorFps = positiveFiniteOrNull(compositorTargetFps)
  const missing = []
  if (cameraProducerFps === null) missing.push('camera source/target FPS')
  if (screenProducerFps === null) missing.push('screen source/target FPS')
  if (compositorFps === null) missing.push('compositor target FPS')
  if (missing.length > 0) {
    throw new Error(`real-source cadence baseline is incomplete: ${missing.join(', ')}`)
  }
  return {
    cameraProducerFps,
    screenProducerFps,
    cameraConsumerFps: Math.min(cameraProducerFps, compositorFps),
    screenConsumerFps: Math.min(screenProducerFps, compositorFps),
    compositorFps,
    cameraSourceFpsSamples,
    screenSourceFpsSamples,
    cameraBaselineSource:
      stableCameraSourceFps !== null
        ? 'readiness-source-fps-median'
        : positiveFiniteOrNull(cameraStatus?.sourceFps) !== null
          ? 'status-source-fps'
          : 'status-target-fps-fallback',
    screenBaselineSource:
      stableScreenSourceFps !== null
        ? 'readiness-source-fps-median'
        : positiveFiniteOrNull(screenStatus?.sourceFps) !== null
          ? 'status-source-fps'
          : 'status-target-fps-fallback'
  }
}

export function realSourceSurfaceBackingFailures(sample) {
  const failures = []
  for (const [label, liveField, bytesField] of [
    ['camera', 'cameraSurfaceLiveCount', 'cameraSurfaceEstimatedBytes'],
    ['screen', 'screenSurfaceLiveCount', 'screenSurfaceEstimatedBytes']
  ]) {
    const liveCount = sample?.[liveField]
    const estimatedBytes = sample?.[bytesField]
    if (
      !nonNegativeFiniteNumber(liveCount) ||
      liveCount <= 0 ||
      !nonNegativeFiniteNumber(estimatedBytes) ||
      estimatedBytes <= 0
    ) {
      failures.push(
        `${label} sample does not retain positive shipping IOSurface evidence (live ${formatMetric(liveCount)}, bytes ${formatMetric(estimatedBytes)})`
      )
    }
  }
  return failures
}

export function realSourceSampleFailures({
  sample,
  previousSample,
  sources,
  sceneRevision,
  targetFps,
  sourceCadence,
  minimumRateFraction = 0.6,
  maximumAgeMs = 1_000
}) {
  const failures = []
  if (sample?.cameraStatusState !== 'live' || sample?.cameraStatusCameraId !== sources.camera.id) {
    failures.push(
      `camera status is not live on ${sources.camera.id} (${sample?.cameraStatusState ?? 'missing'} / ${sample?.cameraStatusCameraId ?? 'no id'})`
    )
  }
  if (sample?.screenStatusState !== 'live' || sample?.screenStatusSourceId !== sources.screen.id) {
    failures.push(
      `screen status is not live on ${sources.screen.id} (${sample?.screenStatusState ?? 'missing'} / ${sample?.screenStatusSourceId ?? 'no id'})`
    )
  }
  if (sample?.compositorSceneRevision !== sceneRevision) {
    failures.push(
      `compositor scene revision is ${formatCounter(sample?.compositorSceneRevision)}, expected ${formatCounter(sceneRevision)}`
    )
  }
  if (sample?.compositorFrameSceneRevision !== sceneRevision) {
    failures.push(
      `rendered frame scene revision is ${formatCounter(sample?.compositorFrameSceneRevision)}, expected ${formatCounter(sceneRevision)}`
    )
  }
  if (sample?.compositorCameraSceneDeviceId !== sources.camera.id) {
    failures.push(
      `compositor camera scene source is ${sample?.compositorCameraSceneDeviceId ?? 'missing'}, expected ${sources.camera.id}`
    )
  }
  if (sample?.compositorScreenSceneDeviceId !== sources.screen.id) {
    failures.push(
      `compositor screen scene source is ${sample?.compositorScreenSceneDeviceId ?? 'missing'}, expected ${sources.screen.id}`
    )
  }

  const fallbackRate = positiveFiniteOrNull(targetFps)
  const rateExpectations = {
    cameraCaptureCallbackFps:
      positiveFiniteOrNull(sourceCadence?.cameraProducerFps) ?? fallbackRate,
    cameraPublicationFps: positiveFiniteOrNull(sourceCadence?.cameraProducerFps) ?? fallbackRate,
    cameraFreshFps: positiveFiniteOrNull(sourceCadence?.cameraConsumerFps) ?? fallbackRate,
    screenCaptureCallbackFps:
      positiveFiniteOrNull(sourceCadence?.screenProducerFps) ?? fallbackRate,
    screenPublicationFps: positiveFiniteOrNull(sourceCadence?.screenProducerFps) ?? fallbackRate,
    screenFreshFps: positiveFiniteOrNull(sourceCadence?.screenConsumerFps) ?? fallbackRate
  }
  if (Object.values(rateExpectations).some((expectedRate) => expectedRate === null)) {
    failures.push('real-source target FPS is unavailable or non-positive')
  } else {
    for (const [label, field] of [
      ['camera capture callback', 'cameraCaptureCallbackFps'],
      ['camera publication', 'cameraPublicationFps'],
      ['camera compositor-fresh serve', 'cameraFreshFps'],
      ['screen capture callback', 'screenCaptureCallbackFps'],
      ['screen publication', 'screenPublicationFps'],
      ['screen compositor-fresh serve', 'screenFreshFps']
    ]) {
      const rate = sample?.[field]
      const expectedRate = rateExpectations[field]
      const floor = expectedRate * minimumRateFraction
      if (!nonNegativeFiniteNumber(rate) || rate < floor) {
        failures.push(
          `${label} cadence ${formatRate(rate)} is below ${floor.toFixed(1)}fps (${formatPercent(minimumRateFraction)} of ${expectedRate}fps)`
        )
      }
    }
  }

  if (previousSample) {
    for (const [label, field] of [
      ['camera', 'cameraLatestSequence'],
      ['screen', 'screenLatestSequence']
    ]) {
      if (!counterAdvanced(previousSample[field], sample?.[field])) {
        failures.push(
          `${label} latest sequence did not advance (${formatCounter(previousSample[field])} -> ${formatCounter(sample?.[field])})`
        )
      }
    }
  }

  for (const [label, field] of [
    ['camera frame', 'cameraFrameAgeMs'],
    ['camera callback', 'cameraCaptureCallbackAgeMs'],
    ['screen frame', 'screenFrameAgeMs'],
    ['screen callback', 'screenCaptureCallbackAgeMs']
  ]) {
    const ageMs = sample?.[field]
    if (!nonNegativeFiniteNumber(ageMs) || ageMs > maximumAgeMs) {
      failures.push(`${label} age ${formatMetric(ageMs)}ms exceeds ${formatMetric(maximumAgeMs)}ms`)
    }
  }
  failures.push(...realSourceSurfaceBackingFailures(sample))
  if (sample?.degradedStage) {
    failures.push(`capture health declared degraded stage ${sample.degradedStage}`)
  }
  return failures
}

export function captureRecoveryArmFailures(acknowledgement) {
  const failures = []
  if (acknowledgement?.armed !== true) {
    failures.push('capture recovery injection did not acknowledge armed=true')
  }
  if (!Number.isSafeInteger(acknowledgement?.faultId) || acknowledgement.faultId <= 0) {
    failures.push('capture recovery injection faultId is not a positive safe integer')
  }
  if (
    !Number.isSafeInteger(acknowledgement?.sourceGeneration) ||
    acknowledgement.sourceGeneration <= 0
  ) {
    failures.push('capture recovery injection sourceGeneration is not a positive safe integer')
  }
  if (typeof acknowledgement?.message !== 'string' || acknowledgement.message.trim().length === 0) {
    failures.push('capture recovery injection acknowledgement message is missing')
  }
  return failures
}

export function captureRecoveryObservation(status, observedAtMs = Date.now(), origin = 'rpc') {
  return {
    observedAtMs,
    observedAt: new Date(observedAtMs).toISOString(),
    origin,
    revision: numberOrNull(status?.revision),
    phase: typeof status?.phase === 'string' ? status.phase : 'unavailable',
    retryable: status?.retryable === true,
    attempts: numberOrNull(status?.attempts),
    stage: typeof status?.stage === 'string' ? status.stage : null,
    source: typeof status?.source === 'string' ? status.source : null,
    trigger: typeof status?.trigger === 'string' ? status.trigger : null,
    sourceGeneration: numberOrNull(status?.sourceGeneration),
    detectedAt: typeof status?.detectedAt === 'string' ? status.detectedAt : null,
    updatedAt: typeof status?.updatedAt === 'string' ? status.updatedAt : null,
    message: typeof status?.message === 'string' ? status.message : null,
    lastError: typeof status?.lastError === 'string' ? status.lastError : null,
    lastDurationMs: numberOrNull(status?.lastDurationMs)
  }
}

export function evaluateCaptureRecoveryEvidence({
  observations,
  maximumRecoveryDurationMs = 4_000,
  expectedRecovery = false,
  expectedRecoveryStage = 'camera-delivery',
  expectedRecoverySource = 'camera',
  faultArmedAtMs = null,
  faultInjectedAtMs = null,
  armedSourceGeneration = null,
  maximumDetectionMs = 6_000
}) {
  const rawEvidence = Array.isArray(observations) ? observations : []
  const failures = []
  const armAcknowledgedAtMs = nonNegativeFiniteNumber(faultArmedAtMs)
    ? faultArmedAtMs
    : faultInjectedAtMs
  const canonical = canonicalRecoveryObservations(rawEvidence)
  failures.push(...canonical.failures)
  const evidence = canonical.observations
  const unexpected = evidence.filter(
    (observation) => observation?.phase !== 'idle' || (observation?.attempts ?? 0) > 0
  )
  const durationEvidence = evidence
    .map((observation) => observation?.lastDurationMs)
    .filter(nonNegativeFiniteNumber)
  const maximumReportedRecoveryDurationMs =
    durationEvidence.length > 0 ? Math.max(...durationEvidence) : null
  if (
    maximumReportedRecoveryDurationMs !== null &&
    maximumReportedRecoveryDurationMs > maximumRecoveryDurationMs
  ) {
    failures.push(
      `capture recovery duration ${formatMetric(maximumReportedRecoveryDurationMs)}ms exceeds ${formatMetric(maximumRecoveryDurationMs)}ms`
    )
  }

  const attemptsHighWater =
    evidence.length > 0 ? Math.max(...evidence.map((item) => item?.attempts ?? 0)) : 0
  const firstDetectedIndex = evidence.findIndex((observation) =>
    ['degraded', 'restarting'].includes(observation?.phase)
  )
  const firstVerifyingIndex = evidence.findIndex(
    (observation) => observation?.phase === 'verifying'
  )
  const firstRecoveredIndex = evidence.findIndex(
    (observation) => observation?.phase === 'recovered'
  )
  const firstDetected = firstDetectedIndex >= 0 ? evidence[firstDetectedIndex] : null
  const firstRecovered = firstRecoveredIndex >= 0 ? evidence[firstRecoveredIndex] : null
  const preRestartObservations = evidence
    .slice(0, firstVerifyingIndex >= 0 ? firstVerifyingIndex : evidence.length)
    .filter((observation) => ['degraded', 'restarting'].includes(observation?.phase))
  const verifyingObservations = evidence.filter((observation) => observation?.phase === 'verifying')
  const recoveredObservations = evidence.filter((observation) => observation?.phase === 'recovered')
  const preRestartGenerations = preRestartObservations
    .map((observation) => observation?.sourceGeneration)
    .filter(positiveSafeInteger)
  const verifyingGenerations = verifyingObservations
    .map((observation) => observation?.sourceGeneration)
    .filter(positiveSafeInteger)
  const recoveredGenerations = recoveredObservations
    .map((observation) => observation?.sourceGeneration)
    .filter(positiveSafeInteger)
  const preRestartGeneration =
    preRestartGenerations.length > 0
      ? preRestartGenerations[preRestartGenerations.length - 1]
      : null
  const observedDetectionMs =
    nonNegativeFiniteNumber(armAcknowledgedAtMs) &&
    nonNegativeFiniteNumber(firstDetected?.observedAtMs)
      ? firstDetected.observedAtMs - armAcknowledgedAtMs
      : null
  const observedRecoveryMs =
    nonNegativeFiniteNumber(firstDetected?.observedAtMs) &&
    nonNegativeFiniteNumber(firstRecovered?.observedAtMs)
      ? firstRecovered.observedAtMs - firstDetected.observedAtMs
      : null

  if (!expectedRecovery && unexpected.length > 0) {
    failures.push(
      `unexpected capture recovery observed (${[...new Set(unexpected.map((item) => item.phase))].join(' -> ')}, attempts high-water ${attemptsHighWater})`
    )
  }
  if (expectedRecovery) {
    if (!nonNegativeFiniteNumber(armAcknowledgedAtMs)) {
      failures.push('expected recovery requires a finite successful arm-ack timestamp')
    } else if (observedDetectionMs === null) {
      failures.push(
        'capture recovery did not report a degraded/recovery phase after the successful arm acknowledgement'
      )
    } else if (observedDetectionMs < 0) {
      failures.push('capture recovery was observed before the successful arm acknowledgement')
    } else if (observedDetectionMs > maximumDetectionMs) {
      failures.push(
        `capture recovery detection took ${formatMetric(observedDetectionMs)}ms, exceeding ${formatMetric(maximumDetectionMs)}ms`
      )
    }
    const firstActiveIndex = evidence.findIndex((observation) => observation?.phase !== 'idle')
    let lastActiveIndex = -1
    for (let index = evidence.length - 1; index >= 0; index -= 1) {
      if (evidence[index]?.phase !== 'idle') {
        lastActiveIndex = index
        break
      }
    }
    const recoveryPhases =
      firstActiveIndex >= 0
        ? evidence
            .slice(firstActiveIndex, lastActiveIndex + 1)
            .map((observation) => observation?.phase ?? 'unavailable')
        : []
    const orderedFlow =
      firstDetectedIndex >= 0 &&
      firstVerifyingIndex > firstDetectedIndex &&
      firstRecoveredIndex > firstVerifyingIndex &&
      recoveryPhases.every((phase, index) => {
        const rank = expectedRecoveryPhaseRank(phase)
        const previousRank = index > 0 ? expectedRecoveryPhaseRank(recoveryPhases[index - 1]) : 0
        return rank !== null && (index === 0 || rank >= previousRank)
      })
    if (!orderedFlow) {
      failures.push(
        `capture recovery did not expose one ordered degraded/restarting -> verifying -> recovered flow (observed ${recoveryPhases.join(' -> ') || 'none'})`
      )
    }
    if (firstVerifyingIndex < 0) {
      failures.push('capture recovery did not expose its verifying phase')
    }
    if (evidence.some((observation) => observation?.phase === 'failed')) {
      failures.push('capture recovery entered the failed phase')
    }
    if (evidence.some((observation) => observation?.trigger === 'manual')) {
      failures.push('capture recovery used a manual trigger instead of automatic recovery')
    }
    const wrongScope = evidence.find(
      (observation) =>
        ['degraded', 'restarting', 'verifying', 'recovered'].includes(observation?.phase) &&
        (observation?.stage !== expectedRecoveryStage ||
          observation?.source !== expectedRecoverySource)
    )
    if (wrongScope) {
      failures.push(
        `capture recovery used ${wrongScope.stage ?? 'unavailable'}/${wrongScope.source ?? 'unavailable'} instead of ${expectedRecoveryStage}/${expectedRecoverySource}`
      )
    }
    const nonAutomatic = evidence.find(
      (observation) =>
        ['restarting', 'verifying', 'recovered'].includes(observation?.phase) &&
        observation?.trigger !== 'automatic'
    )
    if (nonAutomatic) {
      failures.push(
        `capture recovery ${nonAutomatic.phase} phase did not retain the automatic trigger`
      )
    }
    if (attemptsHighWater !== 1) {
      failures.push(
        `capture recovery attempts high-water was ${attemptsHighWater}; expected exactly 1 automatic attempt`
      )
    }

    const postRestartGenerations = [...verifyingGenerations, ...recoveredGenerations]
    if (preRestartObservations.length === 0) {
      failures.push('capture recovery has no degraded/restarting old-generation evidence')
    } else if (preRestartGenerations.length !== preRestartObservations.length) {
      failures.push('capture recovery old-generation evidence is incomplete')
    } else if (new Set(preRestartGenerations).size !== 1) {
      failures.push(
        `capture recovery source generation changed before verifying (${[...new Set(preRestartGenerations)].join(', ')})`
      )
    }
    if (!positiveSafeInteger(armedSourceGeneration)) {
      failures.push(
        'expected recovery requires the source generation returned by the arm acknowledgement'
      )
    } else if (preRestartGeneration !== null && preRestartGeneration !== armedSourceGeneration) {
      failures.push(
        `capture recovery old generation ${preRestartGeneration} did not match armed generation ${armedSourceGeneration}`
      )
    }
    if (verifyingObservations.length === 0) {
      failures.push('capture recovery has no verifying-generation evidence')
    } else if (verifyingGenerations.length !== verifyingObservations.length) {
      failures.push('capture recovery verifying-generation evidence is incomplete')
    } else if (new Set(verifyingGenerations).size !== 1) {
      failures.push(
        `capture recovery verifying source generations were inconsistent (${[...new Set(verifyingGenerations)].join(', ')})`
      )
    }
    if (recoveredObservations.length === 0) {
      failures.push('capture recovery has no recovered-generation evidence')
    } else if (recoveredGenerations.length !== recoveredObservations.length) {
      failures.push('capture recovery recovered-generation evidence is incomplete')
    } else if (new Set(recoveredGenerations).size !== 1) {
      failures.push(
        `capture recovery recovered source generations were inconsistent (${[...new Set(recoveredGenerations)].join(', ')})`
      )
    }
    if (
      preRestartGeneration !== null &&
      postRestartGenerations.some((generation) => generation <= preRestartGeneration)
    ) {
      failures.push(
        `capture recovery source generation did not advance beyond ${preRestartGeneration} in verifying/recovered evidence`
      )
    }
    if (postRestartGenerations.length > 1 && new Set(postRestartGenerations).size > 1) {
      failures.push(
        `capture recovery verifying/recovered source generations were inconsistent (${[...new Set(postRestartGenerations)].join(', ')})`
      )
    }

    if (!firstRecovered) {
      failures.push('capture recovery did not reach recovered')
    } else if (observedRecoveryMs > maximumRecoveryDurationMs) {
      failures.push(
        `observed capture recovery took ${formatMetric(observedRecoveryMs)}ms, exceeding ${formatMetric(maximumRecoveryDurationMs)}ms`
      )
    }
  }

  return {
    failures,
    summary: {
      observations: evidence.length,
      rawObservations: rawEvidence.length,
      phases: [...new Set(evidence.map((observation) => observation?.phase ?? 'unavailable'))],
      attemptsHighWater,
      firstUnexpectedAt: unexpected[0]?.observedAt ?? null,
      maximumReportedRecoveryDurationMs,
      faultArmedAtMs: armAcknowledgedAtMs,
      armedSourceGeneration,
      observedDetectionMs,
      observedRecoveryMs,
      preRestartGeneration,
      verifyingGenerations: [...new Set(verifyingGenerations)],
      recoveredGenerations: [...new Set(recoveredGenerations)]
    }
  }
}

export function captureRecoveryCadenceSample(
  previousEvidence,
  currentEvidence,
  { source, expectedGeneration, previousObservedAtMs, observedAtMs }
) {
  const failures = []
  const label = `${source} recovery cadence window`
  for (const [position, evidence] of [
    ['start', previousEvidence],
    ['end', currentEvidence]
  ]) {
    if (evidence?.source !== source) {
      failures.push(`${label} ${position} observed ${evidence?.source ?? 'no source'}`)
    }
    if (evidence?.sourceGeneration !== expectedGeneration) {
      failures.push(
        `${label} ${position} observed generation ${evidence?.sourceGeneration ?? 'none'} instead of recovered generation ${expectedGeneration}`
      )
    }
    for (const [field, description] of [
      ['producerTargetFps', 'producer target FPS'],
      ['compositorTargetFps', 'compositor target FPS']
    ]) {
      if (!positiveSafeInteger(evidence?.[field])) {
        failures.push(`${label} ${position} has no positive ${description}`)
      }
    }
  }
  if (
    previousEvidence?.sourceGeneration !== currentEvidence?.sourceGeneration &&
    positiveSafeInteger(previousEvidence?.sourceGeneration) &&
    positiveSafeInteger(currentEvidence?.sourceGeneration)
  ) {
    failures.push(`${label} was superseded by a different generation while sampled`)
  }
  if (
    typeof previousEvidence?.compositorRunId !== 'string' ||
    previousEvidence.compositorRunId.length === 0 ||
    currentEvidence?.compositorRunId !== previousEvidence.compositorRunId
  ) {
    failures.push(`${label} crossed compositor counter epochs while sampled`)
  }
  for (const [field, description] of [
    ['producerTargetFps', 'producer target FPS'],
    ['compositorTargetFps', 'compositor target FPS']
  ]) {
    if (currentEvidence?.[field] !== previousEvidence?.[field]) {
      failures.push(`${label} changed ${description} while sampled`)
    }
  }
  const windowSeconds = (observedAtMs - previousObservedAtMs) / 1_000
  const counterRate = (field, description) => {
    const previous = previousEvidence?.[field]
    const current = currentEvidence?.[field]
    if (
      !nonNegativeFiniteNumber(previous) ||
      !nonNegativeFiniteNumber(current) ||
      current < previous ||
      !finiteNumber(windowSeconds) ||
      windowSeconds <= 0
    ) {
      failures.push(`${label} has invalid ${description} counter evidence`)
      return null
    }
    return (current - previous) / windowSeconds
  }
  const expectedProducerFps = positiveSafeInteger(currentEvidence?.producerTargetFps)
    ? currentEvidence.producerTargetFps
    : null
  const expectedConsumerFps =
    expectedProducerFps !== null && positiveSafeInteger(currentEvidence?.compositorTargetFps)
      ? Math.min(expectedProducerFps, currentEvidence.compositorTargetFps)
      : null
  return {
    failures,
    sample: {
      observedAt: new Date(observedAtMs).toISOString(),
      sourceGeneration: currentEvidence?.sourceGeneration ?? null,
      captureCallbackFps: counterRate('captureCallbackCount', 'capture-callback'),
      publicationFps: counterRate('frameStorePublications', 'publication'),
      freshServeFps: counterRate('freshServes', 'fresh-serve'),
      expectedProducerFps,
      expectedConsumerFps
    }
  }
}

export function captureRecoveryCadenceRestoreFailures(
  cadenceRestore,
  { expectedGeneration, minimumRateFraction = 0.9, requiredConsecutiveSamples = 3 } = {}
) {
  const failures = []
  if (cadenceRestore?.minimumRateFraction !== minimumRateFraction) {
    failures.push(
      `capture recovery cadence restore minimumRateFraction must be ${minimumRateFraction}`
    )
  }
  if (cadenceRestore?.requiredConsecutiveSamples !== requiredConsecutiveSamples) {
    failures.push(
      `capture recovery cadence restore requiredConsecutiveSamples must be ${requiredConsecutiveSamples}`
    )
  }
  if (!positiveSafeInteger(expectedGeneration)) {
    failures.push('capture recovery cadence restore requires a positive recovered generation')
  }
  const samples = Array.isArray(cadenceRestore?.samples) ? cadenceRestore.samples : []
  if (samples.length !== requiredConsecutiveSamples) {
    failures.push(
      `capture recovery cadence restore retained ${samples.length} sample(s); expected exactly ${requiredConsecutiveSamples}`
    )
  }
  let previousObservedAtMs = null
  for (const [index, sample] of samples.entries()) {
    const label = `capture recovery cadence restore sample ${index + 1}`
    const observedAtMs = Date.parse(sample?.observedAt)
    if (!Number.isFinite(observedAtMs)) {
      failures.push(`${label} has no valid observedAt timestamp`)
    } else if (previousObservedAtMs !== null && observedAtMs <= previousObservedAtMs) {
      failures.push(`${label} is not strictly ordered after the preceding sample`)
    }
    if (Number.isFinite(observedAtMs)) previousObservedAtMs = observedAtMs
    if (sample?.sourceGeneration !== expectedGeneration) {
      failures.push(`${label} does not use recovered generation ${expectedGeneration}`)
    }
    for (const [field, description] of [
      ['expectedProducerFps', 'expected producer cadence'],
      ['expectedConsumerFps', 'expected consumer cadence']
    ]) {
      if (!finiteNumber(sample?.[field]) || sample[field] <= 0) {
        failures.push(`${label} has no positive ${description}`)
      }
    }
    for (const [field, expectedField, description] of [
      ['captureCallbackFps', 'expectedProducerFps', 'capture-callback cadence'],
      ['publicationFps', 'expectedProducerFps', 'publication cadence'],
      ['freshServeFps', 'expectedConsumerFps', 'fresh-serve cadence']
    ]) {
      const actual = sample?.[field]
      const expected = sample?.[expectedField]
      if (!nonNegativeFiniteNumber(actual)) {
        failures.push(`${label} has no finite ${description}`)
      } else if (
        finiteNumber(expected) &&
        expected > 0 &&
        actual < expected * minimumRateFraction
      ) {
        failures.push(
          `${label} ${description} ${formatRate(actual)} is below ${formatPercent(minimumRateFraction)} of ${formatRate(expected)}`
        )
      }
    }
  }
  return failures
}

export function evaluateDualCaptureRecoveryRecordingEvidence(
  evidence,
  { maximumRecoveryDurationMs = 4_000, maximumDetectionMs = 6_000 } = {}
) {
  const failures = []
  const identity = evidence?.identity
  if (!positiveSafeInteger(evidence?.appProcessId)) {
    failures.push('dual capture recovery evidence has no positive app process id')
  }
  if (!positiveSafeInteger(evidence?.backendProcessId)) {
    failures.push('dual capture recovery evidence has no positive backend process id')
  }
  if (!recoveryIdentityMatches(identity, evidence)) {
    failures.push('dual capture recovery shared identity does not match its top-level identity')
  }
  if (
    !Array.isArray(evidence?.sequence) ||
    evidence.sequence.length !== 2 ||
    evidence.sequence[0] !== 'camera' ||
    evidence.sequence[1] !== 'screen'
  ) {
    failures.push('dual capture recovery sequence must be exactly camera -> screen')
  }

  const evaluatedSources = {}
  for (const source of ['camera', 'screen']) {
    const entry = evidence?.[source]
    const stage = `${source}-delivery`
    if (!entry || typeof entry !== 'object') {
      failures.push(`dual capture recovery evidence is missing ${source}`)
      continue
    }
    if (!recoveryIdentityMatches(entry.identity, identity)) {
      failures.push(`${source}: recovery did not retain the shared app/backend/session identity`)
    }
    const armFailures = captureRecoveryArmFailures(entry.acknowledgement)
    failures.push(...armFailures.map((failure) => `${source}: ${failure}`))
    const evaluated = evaluateCaptureRecoveryEvidence({
      observations: entry.observations,
      maximumRecoveryDurationMs,
      expectedRecovery: true,
      expectedRecoveryStage: stage,
      expectedRecoverySource: source,
      faultArmedAtMs: entry.armedAtMs,
      armedSourceGeneration: entry.acknowledgement?.sourceGeneration,
      maximumDetectionMs
    })
    evaluatedSources[source] = evaluated.summary
    failures.push(...evaluated.failures.map((failure) => `${source}: ${failure}`))
    if (entry.terminalStatus?.phase !== 'idle') {
      failures.push(`${source}: recovery did not return to idle before the next boundary`)
    }
    if (!nonNegativeFiniteNumber(entry.armedAtMs) || !Number.isFinite(Date.parse(entry.armedAt))) {
      failures.push(`${source}: recovery has no valid arm timestamp`)
    }
    if (
      !nonNegativeFiniteNumber(entry.completedAtMs) ||
      entry.completedAtMs < entry.armedAtMs ||
      !Number.isFinite(Date.parse(entry.completedAt))
    ) {
      failures.push(`${source}: recovery has no valid completion timestamp after arm`)
    }
    const recoveredGenerations = evaluated.summary.recoveredGenerations
    const recoveredGeneration = recoveredGenerations.length === 1 ? recoveredGenerations[0] : null
    if (!entry.summary || typeof entry.summary !== 'object') {
      failures.push(`${source}: recovery summary is missing`)
    } else {
      for (const field of ['observedDetectionMs', 'observedRecoveryMs', 'preRestartGeneration']) {
        if (entry.summary[field] !== evaluated.summary[field]) {
          failures.push(`${source}: recovery summary ${field} does not match raw observations`)
        }
      }
      if (
        !Array.isArray(entry.summary.recoveredGenerations) ||
        entry.summary.recoveredGenerations.length !== recoveredGenerations.length ||
        entry.summary.recoveredGenerations.some(
          (generation, index) => generation !== recoveredGenerations[index]
        )
      ) {
        failures.push(`${source}: recovery summary generations do not match raw observations`)
      }
      failures.push(
        ...captureRecoveryCadenceRestoreFailures(entry.summary.cadenceRestore, {
          expectedGeneration: recoveredGeneration
        }).map((failure) => `${source}: ${failure}`)
      )
    }
  }

  if (
    nonNegativeFiniteNumber(evidence?.camera?.completedAtMs) &&
    nonNegativeFiniteNumber(evidence?.screen?.armedAtMs) &&
    evidence.camera.completedAtMs >= evidence.screen.armedAtMs
  ) {
    failures.push('camera recovery returned to idle before screen injection was not proven')
  }

  const recording = evidence?.recording
  const sessionId = evidence?.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    failures.push('dual capture recovery evidence has no recording session id')
  }
  if (recording?.started?.sessionId !== sessionId || recording?.started?.state !== 'recording') {
    failures.push('recording start does not prove the same recording session entered recording')
  }
  if (!recoveryIdentityMatches(recording?.identity, identity)) {
    failures.push('recording did not retain the shared app/backend/session identity')
  }
  if (
    recording?.stopped?.sessionId !== sessionId ||
    recording?.stopped?.state !== 'stopped' ||
    recording?.stopped?.backendState !== 'idle'
  ) {
    failures.push('recording stop does not prove the same recording session stopped normally')
  }
  const expectedBoundaries = [
    ['camera', 'before'],
    ['camera', 'after'],
    ['screen', 'before'],
    ['screen', 'after']
  ]
  const recordingObservations = Array.isArray(recording?.observations) ? recording.observations : []
  if (recordingObservations.length !== expectedBoundaries.length) {
    failures.push('recording evidence must contain exactly four source-boundary observations')
  }
  let previousBoundaryAtMs = Date.parse(recording?.started?.observedAt)
  for (const [index, [source, boundary]] of expectedBoundaries.entries()) {
    const observation = recordingObservations[index]
    const observedAtMs = Date.parse(observation?.observedAt)
    if (
      observation?.source !== source ||
      observation?.boundary !== boundary ||
      observation?.sessionId !== sessionId ||
      observation?.state !== 'recording' ||
      observation?.appProcessId !== identity?.appProcessId ||
      observation?.backendProcessId !== identity?.backendProcessId
    ) {
      failures.push(
        `recording boundary ${index + 1} did not preserve the same recording session for ${source}/${boundary}`
      )
    }
    if (!Number.isFinite(observedAtMs) || observedAtMs <= previousBoundaryAtMs) {
      failures.push(`recording boundary ${index + 1} has no strictly ordered timestamp`)
    }
    if (Number.isFinite(observedAtMs)) previousBoundaryAtMs = observedAtMs
  }
  const stoppedAtMs = Date.parse(recording?.stopped?.observedAt)
  if (!Number.isFinite(stoppedAtMs) || stoppedAtMs <= previousBoundaryAtMs) {
    failures.push('recording stop is not ordered after both source recoveries')
  }
  if (recording?.normalStop !== true) {
    failures.push('recording did not report a normal explicit stop')
  }
  if (!finiteNumber(recording?.requestedDurationMs) || recording.requestedDurationMs <= 0) {
    failures.push('recording requested duration is unavailable')
  }
  if (
    !finiteNumber(recording?.observedDurationMs) ||
    recording.observedDurationMs < recording.requestedDurationMs * 0.97
  ) {
    failures.push('recording observed duration is below 97% of requested duration')
  }
  if (typeof recording?.outputPath !== 'string' || !/\.mp4$/i.test(recording.outputPath)) {
    failures.push('recording did not produce a finalized MP4 artifact')
  }
  if (
    recording?.artifact?.path !== recording?.outputPath ||
    !positiveSafeInteger(recording?.artifact?.sizeBytes) ||
    !lowercaseSha256(recording?.artifact?.sha256) ||
    recording?.artifactBytes !== recording?.artifact?.sizeBytes ||
    recording?.artifactSha256 !== recording?.artifact?.sha256
  ) {
    failures.push('recording artifact does not retain one matching non-empty SHA-256 descriptor')
  }
  const analyzer = recording?.analyzer
  if (analyzer?.verdict !== 'passed') {
    failures.push('recording artifact analyzer did not pass')
  }
  if (
    !finiteNumber(analyzer?.artifactDurationSeconds) ||
    analyzer.artifactDurationSeconds * 1_000 < recording?.requestedDurationMs * 0.97
  ) {
    failures.push('recording artifact duration is below 97% of requested duration')
  }
  if (analyzer?.motionPass !== true || analyzer?.freezePass !== true) {
    failures.push('recording artifact did not pass motion/freeze analysis')
  }
  if (analyzer?.audioPass !== true || analyzer?.avSyncPass !== true) {
    failures.push('recording artifact did not pass audio/A/V analysis')
  }
  const analyzerMetrics = analyzer?.metrics
  const analyzerGates = analyzer?.gates
  if (
    !nonNegativeFiniteNumber(analyzerMetrics?.uniqueFrameRatio) ||
    !nonNegativeFiniteNumber(analyzerGates?.minUniqueFrameRatio) ||
    analyzerMetrics.uniqueFrameRatio < analyzerGates.minUniqueFrameRatio
  ) {
    failures.push('recording artifact motion metrics do not satisfy the retained analyzer gate')
  }
  if (
    !nonNegativeFiniteNumber(analyzerMetrics?.longestCorroboratedFreezeMs) ||
    !nonNegativeFiniteNumber(analyzerMetrics?.maxRepeatedFrameRun) ||
    !nonNegativeFiniteNumber(analyzerGates?.maxFreezeMs) ||
    !nonNegativeFiniteNumber(analyzerGates?.maxRepeatedFrameRun) ||
    analyzerMetrics.longestCorroboratedFreezeMs > analyzerGates.maxFreezeMs ||
    analyzerMetrics.maxRepeatedFrameRun > analyzerGates.maxRepeatedFrameRun
  ) {
    failures.push('recording artifact freeze metrics do not satisfy the retained analyzer gates')
  }
  if (
    !nonNegativeFiniteNumber(analyzerMetrics?.maxAudioGapMs) ||
    !nonNegativeFiniteNumber(analyzerGates?.maxAudioGapMs) ||
    analyzerMetrics.maxAudioGapMs > analyzerGates.maxAudioGapMs
  ) {
    failures.push('recording artifact audio metrics do not satisfy the retained analyzer gate')
  }
  if (
    !nonNegativeFiniteNumber(analyzerMetrics?.avSkewMs) ||
    !nonNegativeFiniteNumber(analyzerMetrics?.tailMismatchMs) ||
    !nonNegativeFiniteNumber(analyzerGates?.avSyncHardFailMs) ||
    !nonNegativeFiniteNumber(analyzerGates?.maxTailMismatchMs) ||
    analyzerMetrics.avSkewMs > analyzerGates.avSyncHardFailMs ||
    analyzerMetrics.tailMismatchMs > analyzerGates.maxTailMismatchMs
  ) {
    failures.push('recording artifact A/V metrics do not satisfy the retained analyzer gates')
  }

  return {
    failures,
    summary: {
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      sequence: Array.isArray(evidence?.sequence) ? [...evidence.sequence] : [],
      camera: evaluatedSources.camera ?? null,
      screen: evaluatedSources.screen ?? null,
      requestedDurationMs: finiteNumber(recording?.requestedDurationMs)
        ? recording.requestedDurationMs
        : null,
      observedDurationMs: finiteNumber(recording?.observedDurationMs)
        ? recording.observedDurationMs
        : null
    }
  }
}

function expectedRecoveryPhaseRank(phase) {
  if (phase === 'degraded' || phase === 'restarting') return 1
  if (phase === 'verifying') return 2
  if (phase === 'recovered') return 3
  return null
}

function canonicalRecoveryObservations(observations) {
  const failures = []
  const canonical = []
  const firstPayloadByRevision = new Map()
  let highestAcceptedRevision = -1
  for (const [index, observation] of observations.entries()) {
    const revision = observation?.revision
    if (!Number.isSafeInteger(revision) || revision < 0) {
      failures.push(
        `capture recovery ${observation?.origin ?? 'unknown'} observation ${index + 1} has no valid revision`
      )
      continue
    }
    const signature = recoveryObservationPayloadSignature(observation)
    const firstSignature = firstPayloadByRevision.get(revision)
    if (firstSignature !== undefined) {
      if (firstSignature !== signature) {
        failures.push(`capture recovery revision ${revision} had conflicting payloads`)
      }
      continue
    }
    firstPayloadByRevision.set(revision, signature)
    if (revision > highestAcceptedRevision) {
      canonical.push(observation)
      highestAcceptedRevision = revision
    }
  }
  return { observations: canonical, failures }
}

function recoveryObservationPayloadSignature(observation) {
  return JSON.stringify([
    observation?.phase ?? null,
    observation?.retryable ?? null,
    observation?.attempts ?? null,
    observation?.stage ?? null,
    observation?.source ?? null,
    observation?.trigger ?? null,
    observation?.sourceGeneration ?? null,
    observation?.detectedAt ?? null,
    observation?.updatedAt ?? null,
    observation?.message ?? null,
    observation?.lastError ?? null,
    observation?.lastDurationMs ?? null
  ])
}

export function syntheticIsolationFailures({ before, after, cameraStatus, screenStatus }) {
  const failures = []
  if (cameraStatus?.state === 'live' || cameraStatus?.cameraId) {
    failures.push('synthetic soak unexpectedly has a real camera preview source')
  }
  if (screenStatus?.state === 'live' || screenStatus?.sourceId) {
    failures.push('synthetic soak unexpectedly has a real screen preview source')
  }
  for (const [label, field] of REAL_SOURCE_PROGRESS_FIELDS) {
    if (counterAdvanced(before?.[field], after?.[field])) {
      failures.push(`${label} advanced during the synthetic-only preflight`)
    }
  }
  failures.push(...renderCadenceFailures(after))
  return failures
}

export function sourceSelectionForPreview(sources) {
  return {
    screenId: sources.screen.id,
    windowId: null,
    cameraId: sources.camera.id,
    microphoneId: sources.microphone?.id ?? null,
    testPattern: false
  }
}

export function captureDecayLayout() {
  return {
    layoutPreset: 'screen-camera',
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraMargin: 32,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '70-30',
    sideBySideCameraSide: 'right'
  }
}

export function captureDecayVideo(
  env = {},
  { realSources = env.VIDEORC_SOAK_REAL_SOURCES === '1' } = {}
) {
  return {
    preset: 'custom',
    width: positiveInteger(env.VIDEORC_SOAK_WIDTH, realSources ? 3840 : 1280, 'VIDEORC_SOAK_WIDTH'),
    height: positiveInteger(
      env.VIDEORC_SOAK_HEIGHT,
      realSources ? 2160 : 720,
      'VIDEORC_SOAK_HEIGHT'
    ),
    fps: positiveInteger(env.VIDEORC_SOAK_FPS, 30, 'VIDEORC_SOAK_FPS'),
    bitrateKbps: positiveInteger(
      env.VIDEORC_SOAK_BITRATE_KBPS,
      realSources ? 30_000 : 4_000,
      'VIDEORC_SOAK_BITRATE_KBPS'
    )
  }
}

function sampleGaps(samples, plannedDurationMs) {
  if (samples.length === 0) return [plannedDurationMs]
  const gaps = []
  let previousElapsedMs = 0
  for (const sample of samples) {
    if (!nonNegativeFiniteNumber(sample.elapsedMs) || sample.elapsedMs < previousElapsedMs) {
      return [Number.POSITIVE_INFINITY]
    }
    gaps.push(sample.elapsedMs - previousElapsedMs)
    previousElapsedMs = sample.elapsedMs
  }
  gaps.push(Math.max(0, plannedDurationMs - previousElapsedMs))
  return gaps
}

function summarizeSurfaceSamples(samples, source, slopeMinimumMinutes) {
  const prefix = source === 'camera' ? 'camera' : 'screen'
  const evidence = samples
    .map((sample) => ({
      elapsedMs: sample.elapsedMs,
      liveCount: sample[`${prefix}SurfaceLiveCount`],
      peakCount: sample[`${prefix}SurfacePeakCount`]
    }))
    .filter(
      (sample) =>
        nonNegativeFiniteNumber(sample.elapsedMs) &&
        nonNegativeFiniteNumber(sample.liveCount) &&
        nonNegativeFiniteNumber(sample.peakCount)
    )
  const durationMs = evidence.length >= 2 ? evidence.at(-1).elapsedMs - evidence[0].elapsedMs : 0
  const slopeEvaluated =
    evidence.length >= 2 && durationMs >= Math.max(0, slopeMinimumMinutes) * 60_000
  return {
    evidenceSamples: evidence.length,
    maximumLiveCount:
      evidence.length > 0 ? Math.max(...evidence.map((sample) => sample.liveCount)) : null,
    maximumPeakCount:
      evidence.length > 0 ? Math.max(...evidence.map((sample) => sample.peakCount)) : null,
    initialLiveCount: evidence[0]?.liveCount ?? null,
    finalLiveCount: evidence.at(-1)?.liveCount ?? null,
    slopeEvaluated,
    liveCountSlopePerMinute: slopeEvaluated ? leastSquaresSlopePerMinute(evidence) : null,
    slopeWindowMinutes: durationMs / 60_000
  }
}

function summarizeRetentionPoint(samples, point, slopeMinimumMinutes) {
  const evidence = samples
    .map((sample) => ({
      elapsedMs: sample?.elapsedMs,
      liveCount: sample?.[point.liveField],
      peakCount: sample?.[point.peakField],
      ceiling: sample?.[point.ceilingField]
    }))
    .filter(
      (sample) =>
        nonNegativeFiniteNumber(sample.elapsedMs) &&
        nonNegativeFiniteNumber(sample.liveCount) &&
        nonNegativeFiniteNumber(sample.peakCount) &&
        nonNegativeFiniteNumber(sample.ceiling)
    )
  const durationMs = evidence.length >= 2 ? evidence.at(-1).elapsedMs - evidence[0].elapsedMs : 0
  const slopeEvaluated =
    evidence.length >= 2 && durationMs >= Math.max(0, slopeMinimumMinutes) * 60_000
  const slopePerMinute = slopeEvaluated ? leastSquaresSlopePerMinute(evidence) : 0
  const maximumLiveCount =
    evidence.length > 0 ? Math.max(...evidence.map((sample) => sample.liveCount)) : 0
  const peakCount =
    evidence.length > 0 ? Math.max(...evidence.map((sample) => sample.peakCount)) : 0
  const ceiling = evidence.length > 0 ? Math.max(...evidence.map((sample) => sample.ceiling)) : 0
  return {
    id: point.id,
    label: point.label,
    evidenceSamples: evidence.length,
    liveCount: evidence.at(-1)?.liveCount ?? 0,
    peakCount,
    ceiling,
    slopePerMinute,
    withinCeiling:
      evidence.length > 0 &&
      evidence.every(
        (sample) =>
          sample.liveCount <= sample.peakCount &&
          sample.liveCount <= sample.ceiling &&
          sample.peakCount <= sample.ceiling
      ),
    initialLiveCount: evidence[0]?.liveCount ?? 0,
    finalLiveCount: evidence.at(-1)?.liveCount ?? 0,
    maximumLiveCount,
    slopeEvaluated,
    slopeWindowMinutes: durationMs / 60_000
  }
}

function leastSquaresSlopePerMinute(samples) {
  const originMs = samples[0].elapsedMs
  const points = samples.map((sample) => ({
    x: (sample.elapsedMs - originMs) / 60_000,
    y: sample.liveCount
  }))
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0)
  if (denominator === 0) return 0
  return points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator
}

function surfaceSnapshot(backing) {
  return {
    liveCount: numberOrNull(backing?.liveCount),
    peakCount: numberOrNull(backing?.peakCount),
    estimatedBytes: numberOrNull(backing?.estimatedBytes),
    peakEstimatedBytes: numberOrNull(backing?.peakEstimatedBytes),
    oldestAgeMs: numberOrNull(backing?.oldestAgeMs)
  }
}

function validateNativeSource(source, kind, nativePrefix, failures) {
  if (!source) {
    failures.push(`no ${kind} with id prefix ${nativePrefix}`)
    return
  }
  if (!source.id.startsWith(nativePrefix)) {
    failures.push(`${kind} ${source.id} is not the required native source`)
  }
  if (source.status !== 'available') {
    failures.push(`${kind} ${source.id} is ${source.status ?? 'not available'}`)
  }
}

function lockedReleaseEnvironment(env, expected, label) {
  for (const [name, value] of Object.entries(expected)) {
    if (env[name] !== undefined && String(env[name]) !== value) {
      throw new Error(
        `${label} locks ${name}=${value}; use the investigation command for overrides (received ${String(env[name])}).`
      )
    }
  }
  return { ...env, ...expected }
}

function positiveNumber(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!finiteNumber(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number.`)
  }
  return parsed
}

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return parsed
}

function nonNegativeNumber(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!nonNegativeFiniteNumber(parsed)) {
    throw new Error(`${name} must be a finite non-negative number.`)
  }
  return parsed
}

function fraction(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!finiteNumber(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${name} must be a finite number greater than 0 and at most 1.`)
  }
  return parsed
}

function counterRate(current, previous, seconds) {
  return nonNegativeFiniteNumber(current) &&
    nonNegativeFiniteNumber(previous) &&
    finiteNumber(seconds) &&
    seconds > 0 &&
    current >= previous
    ? (current - previous) / seconds
    : null
}

function counterAdvanced(before, after) {
  return nonNegativeFiniteNumber(before) && nonNegativeFiniteNumber(after) && after > before
}

function numberOrNull(value) {
  return finiteNumber(value) ? value : null
}

function positiveFiniteOrNull(value) {
  return finiteNumber(value) && value > 0 ? value : null
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function lowercaseSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function recoveryIdentityMatches(candidate, expected) {
  return (
    typeof candidate?.sessionId === 'string' &&
    candidate.sessionId.length > 0 &&
    candidate.sessionId === expected?.sessionId &&
    positiveSafeInteger(candidate.appProcessId) &&
    candidate.appProcessId === expected?.appProcessId &&
    positiveSafeInteger(candidate.backendProcessId) &&
    candidate.backendProcessId === expected?.backendProcessId
  )
}

function trailingReadyPolls(polls) {
  if (!Array.isArray(polls)) return []
  const ready = []
  for (let index = polls.length - 1; index >= 0; index -= 1) {
    const poll = polls[index]
    if (!Array.isArray(poll?.failures) || poll.failures.length > 0) break
    ready.unshift(poll)
  }
  return ready
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonNegativeFiniteNumber(value) {
  return finiteNumber(value) && value >= 0
}

function formatCounter(value) {
  return nonNegativeFiniteNumber(value) ? String(value) : 'unavailable'
}

function formatRate(value) {
  return nonNegativeFiniteNumber(value) ? `${value.toFixed(1)}fps` : 'unavailable'
}

function formatMetric(value) {
  if (!finiteNumber(value)) return 'unavailable'
  return Number(value.toFixed(3))
}

function formatPercent(value) {
  if (!finiteNumber(value)) return 'unavailable'
  return `${(value * 100).toFixed(1)}%`
}

function csvValue(value) {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'number' ? formatNumber(value) : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return ''
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(3)))
}
