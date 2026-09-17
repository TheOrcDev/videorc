import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  CAPTURE_DECAY_RELEASE_ENV,
  CAPTURE_DECAY_CSV_COLUMNS,
  LONG_RECORDING_RELEASE_ENV,
  captureDecayCsvHeader,
  captureDecayCsvRow,
  captureDecaySoakConfig,
  captureDecayVideo,
  captureRecoveryArmFailures,
  captureRecoveryCadenceSample,
  captureRecoveryCadenceRestoreFailures,
  captureRecoveryObservation,
  createCaptureDecaySample,
  effectiveCompositorTargetFps,
  evaluateCaptureDecayEvidence,
  evaluateLongRecordingRuntimeEvidence,
  evaluateCaptureRecoveryEvidence,
  evaluateDualCaptureRecoveryRecordingEvidence,
  longRecordingGateConfig,
  longRecordingEvidenceFailures,
  nativePreviewFailures,
  nativeRetentionSnapshot,
  realSourceProgressFailures,
  realSourceShippingPathFailures,
  realSourceSurfaceBackingFailures,
  realSourceCadenceBaseline,
  realSourceSampleFailures,
  renderCadenceFailures,
  sceneAdoptionFailures,
  sceneCommitFailures,
  selectNativeSoakSources,
  sourceSurfaceSnapshot,
  retentionReconfigurationTimeline,
  retentionTeardownFailures,
  surfaceReturnFailures,
  syntheticIsolationFailures
} from './capture-decay-soak.mjs'

test('capture decay sample flattens surface evidence and computes counter rates', () => {
  const previousStats = diagnostics({
    previewCameraCaptureCallbackCount: 100,
    previewCameraDidDropCallbackCount: 20,
    previewCameraDropReasons: { outOfBuffers: 10 },
    previewCameraFrameStorePublications: 90,
    compositorCameraSourceFreshServes: 80,
    compositorCameraSourceHeldServes: 20,
    previewScreenCaptureCallbackCount: 200,
    previewScreenFrameStorePublications: 180,
    compositorScreenSourceFreshServes: 160,
    compositorScreenSourceHeldServes: 40
  })
  const stats = diagnostics({
    previewCameraCaptureCallbackCount: 130,
    previewCameraDidDropCallbackCount: 50,
    previewCameraDropReasons: { outOfBuffers: 30 },
    previewCameraFrameStorePublications: 120,
    compositorCameraSourceFreshServes: 110,
    compositorCameraSourceHeldServes: 30,
    previewScreenCaptureCallbackCount: 250,
    previewScreenFrameStorePublications: 230,
    compositorScreenSourceFreshServes: 200,
    compositorScreenSourceHeldServes: 50,
    previewFrameAgeMs: 18,
    previewInputToPresentLatencyP95Ms: 44,
    previewPresentFps: 29.5,
    previewTransport: 'native-surface',
    previewSurfaceBacking: 'cametal-layer',
    recordingProtected: true,
    encoderBridgeRequestedVideoOutput: 'videotoolbox-h264-mpegts',
    encoderBridgeEffectiveVideoOutput: 'videotoolbox-h264-mpegts',
    compositorBackend: 'metal',
    compositorMetalCachedCaptureSourceImportsLiveCount: 2,
    compositorMetalCachedCaptureSourceImportsPeakCount: 3,
    compositorMetalCachedCaptureSourceImportsCeiling: 4,
    compositorMetalTargetRingSlotsLiveCount: 3,
    compositorMetalTargetRingSlotsPeakCount: 4,
    compositorMetalTargetRingSlotsCeiling: 5,
    encoderBridgeMetalTargetRefsInFlightLiveCount: 1,
    encoderBridgeMetalTargetRefsInFlightPeakCount: 2,
    encoderBridgeMetalTargetRefsInFlightCeiling: 5,
    previewCameraSurfaceBacking: {
      liveCount: 2,
      peakCount: 3,
      estimatedBytes: 10,
      peakEstimatedBytes: 20,
      oldestAgeMs: 9
    },
    previewScreenSurfaceBacking: {
      liveCount: 4,
      peakCount: 5,
      estimatedBytes: 30,
      peakEstimatedBytes: 40,
      oldestAgeMs: 11
    }
  })

  const sample = createCaptureDecaySample({
    stats,
    surfaceStatus: {
      state: 'live',
      transport: 'native-surface',
      backing: 'cametal-layer',
      nativePreviewIosurfaceImportLiveCount: 2,
      nativePreviewIosurfaceImportPeakCount: 3,
      nativePreviewIosurfaceImportCeiling: 3,
      nativePreviewDrawableWidth: 2560,
      nativePreviewDrawableHeight: 1440,
      nativePreviewIosurfaceInvalidations: 1
    },
    cameraStatus: { state: 'live', cameraId: 'camera-1', targetFps: 30, sourceFps: 59.94 },
    screenStatus: { state: 'live', sourceId: 'screen-1', targetFps: 30, sourceFps: 60 },
    previousStats,
    nowMs: 12_000,
    previousAtMs: 2_000,
    startedAtMs: 0
  })

  assert.equal(sample.uptimeSec, 12)
  assert.equal(sample.elapsedMs, 12_000)
  assert.equal(sample.previewSurfaceState, 'live')
  assert.equal(sample.previewStatusTransport, 'native-surface')
  assert.equal(sample.previewStatusBacking, 'cametal-layer')
  assert.equal(sample.previewTransport, 'native-surface')
  assert.equal(sample.previewSurfaceBacking, 'cametal-layer')
  assert.equal(sample.cameraCaptureCallbackFps, 3)
  assert.equal(sample.cameraDidDropCallbacks, 50)
  assert.equal(sample.cameraDidDropPerSec, 3)
  assert.equal(sample.cameraOutOfBuffers, 30)
  assert.equal(sample.cameraOutOfBuffersPerSec, 2)
  assert.equal(sample.cameraPublicationFps, 3)
  assert.equal(sample.cameraFreshFps, 3)
  assert.equal(sample.cameraHeldFps, 1)
  assert.equal(sample.screenCaptureCallbackFps, 5)
  assert.equal(sample.screenPublicationFps, 5)
  assert.equal(sample.screenFreshFps, 4)
  assert.equal(sample.screenHeldFps, 1)
  assert.equal(sample.cameraSurfaceLiveCount, 2)
  assert.equal(sample.cameraSurfacePeakCount, 3)
  assert.equal(sample.screenSurfaceLiveCount, 4)
  assert.equal(sample.screenSurfacePeakCount, 5)
  assert.equal(sample.previewFrameAgeMs, 18)
  assert.equal(sample.previewInputToPresentLatencyP95Ms, 44)
  assert.equal(sample.previewPresentFps, 29.5)
  assert.equal(sample.recordingProtected, true)
  assert.equal(sample.encoderBridgeRequestedVideoOutput, 'videotoolbox-h264-mpegts')
  assert.equal(sample.encoderBridgeEffectiveVideoOutput, 'videotoolbox-h264-mpegts')
  assert.equal(sample.compositorBackend, 'metal')
  assert.equal(sample.compositorMetalCachedCaptureSourceImportsLiveCount, 2)
  assert.equal(sample.compositorMetalTargetRingSlotsCeiling, 5)
  assert.equal(sample.encoderBridgeMetalTargetRefsInFlightLiveCount, 1)
  assert.equal(sample.nativePreviewIosurfaceImportLiveCount, 2)
  assert.equal(sample.nativePreviewDrawableWidth, 2560)
  assert.equal(sample.nativePreviewDrawableHeight, 1440)
  assert.equal(sample.nativePreviewIosurfaceInvalidations, 1)
  assert.equal(sample.cameraStatusSourceFps, 59.94)
  assert.equal(sample.screenStatusSourceFps, 60)
})

test('capture decay sample rejects reset and non-finite counters as rates', () => {
  const sample = createCaptureDecaySample({
    stats: diagnostics({
      previewCameraCaptureCallbackCount: 1,
      previewCameraDidDropCallbackCount: 1,
      previewCameraDropReasons: { outOfBuffers: 1 },
      previewCameraFrameStorePublications: Number.NaN
    }),
    previousStats: diagnostics({
      previewCameraCaptureCallbackCount: 5,
      previewCameraDidDropCallbackCount: 5,
      previewCameraDropReasons: { outOfBuffers: 5 },
      previewCameraFrameStorePublications: 5
    }),
    nowMs: 3_000,
    previousAtMs: 2_000,
    startedAtMs: 0
  })

  assert.equal(sample.cameraCaptureCallbackFps, null)
  assert.equal(sample.cameraDidDropPerSec, null)
  assert.equal(sample.cameraOutOfBuffersPerSec, null)
  assert.equal(sample.cameraPublicationFps, null)
})

test('capture decay CSV has stable evidence columns and escapes text', () => {
  assert.equal(captureDecayCsvHeader(), CAPTURE_DECAY_CSV_COLUMNS.join(','))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('cameraSurfaceLiveCount'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('screenSurfacePeakCount'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('previewFrameAgeMs'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('previewInputToPresentLatencyP95Ms'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('previewTransport'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('previewStatusBacking'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('compositorWidth'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('nativePreviewDrawableWidth'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('nativePreviewIosurfaceInvalidations'))
  assert.ok(
    CAPTURE_DECAY_CSV_COLUMNS.includes('compositorMetalCachedCaptureSourceImportsLiveCount')
  )
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('compositorMetalTargetRingSlotsCeiling'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('encoderBridgeMetalTargetRefsInFlightPeakCount'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('nativePreviewIosurfaceImportLiveCount'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('recordingProtected'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('encoderBridgeRequestedVideoOutput'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('encoderBridgeEffectiveVideoOutput'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('compositorBackend'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('cameraCaptureCallbackFps'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('cameraDidDropCallbacks'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('cameraDidDropPerSec'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('cameraOutOfBuffers'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('cameraOutOfBuffersPerSec'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('screenPublicationFps'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('cameraStatusSourceFps'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('screenStatusSourceFps'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('captureRecoveryRevision'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('captureRecoverySourceGeneration'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('captureRecoveryAttempts'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('captureRecoveryDetectedAt'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('captureRecoveryUpdatedAt'))
  assert.ok(CAPTURE_DECAY_CSV_COLUMNS.includes('evidenceFailure'))

  const row = captureDecayCsvRow({ uptimeSec: 10, degradedStage: 'camera,delivery' })
  assert.equal(row.split(',')[CAPTURE_DECAY_CSV_COLUMNS.indexOf('uptimeSec')], '10')
  assert.ok(row.includes('"camera,delivery"'))
})

test('real source selection requires available native SCK and AVFoundation ids', () => {
  const devices = [
    device('camera', 'camera:avfoundation-native:cam-1'),
    device('camera', 'camera:legacy:cam-2'),
    device('screen', 'screen:screencapturekit:display-1'),
    device('screen', 'screen:legacy:display-2')
  ]
  const selected = selectNativeSoakSources(devices)
  assert.equal(selected.camera.id, 'camera:avfoundation-native:cam-1')
  assert.equal(selected.screen.id, 'screen:screencapturekit:display-1')

  assert.throws(
    () =>
      selectNativeSoakSources([
        device('camera', 'camera:avfoundation-native:cam-1'),
        device('screen', 'screen:screencapturekit:display-1', 'permission-needed')
      ]),
    /screen.*permission-needed/
  )
  assert.throws(
    () => selectNativeSoakSources(devices, { cameraOverride: 'camera:legacy:cam-2' }),
    /not the required native source/
  )
})

test('recovery source selection additionally requires a native microphone for A/V evidence', () => {
  const devices = [
    device('camera', 'camera:avfoundation-native:cam-1'),
    device('screen', 'screen:screencapturekit:display-1'),
    device('microphone', 'microphone:coreaudio:mic-1')
  ]
  assert.equal(
    selectNativeSoakSources(devices, { requireMicrophone: true }).microphone.id,
    'microphone:coreaudio:mic-1'
  )
  assert.throws(
    () => selectNativeSoakSources(devices.slice(0, 2), { requireMicrophone: true }),
    /microphone/
  )
})

test('real source preflight requires exact live ids and advancing callback/publication counters', () => {
  const sources = {
    camera: device('camera', 'camera:avfoundation-native:cam-1'),
    screen: device('screen', 'screen:screencapturekit:display-1')
  }
  const before = diagnostics()
  const after = diagnostics({
    previewCameraCaptureCallbackCount: 2,
    previewCameraFrameStorePublications: 2,
    previewScreenCaptureCallbackCount: 2,
    previewScreenFrameStorePublications: 2,
    previewCameraSurfaceBacking: {
      liveCount: 2,
      peakCount: 3,
      estimatedBytes: 10,
      peakEstimatedBytes: 20
    },
    previewScreenSurfaceBacking: {
      liveCount: 3,
      peakCount: 4,
      estimatedBytes: 20,
      peakEstimatedBytes: 30
    }
  })
  const cameraStatus = { state: 'live', cameraId: sources.camera.id }
  const screenStatus = { state: 'live', sourceId: sources.screen.id }

  assert.deepEqual(
    realSourceProgressFailures({ before, after, cameraStatus, screenStatus, sources }),
    []
  )
  assert.ok(
    realSourceProgressFailures({
      before,
      after: before,
      cameraStatus,
      screenStatus,
      sources
    }).some((failure) => failure.includes('camera capture callbacks did not advance'))
  )
  assert.ok(
    realSourceProgressFailures({
      before,
      after: { ...after, previewCameraSurfaceBacking: diagnostics().previewCameraSurfaceBacking },
      cameraStatus,
      screenStatus,
      sources
    }).some((failure) => failure.includes('do not prove the shipping IOSurface path'))
  )
})

test('real-source evidence refuses capture-path kill switches', () => {
  assert.deepEqual(realSourceShippingPathFailures({}), [])
  assert.deepEqual(realSourceShippingPathFailures({ VIDEORC_ZEROCOPY_SOURCES: '1' }), [])
  for (const env of [
    { VIDEORC_ZEROCOPY_SOURCES: '0' },
    { VIDEORC_ZEROCOPY_SOURCES: 'off' },
    { VIDEORC_CAMERA_CAPTURE_CPU_COPY: 'true' },
    { VIDEORC_SCREEN_CAPTURE_CPU_COPY: '1' }
  ]) {
    assert.ok(realSourceShippingPathFailures(env).length > 0)
  }
})

test('real soak scene commits and proves the exact selected screen and camera were rendered', () => {
  const sources = {
    camera: device('camera', 'camera:avfoundation-native:cam-1'),
    screen: device('screen', 'screen:screencapturekit:display-1')
  }
  const sceneSources = [
    { kind: 'screen', deviceId: sources.screen.id, visible: true },
    { kind: 'camera', deviceId: sources.camera.id, visible: true }
  ]
  const video = { width: 3840, height: 2160, fps: 30 }
  const compositorStatus = {
    state: 'live',
    sceneRevision: 42,
    frameSceneRevision: 42,
    sceneSources
  }
  assert.deepEqual(
    sceneCommitFailures({
      sceneCommitted: {
        applied: true,
        mode: 'idle',
        sceneRevision: 42,
        scene: {
          sources: sceneSources,
          outputs: [{ kind: 'recording', ...video }]
        },
        compositorStatus
      },
      sources,
      video
    }),
    []
  )
  assert.deepEqual(sceneAdoptionFailures({ compositorStatus, sceneRevision: 42, sources }), [])
  assert.ok(
    sceneCommitFailures({
      sceneCommitted: {
        applied: true,
        mode: 'idle',
        sceneRevision: 42,
        scene: {
          sources: [...sceneSources, { kind: 'test-pattern', deviceId: null, visible: false }],
          outputs: [{ kind: 'recording', width: 1280, height: 720, fps: 30 }]
        },
        compositorStatus
      },
      sources,
      video
    }).some((failure) => failure.includes('expected exactly 2'))
  )
  assert.ok(
    sceneAdoptionFailures({
      compositorStatus: { ...compositorStatus, frameSceneRevision: 41 },
      sceneRevision: 42,
      sources
    }).some((failure) => failure.includes('rendered frame scene revision'))
  )
})

test('real-source sustained gate covers rates, sequences, freshness, identity, and health', () => {
  const sources = {
    camera: device('camera', 'camera:avfoundation-native:cam-1'),
    screen: device('screen', 'screen:screencapturekit:display-1')
  }
  const previousSample = { cameraLatestSequence: 100, screenLatestSequence: 200 }
  const sample = {
    cameraStatusState: 'live',
    cameraStatusCameraId: sources.camera.id,
    screenStatusState: 'live',
    screenStatusSourceId: sources.screen.id,
    compositorSceneRevision: 42,
    compositorFrameSceneRevision: 42,
    compositorCameraSceneDeviceId: sources.camera.id,
    compositorScreenSceneDeviceId: sources.screen.id,
    cameraCaptureCallbackFps: 30,
    cameraPublicationFps: 29,
    cameraFreshFps: 28,
    screenCaptureCallbackFps: 30,
    screenPublicationFps: 30,
    screenFreshFps: 29,
    cameraLatestSequence: 130,
    screenLatestSequence: 230,
    cameraFrameAgeMs: 20,
    cameraCaptureCallbackAgeMs: 15,
    screenFrameAgeMs: 25,
    screenCaptureCallbackAgeMs: 18,
    cameraSurfaceLiveCount: 2,
    cameraSurfaceEstimatedBytes: 10,
    screenSurfaceLiveCount: 3,
    screenSurfaceEstimatedBytes: 20,
    degradedStage: null
  }
  assert.deepEqual(
    realSourceSampleFailures({
      sample,
      previousSample,
      sources,
      sceneRevision: 42,
      targetFps: 30
    }),
    []
  )
  const failures = realSourceSampleFailures({
    sample: {
      ...sample,
      cameraPublicationFps: 5,
      screenLatestSequence: 200,
      cameraFrameAgeMs: 1_001,
      cameraSurfaceLiveCount: 0,
      cameraSurfaceEstimatedBytes: 0
    },
    previousSample,
    sources,
    sceneRevision: 42,
    targetFps: 30
  })
  assert.ok(failures.some((failure) => failure.includes('camera publication cadence')))
  assert.ok(failures.some((failure) => failure.includes('screen latest sequence')))
  assert.ok(failures.some((failure) => failure.includes('camera frame age')))
  assert.ok(failures.some((failure) => failure.includes('shipping IOSurface evidence')))

  const negotiatedCadence = realSourceCadenceBaseline({
    readinessPolls: [59.94, 60, 59.94].map((cameraSourceFps) => ({
      failures: [],
      cameraStatus: { sourceFps: cameraSourceFps },
      screenStatus: { sourceFps: 30 }
    })),
    cameraStatus: { targetFps: 30, sourceFps: 59.94 },
    screenStatus: { targetFps: 30, sourceFps: 30 },
    compositorTargetFps: 30
  })
  assert.equal(negotiatedCadence.cameraProducerFps, 59.94)
  assert.equal(negotiatedCadence.cameraConsumerFps, 30)
  assert.equal(negotiatedCadence.cameraBaselineSource, 'readiness-source-fps-median')
  const highRateDecay = realSourceSampleFailures({
    sample: {
      ...sample,
      cameraCaptureCallbackFps: 20,
      cameraPublicationFps: 20,
      cameraFreshFps: 20
    },
    previousSample,
    sources,
    sceneRevision: 42,
    targetFps: 30,
    sourceCadence: negotiatedCadence
  })
  assert.ok(highRateDecay.some((failure) => failure.includes('camera capture callback cadence')))
  assert.ok(highRateDecay.some((failure) => failure.includes('camera publication cadence')))
  assert.ok(
    !highRateDecay.some((failure) => failure.includes('camera compositor-fresh serve cadence'))
  )
})

test('real-source gate rejects one post-readiness loss of shipping IOSurface backing', () => {
  const healthy = evidenceSample(1_000)
  const lostCameraBacking = evidenceSample(2_000, {
    cameraSurfaceLiveCount: 0,
    cameraSurfaceEstimatedBytes: 0
  })
  assert.deepEqual(realSourceSurfaceBackingFailures(healthy), [])
  assert.ok(
    realSourceSurfaceBackingFailures(lostCameraBacking).some((failure) =>
      failure.includes('camera sample does not retain positive shipping IOSurface evidence')
    )
  )

  const result = evaluateCaptureDecayEvidence({
    samples: [healthy, lostCameraBacking],
    plannedDurationMs: 2_000,
    sampleIntervalMs: 1_000,
    activeSurfaceBaseline: { camera: { liveCount: 2 }, screen: { liveCount: 3 } },
    requireNativePreview: true,
    requirePositiveSourceSurfaces: true,
    gates: evidenceGates()
  })
  assert.ok(
    result.failures.some(
      (failure) => failure.includes('failed at sample 2') && failure.includes('camera sample')
    )
  )
  assert.equal(result.summary.sourceSurfaceFailureSamples, 1)
})

test('recovery evidence catches transient normal-soak recovery and enforces injected timing', () => {
  const idle = captureRecoveryObservation({ revision: 0, phase: 'idle', attempts: 0 }, 1_000, 'rpc')
  const degraded = recoveryObservation('degraded', 2_000)
  const restarting = recoveryObservation('restarting', 2_100)
  const verifying = recoveryObservation('verifying', 2_500)
  const recovered = recoveryObservation('recovered', 3_800, { lastDurationMs: 1_800 })
  const returnedIdle = captureRecoveryObservation(
    { revision: 5, phase: 'idle', attempts: 0 },
    4_000,
    'rpc'
  )
  assert.ok(
    evaluateCaptureRecoveryEvidence({
      observations: [idle, degraded, restarting, verifying, recovered, returnedIdle]
    }).failures.some((failure) => failure.includes('unexpected capture recovery'))
  )
  assert.deepEqual(
    evaluateCaptureRecoveryEvidence({
      observations: [degraded, restarting, verifying, recovered],
      expectedRecovery: true,
      faultArmedAtMs: 1_500,
      armedSourceGeneration: 7,
      maximumDetectionMs: 6_000,
      maximumRecoveryDurationMs: 4_000
    }).failures,
    []
  )
  assert.ok(
    evaluateCaptureRecoveryEvidence({
      observations: [
        recoveryObservation('degraded', 8_000),
        recoveryObservation('restarting', 8_100),
        recoveryObservation('verifying', 8_500),
        recoveryObservation('recovered', 9_000)
      ],
      expectedRecovery: true,
      faultArmedAtMs: 1_000,
      armedSourceGeneration: 7
    }).failures.some((failure) => failure.includes('detection took'))
  )
})

test('recovery evidence accepts screen-delivery auto-heal and rejects a mixed source scope', () => {
  const screenFlow = recoveryFlow({
    degraded: { stage: 'screen-delivery', source: 'screen' },
    restarting: { stage: 'screen-delivery', source: 'screen' },
    verifying: { stage: 'screen-delivery', source: 'screen' },
    recovered: { stage: 'screen-delivery', source: 'screen' }
  })
  assert.deepEqual(
    evaluateCaptureRecoveryEvidence({
      observations: screenFlow,
      expectedRecovery: true,
      expectedRecoveryStage: 'screen-delivery',
      expectedRecoverySource: 'screen',
      faultArmedAtMs: 1_500,
      armedSourceGeneration: 7
    }).failures,
    []
  )

  const mixedScope = screenFlow.map((observation, index) =>
    index === 2 ? { ...observation, source: 'camera' } : observation
  )
  assert.ok(
    evaluateCaptureRecoveryEvidence({
      observations: mixedScope,
      expectedRecovery: true,
      expectedRecoveryStage: 'screen-delivery',
      expectedRecoverySource: 'screen',
      faultArmedAtMs: 1_500,
      armedSourceGeneration: 7
    }).failures.some((failure) => failure.includes('instead of screen-delivery/screen'))
  )
})

test('dual real-source recovery evidence binds camera then screen to one analyzed recording', () => {
  const evidence = dualRecoveryRecordingEvidence()
  assert.deepEqual(evaluateDualCaptureRecoveryRecordingEvidence(evidence).failures, [])

  const wrongSession = structuredClone(evidence)
  wrongSession.recording.observations[2].sessionId = 'replacement-session'
  assert.ok(
    evaluateDualCaptureRecoveryRecordingEvidence(wrongSession).failures.some((failure) =>
      failure.includes('same recording session')
    )
  )

  const reordered = structuredClone(evidence)
  reordered.screen.armedAtMs = reordered.camera.completedAtMs - 1
  assert.ok(
    evaluateDualCaptureRecoveryRecordingEvidence(reordered).failures.some((failure) =>
      failure.includes('camera recovery returned to idle before screen injection')
    )
  )

  const badArtifact = structuredClone(evidence)
  badArtifact.recording.outputPath = '/tmp/capture-recovery.mkv'
  badArtifact.recording.analyzer.avSyncPass = false
  assert.ok(
    evaluateDualCaptureRecoveryRecordingEvidence(badArtifact).failures.some((failure) =>
      failure.includes('finalized MP4')
    )
  )
  assert.ok(
    evaluateDualCaptureRecoveryRecordingEvidence(badArtifact).failures.some((failure) =>
      failure.includes('A/V')
    )
  )

  const changedIdentity = structuredClone(evidence)
  changedIdentity.screen.identity.backendProcessId += 1
  assert.ok(
    evaluateDualCaptureRecoveryRecordingEvidence(changedIdentity).failures.some((failure) =>
      failure.includes('shared app/backend/session identity')
    )
  )

  const unhashedArtifact = structuredClone(evidence)
  unhashedArtifact.recording.artifact.sha256 = 'not-a-sha256'
  assert.ok(
    evaluateDualCaptureRecoveryRecordingEvidence(unhashedArtifact).failures.some((failure) =>
      failure.includes('SHA-256 descriptor')
    )
  )

  const fabricatedMotionPass = structuredClone(evidence)
  fabricatedMotionPass.recording.analyzer.metrics.uniqueFrameRatio = 0.01
  assert.ok(
    evaluateDualCaptureRecoveryRecordingEvidence(fabricatedMotionPass).failures.some((failure) =>
      failure.includes('motion metrics')
    )
  )
})

test('recovery cadence restore requires three exact-generation samples at ninety percent', () => {
  const restore = recoveryCadenceRestore(8)
  assert.deepEqual(captureRecoveryCadenceRestoreFailures(restore, { expectedGeneration: 8 }), [])

  const stale = structuredClone(restore)
  stale.samples[1].sourceGeneration = 7
  assert.ok(
    captureRecoveryCadenceRestoreFailures(stale, { expectedGeneration: 8 }).some((failure) =>
      failure.includes('recovered generation 8')
    )
  )

  const slow = structuredClone(restore)
  slow.samples[2].freshServeFps = 26.9
  assert.ok(
    captureRecoveryCadenceRestoreFailures(slow, { expectedGeneration: 8 }).some((failure) =>
      failure.includes('fresh-serve cadence')
    )
  )

  for (const sampleCount of [2, 4]) {
    const wrongCount = structuredClone(restore)
    wrongCount.samples = Array.from({ length: sampleCount }, (_, index) => ({
      ...restore.samples[Math.min(index, restore.samples.length - 1)],
      observedAt: new Date(2_000 + index * 1_000).toISOString()
    }))
    assert.ok(
      captureRecoveryCadenceRestoreFailures(wrongCount, { expectedGeneration: 8 }).some((failure) =>
        failure.includes(`expected exactly 3`)
      )
    )
  }
})

test('recovery cadence sampling rejects a generation superseded mid-window', () => {
  const result = captureRecoveryCadenceSample(
    {
      source: 'camera',
      sourceGeneration: 8,
      compositorRunId: 'compositor-1',
      producerTargetFps: 30,
      compositorTargetFps: 30,
      captureCallbackCount: 100,
      frameStorePublications: 100,
      freshServes: 100
    },
    {
      source: 'camera',
      sourceGeneration: 9,
      compositorRunId: 'compositor-1',
      producerTargetFps: 30,
      compositorTargetFps: 30,
      captureCallbackCount: 130,
      frameStorePublications: 130,
      freshServes: 130
    },
    {
      source: 'camera',
      expectedGeneration: 8,
      previousObservedAtMs: 1_000,
      observedAtMs: 2_000
    }
  )

  assert.ok(result.failures.some((failure) => failure.includes('superseded')))
  assert.equal(result.sample.sourceGeneration, 9)
})

test('recovery cadence uses generation-bound targets instead of a slow observed baseline', () => {
  const result = captureRecoveryCadenceSample(
    {
      source: 'screen',
      sourceGeneration: 8,
      compositorRunId: 'compositor-1',
      producerTargetFps: 30,
      compositorTargetFps: 30,
      captureCallbackCount: 100,
      frameStorePublications: 100,
      freshServes: 100
    },
    {
      source: 'screen',
      sourceGeneration: 8,
      compositorRunId: 'compositor-1',
      producerTargetFps: 30,
      compositorTargetFps: 30,
      captureCallbackCount: 118,
      frameStorePublications: 118,
      freshServes: 118
    },
    {
      source: 'screen',
      expectedGeneration: 8,
      previousObservedAtMs: 1_000,
      observedAtMs: 2_000
    }
  )

  assert.deepEqual(result.failures, [])
  assert.equal(result.sample.expectedProducerFps, 30)
  assert.equal(result.sample.expectedConsumerFps, 30)
  const restore = {
    minimumRateFraction: 0.9,
    requiredConsecutiveSamples: 3,
    samples: Array.from({ length: 3 }, (_, index) => ({
      ...result.sample,
      observedAt: new Date(2_000 + index * 1_000).toISOString()
    }))
  }
  assert.ok(
    captureRecoveryCadenceRestoreFailures(restore, { expectedGeneration: 8 }).some((failure) =>
      failure.includes('18.0fps is below 90.0% of 30.0fps')
    )
  )
})

test('expected recovery evidence rejects false-pass incident shapes', () => {
  const cases = [
    {
      name: 'recovered before verifying',
      observations: [
        recoveryObservation('degraded', 2_000),
        recoveryObservation('restarting', 2_100),
        recoveryObservation('recovered', 2_500),
        recoveryObservation('verifying', 3_000)
      ],
      failure: 'ordered degraded/restarting -> verifying -> recovered'
    },
    {
      name: 'manual retry contamination',
      observations: recoveryFlow({ restarting: { trigger: 'manual' } }),
      failure: 'manual trigger'
    },
    {
      name: 'failed phase contamination',
      observations: [
        recoveryObservation('degraded', 2_000),
        recoveryObservation('restarting', 2_100),
        recoveryObservation('failed', 2_300),
        recoveryObservation('verifying', 2_500),
        recoveryObservation('recovered', 3_000)
      ],
      failure: 'entered the failed phase'
    },
    {
      name: 'second automatic attempt',
      observations: recoveryFlow({ verifying: { attempts: 2 } }),
      failure: 'attempts high-water was 2'
    },
    {
      name: 'generation did not advance',
      observations: recoveryFlow({
        verifying: { sourceGeneration: 7 },
        recovered: { sourceGeneration: 7 }
      }),
      failure: 'source generation did not advance'
    },
    {
      name: 'wrong recovery scope',
      observations: recoveryFlow({ verifying: { stage: 'compositor-render' } }),
      failure: 'instead of camera-delivery/camera'
    },
    {
      name: 'missing old generation',
      observations: recoveryFlow({
        degraded: { sourceGeneration: undefined },
        restarting: { sourceGeneration: undefined }
      }),
      failure: 'old-generation evidence is incomplete'
    },
    {
      name: 'missing verifying generation',
      observations: recoveryFlow({ verifying: { sourceGeneration: undefined } }),
      failure: 'verifying-generation evidence is incomplete'
    },
    {
      name: 'missing recovered generation',
      observations: recoveryFlow({ recovered: { sourceGeneration: undefined } }),
      failure: 'recovered-generation evidence is incomplete'
    },
    {
      name: 'zero old generation',
      observations: recoveryFlow({
        degraded: { sourceGeneration: 0 },
        restarting: { sourceGeneration: 0 }
      }),
      failure: 'old-generation evidence is incomplete'
    },
    {
      name: 'fractional verifying generation',
      observations: recoveryFlow({ verifying: { sourceGeneration: 8.5 } }),
      failure: 'verifying-generation evidence is incomplete'
    },
    {
      name: 'unsafe recovered generation',
      observations: recoveryFlow({ recovered: { sourceGeneration: Number.MAX_SAFE_INTEGER + 1 } }),
      failure: 'recovered-generation evidence is incomplete'
    },
    {
      name: 'arm generation mismatch',
      observations: recoveryFlow({
        degraded: { sourceGeneration: 6 },
        restarting: { sourceGeneration: 6 }
      }),
      failure: 'did not match armed generation'
    },
    {
      name: 'same revision conflicting payload',
      observations: recoveryFlow({ recovered: { revision: 3 } }),
      failure: 'revision 3 had conflicting payloads'
    }
  ]

  for (const entry of cases) {
    const failures = evaluateCaptureRecoveryEvidence({
      observations: entry.observations,
      expectedRecovery: true,
      faultArmedAtMs: 1_500,
      armedSourceGeneration: 7
    }).failures
    assert.ok(
      failures.some((failure) => failure.includes(entry.failure)),
      `${entry.name} should fail with ${entry.failure}: ${failures.join('; ')}`
    )
  }
})

test('recovery evidence ignores a slow older RPC after a newer event revision', () => {
  const flow = recoveryFlow()
  const observations = [flow[0], flow[1], flow[2], flow[0], flow[3]]
  assert.deepEqual(
    evaluateCaptureRecoveryEvidence({
      observations,
      expectedRecovery: true,
      faultArmedAtMs: 1_500,
      armedSourceGeneration: 7
    }).failures,
    []
  )
})

test('natural recovery injection requires a complete successful arm acknowledgement', () => {
  assert.deepEqual(
    captureRecoveryArmFailures({
      armed: true,
      faultId: 3,
      sourceGeneration: 7,
      message: 'Generation-bound producer stall armed.'
    }),
    []
  )
  const failures = captureRecoveryArmFailures({
    armed: false,
    faultId: Number.NaN,
    sourceGeneration: null,
    message: ''
  })
  assert.equal(failures.length, 4)
  for (const sourceGeneration of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.ok(
      captureRecoveryArmFailures({
        armed: true,
        faultId: 3,
        sourceGeneration,
        message: 'armed'
      }).some((failure) => failure.includes('positive safe integer'))
    )
  }
})

test('synthetic isolation rejects real-source progress and low compositor cadence', () => {
  const before = diagnostics()
  assert.deepEqual(
    syntheticIsolationFailures({
      before,
      after: diagnostics(),
      cameraStatus: { state: 'device-missing' },
      screenStatus: { state: 'source-missing' }
    }),
    []
  )

  const failures = syntheticIsolationFailures({
    before,
    after: diagnostics({ previewScreenCaptureCallbackCount: 1, renderFps: 5 }),
    cameraStatus: { state: 'live', cameraId: 'real-camera' },
    screenStatus: { state: 'live', sourceId: 'real-screen' }
  })
  assert.ok(failures.some((failure) => failure.includes('real camera')))
  assert.ok(failures.some((failure) => failure.includes('real screen')))
  assert.ok(failures.some((failure) => failure.includes('screen capture callbacks advanced')))
  assert.ok(failures.some((failure) => failure.includes('render cadence')))
})

test('render cadence requires finite target and at least 60 percent of target', () => {
  assert.deepEqual(renderCadenceFailures({ targetFps: 30, renderFps: 18 }), [])
  assert.equal(renderCadenceFailures({ targetFps: 30, renderFps: 17.9 }).length, 1)
  assert.equal(renderCadenceFailures({ targetFps: null, renderFps: 30 }).length, 1)
})

test('idle preview cadence uses preview target without inventing an active session target', () => {
  const idlePreview = { targetFps: null, previewTargetFps: 30, renderFps: 29.8 }

  assert.equal(effectiveCompositorTargetFps(idlePreview), 30)
  assert.deepEqual(renderCadenceFailures(idlePreview), [])
  assert.equal(
    createCaptureDecaySample({
      stats: idlePreview,
      nowMs: 1_000,
      startedAtMs: 0
    }).targetFps,
    30
  )
})

test('active session target takes precedence over a lower preview target', () => {
  const activeSession = { targetFps: 60, previewTargetFps: 30, renderFps: 35 }

  assert.equal(effectiveCompositorTargetFps(activeSession), 60)
  assert.ok(renderCadenceFailures(activeSession).some((failure) => failure.includes('36.0fps')))
})

test('native preview preflight requires matching live CAMetalLayer identity and finite latency', () => {
  const stats = diagnostics({
    previewTransport: 'native-surface',
    previewSurfaceBacking: 'cametal-layer',
    previewFrameAgeMs: 12,
    previewInputToPresentLatencyP95Ms: 28,
    previewPresentFps: 30
  })
  const surfaceStatus = {
    state: 'live',
    transport: 'native-surface',
    backing: 'cametal-layer'
  }
  assert.deepEqual(nativePreviewFailures({ stats, surfaceStatus, requireNative: true }), [])

  const failures = nativePreviewFailures({
    stats: { ...stats, previewInputToPresentLatencyP95Ms: Number.NaN },
    surfaceStatus: { ...surfaceStatus, backing: 'none' },
    requireNative: true
  })
  assert.ok(failures.some((failure) => failure.includes('expected cametal-layer')))
  assert.ok(failures.some((failure) => failure.includes('input-to-present p95')))
})

test('native preview release oracle requires sustained presenter advancement and bounded age', () => {
  const surfaceStatus = {
    state: 'live',
    transport: 'native-surface',
    backing: 'cametal-layer'
  }
  const stats = diagnostics({
    previewTransport: 'native-surface',
    previewSurfaceBacking: 'cametal-layer',
    previewFrameAgeMs: 250,
    previewInputToPresentLatencyP95Ms: 28,
    previewPresentFps: 30
  })
  const options = {
    surfaceStatus,
    requireNative: true,
    requirePresenterAdvancement: true,
    minimumPresentFps: 1,
    maximumFrameAgeMs: 1_000,
    maximumLatencyP95Ms: 1_000
  }

  assert.deepEqual(nativePreviewFailures({ stats, ...options }), [])

  const stopped = nativePreviewFailures({
    stats: {
      ...stats,
      previewPresentFps: 0,
      previewFrameAgeMs: 1_001,
      previewInputToPresentLatencyP95Ms: 1_001
    },
    ...options
  })
  assert.ok(stopped.some((failure) => failure.includes('presenter cadence')))
  assert.ok(stopped.some((failure) => failure.includes('expected at most 1000ms')))
  assert.ok(stopped.some((failure) => failure.includes('input-to-present p95 is 1001ms')))
})

test('evidence gate enforces sample coverage, maximum gap, and native latency coverage', () => {
  const gates = evidenceGates({ minimumSampleCoverage: 1, maximumSampleGapMs: 2_500 })
  const baseline = { camera: { liveCount: 2 }, screen: { liveCount: 3 } }
  const healthy = [2_000, 4_000, 6_000].map((elapsedMs) =>
    evidenceSample(elapsedMs, {
      cameraSurfaceLiveCount: 2,
      cameraSurfacePeakCount: 3,
      screenSurfaceLiveCount: 3,
      screenSurfacePeakCount: 4
    })
  )
  assert.deepEqual(
    evaluateCaptureDecayEvidence({
      samples: healthy,
      plannedDurationMs: 6_000,
      sampleIntervalMs: 2_000,
      activeSurfaceBaseline: baseline,
      requireNativePreview: true,
      gates
    }).failures,
    []
  )

  const broken = [healthy[0], evidenceSample(6_000, { previewInputToPresentLatencyP95Ms: null })]
  const result = evaluateCaptureDecayEvidence({
    samples: broken,
    plannedDurationMs: 6_000,
    sampleIntervalMs: 2_000,
    activeSurfaceBaseline: baseline,
    requireNativePreview: true,
    gates
  })
  assert.ok(result.failures.some((failure) => failure.includes('sample coverage')))
  assert.ok(result.failures.some((failure) => failure.includes('maximum sample gap')))
  assert.ok(result.failures.some((failure) => failure.includes('native preview identity/latency')))
})

test('idle release evidence rejects a CPU compositor fallback in any sample', () => {
  const samples = [
    evidenceSample(2_000),
    evidenceSample(4_000, { compositorBackend: 'cpu-fallback' }),
    evidenceSample(6_000)
  ]
  const result = evaluateCaptureDecayEvidence({
    samples,
    plannedDurationMs: 6_000,
    sampleIntervalMs: 2_000,
    activeSurfaceBaseline: { camera: { liveCount: 2 }, screen: { liveCount: 3 } },
    gates: evidenceGates({
      requireMetalCompositor: true,
      minimumSampleCoverage: 1,
      maximumSampleGapMs: 2_500
    })
  })

  assert.ok(
    result.failures.some(
      (failure) =>
        failure.includes('Metal compositor') &&
        failure.includes('sample 2') &&
        failure.includes('cpu-fallback')
    )
  )
})

test('retention oracle exposes four keyed points and cannot pass missing or over-ceiling evidence', () => {
  const samples = [2_000, 4_000, 6_000].map((elapsedMs) => evidenceSample(elapsedMs))
  const options = {
    plannedDurationMs: 6_000,
    sampleIntervalMs: 2_000,
    activeSurfaceBaseline: { camera: { liveCount: 2 }, screen: { liveCount: 3 } },
    requireNativePreview: true,
    gates: evidenceGates({
      requireMetalCompositor: true,
      minimumSampleCoverage: 1,
      maximumSampleGapMs: 2_500
    })
  }
  const healthy = evaluateCaptureDecayEvidence({ samples, ...options })
  assert.deepEqual(healthy.failures, [])
  assert.deepEqual(Object.keys(healthy.summary.retentionPoints), [
    'metalCaptureSourceImports',
    'metalTargetRingSlots',
    'encoderInflightTargetRefs',
    'nativePreviewPresenterImports'
  ])
  for (const point of Object.values(healthy.summary.retentionPoints)) {
    assert.equal(Number.isFinite(point.liveCount), true)
    assert.equal(Number.isFinite(point.peakCount), true)
    assert.equal(Number.isFinite(point.ceiling), true)
    assert.equal(Number.isFinite(point.slopePerMinute), true)
    assert.equal(point.withinCeiling, true)
  }

  const missing = evaluateCaptureDecayEvidence({
    samples: samples.map((sample) => ({
      ...sample,
      nativePreviewIosurfaceImportLiveCount: null,
      nativePreviewIosurfaceImportPeakCount: null,
      nativePreviewIosurfaceImportCeiling: null
    })),
    ...options
  })
  assert.ok(
    missing.failures.some((failure) =>
      failure.includes(
        'native-preview presenter cached IOSurface imports retention evidence coverage'
      )
    )
  )

  const overCeiling = evaluateCaptureDecayEvidence({
    samples: samples.map((sample) => ({
      ...sample,
      compositorMetalTargetRingSlotsLiveCount: 6,
      compositorMetalTargetRingSlotsPeakCount: 6,
      compositorMetalTargetRingSlotsCeiling: 5
    })),
    ...options
  })
  assert.ok(overCeiling.failures.some((failure) => failure.includes('reported ceiling')))
})

test('retention teardown requires all four lifetimes to reach zero', () => {
  const stats = diagnostics({
    compositorMetalCachedCaptureSourceImportsLiveCount: 0,
    compositorMetalCachedCaptureSourceImportsPeakCount: 2,
    compositorMetalCachedCaptureSourceImportsCeiling: 2,
    compositorMetalTargetRingSlotsLiveCount: 0,
    compositorMetalTargetRingSlotsPeakCount: 5,
    compositorMetalTargetRingSlotsCeiling: 5,
    encoderBridgeMetalTargetRefsInFlightLiveCount: 0,
    encoderBridgeMetalTargetRefsInFlightPeakCount: 2,
    encoderBridgeMetalTargetRefsInFlightCeiling: 5
  })
  const surfaceStatus = {
    nativePreviewIosurfaceImportLiveCount: 0,
    nativePreviewIosurfaceImportPeakCount: 3,
    nativePreviewIosurfaceImportCeiling: 3
  }
  assert.deepEqual(retentionTeardownFailures(stats, surfaceStatus), [])
  assert.equal(nativeRetentionSnapshot(stats, surfaceStatus).metalTargetRingSlots.liveCount, 0)
  assert.ok(
    retentionTeardownFailures(stats, {
      ...surfaceStatus,
      nativePreviewIosurfaceImportLiveCount: 1
    }).some((failure) => failure.includes('retained 1 object'))
  )
})

test('reconfiguration timeline correlates size and invalidation changes with retention', () => {
  const samples = [
    evidenceSample(1_000, {
      compositorWidth: 1280,
      compositorHeight: 720,
      compositorMetalTargetWidth: 1280,
      compositorMetalTargetHeight: 720,
      nativePreviewDrawableWidth: 1920,
      nativePreviewDrawableHeight: 1080,
      nativePreviewIosurfaceInvalidations: 0
    }),
    evidenceSample(2_000, {
      compositorWidth: 1280,
      compositorHeight: 720,
      compositorMetalTargetWidth: 1280,
      compositorMetalTargetHeight: 720,
      nativePreviewDrawableWidth: 1920,
      nativePreviewDrawableHeight: 1080,
      nativePreviewIosurfaceInvalidations: 0
    }),
    evidenceSample(3_000, {
      compositorWidth: 3840,
      compositorHeight: 2160,
      compositorMetalTargetWidth: 3840,
      compositorMetalTargetHeight: 2160,
      nativePreviewDrawableWidth: 2560,
      nativePreviewDrawableHeight: 1440,
      nativePreviewIosurfaceInvalidations: 1,
      nativePreviewIosurfaceImportPeakCount: 3
    })
  ]
  const timeline = retentionReconfigurationTimeline(samples)
  assert.equal(timeline.length, 2)
  assert.equal(timeline[0].index, 0)
  assert.equal(timeline[1].index, 2)
  assert.equal(timeline[1].compositorMetalTargetWidth, 3840)
  assert.equal(timeline[1].nativePreviewIosurfaceInvalidations, 1)
  assert.equal(timeline[1].retentionPoints.nativePreviewPresenterImports.peakCount, 3)
})

test('surface gates enforce ceilings, positive slope, and active-baseline growth', () => {
  const samples = [0, 1, 2, 3].map((minute, index) =>
    evidenceSample((minute + 1) * 60_000, {
      cameraSurfaceLiveCount: index + 2,
      cameraSurfacePeakCount: index + 3,
      screenSurfaceLiveCount: 3,
      screenSurfacePeakCount: 4
    })
  )
  const result = evaluateCaptureDecayEvidence({
    samples,
    plannedDurationMs: 4 * 60_000,
    sampleIntervalMs: 60_000,
    activeSurfaceBaseline: { camera: { liveCount: 2 }, screen: { liveCount: 3 } },
    gates: evidenceGates({
      maximumSampleGapMs: 61_000,
      maximumSurfaceLiveCount: 4,
      maximumSurfacePeakCount: 5,
      maximumSurfaceSlopePerMinute: 0.1,
      surfaceSlopeMinimumMinutes: 2,
      surfaceGrowthAllowance: 1
    })
  })
  assert.ok(result.failures.some((failure) => failure.includes('live-count ceiling')))
  assert.ok(result.failures.some((failure) => failure.includes('peak-count ceiling')))
  assert.ok(result.failures.some((failure) => failure.includes('live-count slope')))
  assert.ok(result.failures.some((failure) => failure.includes('active baseline')))
  assert.equal(result.summary.surfaces.camera.slopeEvaluated, true)
})

test('surface coverage is measured against scheduled samples, not collected samples', () => {
  const samples = Array.from({ length: 95 }, (_, index) =>
    evidenceSample((index + 1) * 1_000, {
      ...(index < 91
        ? {}
        : {
            cameraSurfaceLiveCount: null,
            cameraSurfacePeakCount: null,
            screenSurfaceLiveCount: null,
            screenSurfacePeakCount: null
          })
    })
  )
  const result = evaluateCaptureDecayEvidence({
    samples,
    plannedDurationMs: 100_000,
    sampleIntervalMs: 1_000,
    activeSurfaceBaseline: { camera: { liveCount: 2 }, screen: { liveCount: 3 } },
    gates: evidenceGates({ maximumSampleGapMs: 6_000 })
  })
  assert.equal(result.summary.samplesCollected, 95)
  assert.ok(
    result.failures.some((failure) =>
      failure.includes('surface evidence coverage 91/100 scheduled samples')
    )
  )
})

test('surface release comparison requires camera and screen to return to baseline', () => {
  const baseline = sourceSurfaceSnapshot(diagnostics())
  assert.deepEqual(surfaceReturnFailures(diagnostics(), baseline), [])
  assert.ok(
    surfaceReturnFailures(
      diagnostics({
        previewCameraSurfaceBacking: {
          liveCount: 1,
          peakCount: 2,
          estimatedBytes: 1,
          peakEstimatedBytes: 2
        }
      }),
      baseline
    ).some((failure) => failure.includes('camera surface live count'))
  )
})

test('investigation gate defaults to two-second samples and stays env-overridable', () => {
  assert.deepEqual(captureDecaySoakConfig({ argv: ['--gate'] }), {
    gate: true,
    recoveryGate: false,
    releaseGate: false,
    forceSynthetic: false,
    realSources: false,
    soakMinutes: 60,
    sampleSeconds: 2,
    launchTimeoutMs: 420_000,
    rpcTimeoutMs: 5_000,
    sourceReadyTimeoutMs: 90_000,
    sourceReadyPollMs: 2_000,
    sourceReadyConsecutivePolls: 3,
    surfaceReleaseTimeoutMs: 10_000,
    realSourceFailureConsecutiveSamples: 3,
    maximumRecoveryDurationMs: 4_000,
    maximumRecoveryDetectionMs: 6_000,
    recoveryRecordingMs: 60_000,
    evidenceGates: evidenceGates(),
    video: {
      preset: 'custom',
      width: 1280,
      height: 720,
      fps: 30,
      bitrateKbps: 4_000
    }
  })
  assert.equal(
    captureDecaySoakConfig({
      argv: ['--gate'],
      env: { VIDEORC_SOAK_MINUTES: '0.5', VIDEORC_SOAK_SAMPLE_SECONDS: '0.25' }
    }).soakMinutes,
    0.5
  )
  const quick = captureDecaySoakConfig({
    argv: ['--gate'],
    env: {
      VIDEORC_SOAK_MINUTES: '1',
      VIDEORC_SOAK_SAMPLE_SECONDS: '1',
      VIDEORC_SOAK_SURFACE_SLOPE_MINIMUM_MINUTES: '0',
      VIDEORC_SOAK_REQUIRE_METAL_COMPOSITOR: '1'
    }
  })
  assert.equal(quick.sampleSeconds, 1)
  assert.equal(quick.evidenceGates.maximumSampleGapMs, 3_000)
  assert.equal(quick.evidenceGates.surfaceSlopeMinimumMinutes, 0)
  assert.equal(quick.evidenceGates.requireMetalCompositor, true)
  assert.equal(
    captureDecaySoakConfig({
      argv: ['--synthetic'],
      env: { VIDEORC_SOAK_REAL_SOURCES: '1' }
    }).realSources,
    false
  )
  assert.equal(captureDecaySoakConfig({ argv: ['--recovery-gate'] }).soakMinutes, 1)
  assert.throws(
    () => captureDecaySoakConfig({ env: { VIDEORC_SOAK_MINUTES: 'NaN' } }),
    /positive finite number/
  )
})

test('release soak and long-recording configs reject evidence-shaping overrides', () => {
  const release = captureDecaySoakConfig({
    argv: ['--release-gate', '--gate', '--synthetic']
  })
  assert.equal(release.releaseGate, true)
  assert.equal(release.soakMinutes, 60)
  assert.equal(release.sampleSeconds, 2)
  assert.equal(release.launchTimeoutMs, 420_000)
  assert.equal(release.rpcTimeoutMs, 5_000)
  assert.equal(release.evidenceGates.requireNativePreview, true)
  assert.equal(release.evidenceGates.requirePresenterAdvancement, true)
  assert.equal(release.evidenceGates.requireMetalCompositor, true)
  assert.equal(release.evidenceGates.minimumPreviewPresentFps, 1)
  assert.equal(release.evidenceGates.maximumPreviewFrameAgeMs, 1_000)
  assert.equal(release.evidenceGates.maximumPreviewLatencyP95Ms, 1_000)
  assert.throws(
    () =>
      captureDecaySoakConfig({
        argv: ['--release-gate', '--gate', '--synthetic'],
        env: { VIDEORC_SOAK_MINUTES: '1' }
      }),
    /locks VIDEORC_SOAK_MINUTES=60/
  )
  assert.throws(
    () => captureDecaySoakConfig({ argv: ['--release-gate', '--gate'] }),
    /requires --gate --synthetic/
  )
  for (const [name, value] of [
    ['VIDEORC_NATIVE_PREVIEW_SURFACE', '0'],
    ['VIDEORC_DISABLE_AUTO_PREVIEW', '0'],
    ['VIDEORC_METAL_COMPOSITOR', '0'],
    ['VIDEORC_SOAK_REQUIRE_NATIVE_PREVIEW', '0'],
    ['VIDEORC_SOAK_REQUIRE_PRESENTER_ADVANCEMENT', '0'],
    ['VIDEORC_SOAK_REQUIRE_METAL_COMPOSITOR', '0'],
    ['VIDEORC_SOAK_MIN_PREVIEW_PRESENT_FPS', '0.1'],
    ['VIDEORC_SOAK_MAX_PREVIEW_FRAME_AGE_MS', '5000'],
    ['VIDEORC_SOAK_MAX_PREVIEW_LATENCY_P95_MS', '5000']
  ]) {
    assert.throws(
      () =>
        captureDecaySoakConfig({
          argv: ['--release-gate', '--gate', '--synthetic'],
          env: { [name]: value }
        }),
      new RegExp(`locks ${name}=`)
    )
  }

  const longRelease = longRecordingGateConfig({ argv: ['--release-gate'] })
  assert.equal(longRelease.releaseGate, true)
  assert.equal(longRelease.recordingMs, 900_000)
  assert.equal(longRelease.childEnvironment.VIDEORC_DECAY_STATUS_POLL_MS, '2000')
  assert.equal(
    longRelease.childEnvironment.VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT,
    'videotoolbox-h264-mpegts'
  )
  assert.equal(longRelease.childEnvironment.VIDEORC_ENCODER_BRIDGE, '1')
  assert.equal(longRelease.childEnvironment.VIDEORC_RECORDING_ENCODER_BRIDGE, '1')
  assert.equal(longRelease.childEnvironment.VIDEORC_NATIVE_PREVIEW_SURFACE, '1')
  assert.equal(longRelease.childEnvironment.VIDEORC_DISABLE_AUTO_PREVIEW, '0')
  assert.equal(longRelease.childEnvironment.VIDEORC_METAL_COMPOSITOR, '1')
  assert.equal(longRelease.childEnvironment.VIDEORC_SOAK_REQUIRE_NATIVE_PREVIEW, '1')
  assert.equal(longRelease.childEnvironment.VIDEORC_SOAK_REQUIRE_PRESENTER_ADVANCEMENT, '1')
  assert.equal(longRelease.childEnvironment.VIDEORC_SOAK_REQUIRE_METAL_COMPOSITOR, '1')
  assert.equal(longRelease.childEnvironment.VIDEORC_SOAK_REQUIRE_RELEASE_RECORDING_PATH, '1')
  assert.throws(
    () =>
      longRecordingGateConfig({
        argv: ['--release-gate'],
        env: { VIDEORC_DECAY_MIN_RECORDING_RATIO: '0.5' }
      }),
    /locks VIDEORC_DECAY_MIN_RECORDING_RATIO=0.97/
  )
  for (const [name, value] of [
    ['VIDEORC_ENCODER_BRIDGE', '0'],
    ['VIDEORC_RECORDING_ENCODER_BRIDGE', 'legacy'],
    ['VIDEORC_ENCODER_BRIDGE_VIDEO_OUTPUT', 'raw-yuv420p'],
    ['VIDEORC_NATIVE_PREVIEW_SURFACE', '0'],
    ['VIDEORC_DISABLE_AUTO_PREVIEW', '1'],
    ['VIDEORC_METAL_COMPOSITOR', '0'],
    ['VIDEORC_SOAK_REQUIRE_NATIVE_PREVIEW', '0'],
    ['VIDEORC_SOAK_REQUIRE_PRESENTER_ADVANCEMENT', '0'],
    ['VIDEORC_SOAK_REQUIRE_METAL_COMPOSITOR', '0'],
    ['VIDEORC_SOAK_REQUIRE_RELEASE_RECORDING_PATH', '0'],
    ['VIDEORC_SOAK_MIN_PREVIEW_PRESENT_FPS', '0.1'],
    ['VIDEORC_SOAK_MAX_PREVIEW_FRAME_AGE_MS', '5000'],
    ['VIDEORC_SOAK_MAX_PREVIEW_LATENCY_P95_MS', '5000']
  ]) {
    assert.throws(
      () =>
        longRecordingGateConfig({
          argv: ['--release-gate'],
          env: { [name]: value }
        }),
      new RegExp(`locks ${name}=`)
    )
  }
})

test('long recording gate defaults to 15m, exposes 60m endurance, and preserves overrides', () => {
  assert.equal(longRecordingGateConfig().recordingMs, 15 * 60_000)
  assert.equal(longRecordingGateConfig({ argv: ['--endurance'] }).recordingMs, 60 * 60_000)
  const overridden = longRecordingGateConfig({
    argv: ['--endurance'],
    env: {
      VIDEORC_SOAK_LONG_RECORDING_MINUTES: '2',
      VIDEORC_SMOKE_TIMEOUT_MS: '456'
    }
  })
  assert.equal(overridden.recordingMs, 120_000)
  assert.equal(overridden.childEnvironment.VIDEORC_SMOKE_TIMEOUT_MS, '456')
  assert.equal(overridden.childEnvironment.VIDEORC_DECAY_SESSIONS, '1')
  assert.equal(overridden.childEnvironment.VIDEORC_DECAY_IDLE_MS, '0')
})

test('long recording gate cannot inherit extra sessions or idle gaps', () => {
  const config = longRecordingGateConfig({
    env: {
      VIDEORC_DECAY_SESSIONS: '9',
      VIDEORC_DECAY_IDLE_MS: '12345',
      VIDEORC_DECAY_REAL_SCREEN: '1',
      VIDEORC_DECAY_REAL_CAMERA: '1',
      VIDEORC_DECAY_PACKAGED_APP: '1',
      VIDEORC_SMOKE_PACKAGED_APP: '1',
      VIDEORC_PACKAGED_SMOKE_TEST: '1',
      VIDEORC_SOAK_REAL_SOURCES: '1'
    }
  })
  assert.equal(config.childEnvironment.VIDEORC_DECAY_SESSIONS, '1')
  assert.equal(config.childEnvironment.VIDEORC_DECAY_IDLE_MS, '0')
  for (const name of [
    'VIDEORC_DECAY_REAL_SCREEN',
    'VIDEORC_DECAY_REAL_CAMERA',
    'VIDEORC_DECAY_PACKAGED_APP',
    'VIDEORC_SMOKE_PACKAGED_APP',
    'VIDEORC_PACKAGED_SMOKE_TEST',
    'VIDEORC_SOAK_REAL_SOURCES'
  ]) {
    assert.equal(config.childEnvironment[name], '0')
  }
})

test('real soak defaults to 4K30 while synthetic stays at the light 720p profile', () => {
  assert.deepEqual(captureDecayVideo({}, { realSources: true }), {
    preset: 'custom',
    width: 3840,
    height: 2160,
    fps: 30,
    bitrateKbps: 30_000
  })
  assert.deepEqual(captureDecayVideo({}, { realSources: false }), {
    preset: 'custom',
    width: 1280,
    height: 720,
    fps: 30,
    bitrateKbps: 4_000
  })
})

test('long recording evidence fails early stop in active status, artifact, or accounting', () => {
  const healthy = {
    requestedDurationMs: 900_000,
    minimumRatio: 0.97,
    sessionId: 'session-1',
    statusSamples: [
      { state: 'recording', sessionId: 'session-1' },
      { state: 'recording', sessionId: 'session-1' }
    ],
    artifactDurationSeconds: 882,
    accountingElapsedMs: 882_000
  }
  assert.deepEqual(longRecordingEvidenceFailures(healthy), [])
  const failures = longRecordingEvidenceFailures({
    ...healthy,
    statusSamples: [{ state: 'idle', sessionId: 'session-1' }],
    artifactDurationSeconds: 860,
    accountingElapsedMs: 860_000
  })
  assert.ok(failures.some((failure) => failure.includes('active-state sample')))
  assert.ok(failures.some((failure) => failure.includes('artifact duration')))
  assert.ok(failures.some((failure) => failure.includes('final-accounting duration')))
})

test('long recording runtime evidence samples surfaces and fails recovery or event loss', () => {
  const samples = [2_000, 4_000, 6_000].map((elapsedMs) => evidenceSample(elapsedMs))
  const idle = captureRecoveryObservation(
    { revision: 0, phase: 'idle', retryable: false, attempts: 0 },
    2_000,
    'long-recording-rpc'
  )
  const healthy = evaluateLongRecordingRuntimeEvidence({
    samples,
    plannedDurationMs: 6_000,
    sampleIntervalMs: 2_000,
    activeSurfaceBaseline: { camera: { liveCount: 2 }, screen: { liveCount: 3 } },
    recoveryObservations: [idle],
    gates: evidenceGates({ minimumSampleCoverage: 1, maximumSampleGapMs: 2_500 })
  })
  assert.deepEqual(healthy.failures, [])

  const failed = evaluateLongRecordingRuntimeEvidence({
    samples,
    plannedDurationMs: 6_000,
    sampleIntervalMs: 2_000,
    activeSurfaceBaseline: { camera: { liveCount: 2 }, screen: { liveCount: 3 } },
    recoveryObservations: [idle, recoveryObservation('degraded', 3_000)],
    laggedEvents: [{ skipped: 2 }],
    gates: evidenceGates({ minimumSampleCoverage: 1, maximumSampleGapMs: 2_500 })
  })
  assert.ok(failed.failures.some((failure) => failure.includes('unexpected capture recovery')))
  assert.ok(failed.failures.some((failure) => failure.includes('event stream lagged')))

  const backendDegraded = evaluateLongRecordingRuntimeEvidence({
    samples: [samples[0], evidenceSample(4_000, { degradedStage: 'camera-delivery' }), samples[2]],
    plannedDurationMs: 6_000,
    sampleIntervalMs: 2_000,
    activeSurfaceBaseline: { camera: { liveCount: 2 }, screen: { liveCount: 3 } },
    recoveryObservations: [idle],
    gates: evidenceGates({ minimumSampleCoverage: 1, maximumSampleGapMs: 2_500 })
  })
  assert.ok(
    backendDegraded.failures.some((failure) =>
      failure.includes('capture health declared degraded stage camera-delivery at sample 2')
    )
  )
  assert.equal(backendDegraded.summary.capture.degradedStageFailureSamples, 1)
})

test('release long recording requires an advancing native presenter and protected Metal bridge', () => {
  const gates = evidenceGates({
    requireNativePreview: true,
    requirePresenterAdvancement: true,
    requireReleaseRecordingPath: true,
    minimumPreviewPresentFps: 1,
    maximumPreviewFrameAgeMs: 1_000,
    maximumPreviewLatencyP95Ms: 1_000,
    minimumSampleCoverage: 1,
    maximumSampleGapMs: 2_500
  })
  const samples = [2_000, 4_000, 6_000].map((elapsedMs) => evidenceSample(elapsedMs))
  const evaluate = (runtimeSamples) =>
    evaluateLongRecordingRuntimeEvidence({
      samples: runtimeSamples,
      plannedDurationMs: 6_000,
      sampleIntervalMs: 2_000,
      activeSurfaceBaseline: { camera: { liveCount: 2 }, screen: { liveCount: 3 } },
      recoveryObservations: [],
      gates
    })

  assert.deepEqual(evaluate(samples).failures, [])

  const stoppedPresenter = evaluate([
    samples[0],
    evidenceSample(4_000, {
      previewPresentFps: 0,
      previewFrameAgeMs: 1_001,
      previewInputToPresentLatencyP95Ms: 1_001
    }),
    samples[2]
  ])
  assert.ok(stoppedPresenter.failures.some((failure) => failure.includes('presenter cadence')))
  assert.ok(
    stoppedPresenter.failures.some((failure) => failure.includes('expected at most 1000ms'))
  )
  assert.ok(
    stoppedPresenter.failures.some((failure) => failure.includes('input-to-present p95 is 1001ms'))
  )

  for (const [overrides, expectedFailure] of [
    [{ previewTransport: 'none' }, 'expected native-surface'],
    [{ recordingProtected: false }, 'recordingProtected was not true'],
    [{ encoderBridgeRequestedVideoOutput: 'raw-yuv420p' }, 'requested encoder bridge output'],
    [{ encoderBridgeEffectiveVideoOutput: 'raw-yuv420p' }, 'effective encoder bridge output'],
    [{ compositorBackend: 'cpu-fallback' }, 'expected metal']
  ]) {
    const result = evaluate([samples[0], evidenceSample(4_000, overrides), samples[2]])
    assert.ok(
      result.failures.some((failure) => failure.includes(expectedFailure)),
      `missing release evidence failure: ${expectedFailure}`
    )
  }
})

test('soak orchestration wires scene, sustained source, recovery, duration, and synthetic isolation gates', () => {
  const root = join(import.meta.dirname, '..', '..')
  const soak = readFileSync(join(root, 'scripts', 'smoke-capture-decay-soak.mjs'), 'utf8')
  const sessionDecay = readFileSync(
    join(root, 'scripts', 'smoke-recording-session-decay.mjs'),
    'utf8'
  )
  const longRecording = readFileSync(
    join(root, 'scripts', 'smoke-capture-decay-long-recording.mjs'),
    'utf8'
  )
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  for (const contract of [
    'packagedSmokeCommandCapability: packagedSmokeCapability',
    'VIDEORC_SOAK_DEBUG_APP_EXECUTABLE',
    "'scene.load_from_capture_config'",
    'sceneCommitFailures({',
    'realSourceSampleFailures({',
    'realSourceSurfaceBackingFailures(sample)',
    'requirePositiveSourceSurfaces: config.realSources',
    'real-source shipping-path evidence failed',
    "message?.event === 'capture.recovery.status'",
    "message?.event === 'events.lagged'",
    "'test.captureRecovery.injectCameraDeliveryDegradation'",
    "'test.captureRecovery.injectScreenDeliveryDegradation'",
    "'session.start'",
    "'session.stop'",
    'evaluateDualCaptureRecoveryRecordingEvidence(evidence',
    'analyzeRecording(outputPath',
    'backendState: stoppedRaw.state',
    'const artifact = await captureArtifactDescriptor(outputPath)',
    'csv: await captureArtifactDescriptor(reportPath)',
    'identity: { ...identity }',
    "sequence: ['camera', 'screen']",
    "'capture.recovery.status'"
  ]) {
    assert.ok(soak.includes(contract), `missing soak orchestration contract: ${contract}`)
  }
  assert.ok(sessionDecay.includes('evaluateLongRecordingRuntimeEvidence({'))
  assert.ok(sessionDecay.includes("message?.event === 'events.lagged'"))
  assert.ok(sessionDecay.includes("backendRequest(ws, 'capture.recovery.status')"))
  assert.ok(
    sessionDecay.includes("backendRequest(ws, 'session.stop', undefined, finalizationTimeoutMs)")
  )
  assert.ok(sessionDecay.includes('timeoutMs: finalizationTimeoutMs'))
  assert.ok(sessionDecay.includes('longRecordingEvidenceFailures({'))
  assert.ok(sessionDecay.includes('screenMotionStimulusTeardownFailures('))
  assert.ok(sessionDecay.includes("join(outputDirectory, 'session-decay-teardown.json')"))
  assert.ok(sessionDecay.includes('cleanupFailures.length > 0'))
  assert.ok(longRecording.includes('assertReleaseChildEnvironment'))
  assert.ok(longRecording.includes('LONG_RECORDING_RELEASE_ENV'))
  const cleanupFinalizer = soak.slice(
    soak.indexOf('} finally {'),
    soak.indexOf('process.exitCode = exitCode')
  )
  assert.ok(cleanupFinalizer.includes('screenMotionStimulusTeardownFailures('))
  assert.ok(cleanupFinalizer.includes('processTeardownEvidence.app = (await stopApp()) ?? null'))
  assert.ok(
    cleanupFinalizer.indexOf('writeTerminalCheckpoint(terminalStatus') >
      cleanupFinalizer.indexOf('await stopApp()'),
    'idle soak must not persist PASS before app teardown completes'
  )
  for (const scriptName of ['smoke:capture-decay-soak:quick', 'smoke:capture-decay-soak:gate']) {
    const command = packageJson.scripts[scriptName]
    assert.ok(command.includes('--synthetic'))
    for (const assignment of [
      'VIDEORC_SOAK_REAL_SOURCES=0',
      'VIDEORC_DECAY_REAL_SCREEN=0',
      'VIDEORC_DECAY_REAL_CAMERA=0',
      'VIDEORC_DECAY_PACKAGED_APP=0',
      'VIDEORC_SMOKE_PACKAGED_APP=0',
      'VIDEORC_PACKAGED_SMOKE_TEST=0'
    ]) {
      assert.ok(command.includes(assignment), `${scriptName} does not scrub ${assignment}`)
    }
  }
  const releaseSoak = packageJson.scripts['smoke:capture-decay-soak:gate']
  assert.ok(releaseSoak.includes('--release-gate --gate --synthetic'))
  for (const [name, value] of Object.entries(CAPTURE_DECAY_RELEASE_ENV)) {
    assert.ok(
      releaseSoak.includes(`${name}=${value}`),
      `release soak does not lock ${name}=${value}`
    )
  }
  const releaseRecording = packageJson.scripts['smoke:capture-decay-soak:long-recording']
  assert.ok(releaseRecording.includes('--release-gate'))
  for (const [name, value] of Object.entries(LONG_RECORDING_RELEASE_ENV)) {
    assert.ok(
      releaseRecording.includes(`${name}=${value}`),
      `release recording does not lock ${name}=${value}`
    )
  }
  assert.ok(packageJson.scripts['smoke:local-gates'].includes('smoke:capture-decay-soak:contract'))
  assert.ok(packageJson.scripts['smoke:capture-decay-soak:investigate'])
  assert.ok(packageJson.scripts['smoke:capture-decay-soak:long-recording:investigate'])
})

function recoveryObservation(phase, observedAtMs, overrides = {}) {
  const beforeRestart = phase === 'degraded' || phase === 'restarting'
  const revision =
    phase === 'degraded' ? 1 : phase === 'restarting' ? 2 : phase === 'verifying' ? 3 : 4
  return captureRecoveryObservation(
    {
      revision,
      phase,
      attempts: phase === 'degraded' ? 0 : 1,
      stage: 'camera-delivery',
      source: 'camera',
      ...(phase === 'degraded' ? {} : { trigger: 'automatic' }),
      sourceGeneration: beforeRestart ? 7 : 8,
      ...overrides
    },
    observedAtMs,
    'event'
  )
}

function recoveryFlow(overrides = {}) {
  return [
    recoveryObservation('degraded', 2_000, overrides.degraded),
    recoveryObservation('restarting', 2_100, overrides.restarting),
    recoveryObservation('verifying', 2_500, overrides.verifying),
    recoveryObservation('recovered', 3_000, {
      lastDurationMs: 900,
      ...overrides.recovered
    })
  ]
}

function recoveryCadenceRestore(sourceGeneration) {
  return {
    minimumRateFraction: 0.9,
    requiredConsecutiveSamples: 3,
    samples: [4_000, 6_000, 8_000].map((observedAtMs) => ({
      observedAt: new Date(observedAtMs).toISOString(),
      sourceGeneration,
      captureCallbackFps: 30,
      publicationFps: 30,
      freshServeFps: 30,
      expectedProducerFps: 30,
      expectedConsumerFps: 30
    }))
  }
}

function dualRecoveryRecordingEvidence() {
  const identity = {
    sessionId: 'session:recovery',
    appProcessId: 100,
    backendProcessId: 101
  }
  const cameraObservations = recoveryFlow()
  const screenObservations = recoveryFlow({
    degraded: {
      revision: 6,
      stage: 'screen-delivery',
      source: 'screen',
      sourceGeneration: 11
    },
    restarting: {
      revision: 7,
      stage: 'screen-delivery',
      source: 'screen',
      sourceGeneration: 11
    },
    verifying: {
      revision: 8,
      stage: 'screen-delivery',
      source: 'screen',
      sourceGeneration: 12
    },
    recovered: {
      revision: 9,
      stage: 'screen-delivery',
      source: 'screen',
      sourceGeneration: 12
    }
  }).map((observation) => ({
    ...observation,
    observedAtMs: observation.observedAtMs + 10_000,
    observedAt: new Date(observation.observedAtMs + 10_000).toISOString()
  }))
  return {
    identity: { ...identity },
    ...identity,
    sequence: ['camera', 'screen'],
    camera: {
      identity: { ...identity },
      armedAtMs: 1_500,
      armedAt: new Date(1_500).toISOString(),
      completedAtMs: 9_000,
      completedAt: new Date(9_000).toISOString(),
      acknowledgement: {
        armed: true,
        faultId: 1,
        sourceGeneration: 7,
        message: 'camera armed'
      },
      terminalStatus: { phase: 'idle' },
      observations: cameraObservations,
      summary: {
        phases: ['degraded', 'restarting', 'verifying', 'recovered'],
        attemptsHighWater: 1,
        observedDetectionMs: 500,
        observedRecoveryMs: 1_000,
        preRestartGeneration: 7,
        verifyingGenerations: [8],
        recoveredGenerations: [8],
        cadenceRestore: recoveryCadenceRestore(8)
      }
    },
    screen: {
      identity: { ...identity },
      armedAtMs: 10_500,
      armedAt: new Date(10_500).toISOString(),
      completedAtMs: 19_000,
      completedAt: new Date(19_000).toISOString(),
      acknowledgement: {
        armed: true,
        faultId: 2,
        sourceGeneration: 11,
        message: 'screen armed'
      },
      terminalStatus: { phase: 'idle' },
      observations: screenObservations,
      summary: {
        phases: ['degraded', 'restarting', 'verifying', 'recovered'],
        attemptsHighWater: 1,
        observedDetectionMs: 1_500,
        observedRecoveryMs: 1_000,
        preRestartGeneration: 11,
        verifyingGenerations: [12],
        recoveredGenerations: [12],
        cadenceRestore: recoveryCadenceRestore(12)
      }
    },
    recording: {
      identity: { ...identity },
      started: {
        sessionId: 'session:recovery',
        appProcessId: identity.appProcessId,
        backendProcessId: identity.backendProcessId,
        state: 'recording',
        observedAt: new Date(1_000).toISOString()
      },
      observations: [
        ['camera', 'before', 1_400],
        ['camera', 'after', 9_500],
        ['screen', 'before', 10_400],
        ['screen', 'after', 19_500]
      ].map(([source, boundary, observedAtMs]) => ({
        source,
        boundary,
        sessionId: 'session:recovery',
        appProcessId: identity.appProcessId,
        backendProcessId: identity.backendProcessId,
        state: 'recording',
        observedAt: new Date(observedAtMs).toISOString()
      })),
      stopped: {
        sessionId: 'session:recovery',
        state: 'stopped',
        backendState: 'idle',
        observedAt: new Date(62_000).toISOString()
      },
      normalStop: true,
      requestedDurationMs: 60_000,
      observedDurationMs: 61_000,
      outputPath: '/tmp/capture-recovery.mp4',
      artifact: {
        path: '/tmp/capture-recovery.mp4',
        sha256: 'a'.repeat(64),
        sizeBytes: 1_000_000
      },
      artifactSha256: 'a'.repeat(64),
      artifactBytes: 1_000_000,
      analyzer: {
        verdict: 'passed',
        artifactDurationSeconds: 60,
        motionPass: true,
        freezePass: true,
        audioPass: true,
        avSyncPass: true,
        metrics: {
          uniqueFrameRatio: 0.95,
          longestCorroboratedFreezeMs: 0,
          maxRepeatedFrameRun: 1,
          maxAudioGapMs: 0,
          avSkewMs: 10,
          tailMismatchMs: 10
        },
        gates: {
          minUniqueFrameRatio: 0.05,
          maxFreezeMs: 250,
          maxRepeatedFrameRun: 2,
          maxAudioGapMs: 20,
          avSyncHardFailMs: 150,
          maxTailMismatchMs: 150
        }
      }
    }
  }
}

function diagnostics(overrides = {}) {
  return {
    targetFps: 30,
    renderFps: 30,
    previewCameraCaptureCallbackCount: 0,
    previewCameraDidDropCallbackCount: 0,
    previewCameraDropReasons: { outOfBuffers: 0 },
    previewCameraFrameStorePublications: 0,
    compositorCameraSourceFreshServes: 0,
    compositorCameraSourceHeldServes: 0,
    previewScreenCaptureCallbackCount: 0,
    previewScreenFrameStorePublications: 0,
    compositorScreenSourceFreshServes: 0,
    compositorScreenSourceHeldServes: 0,
    previewCameraSurfaceBacking: {
      liveCount: 0,
      peakCount: 0,
      estimatedBytes: 0,
      peakEstimatedBytes: 0
    },
    previewScreenSurfaceBacking: {
      liveCount: 0,
      peakCount: 0,
      estimatedBytes: 0,
      peakEstimatedBytes: 0
    },
    ...overrides
  }
}

function evidenceSample(elapsedMs, overrides = {}) {
  return {
    elapsedMs,
    previewSurfaceState: 'live',
    previewStatusTransport: 'native-surface',
    previewStatusBacking: 'cametal-layer',
    previewTransport: 'native-surface',
    previewSurfaceBacking: 'cametal-layer',
    previewFrameAgeMs: 10,
    previewInputToPresentLatencyP95Ms: 20,
    previewPresentFps: 30,
    recordingProtected: true,
    encoderBridgeRequestedVideoOutput: 'videotoolbox-h264-mpegts',
    encoderBridgeEffectiveVideoOutput: 'videotoolbox-h264-mpegts',
    compositorBackend: 'metal',
    compositorWidth: 1280,
    compositorHeight: 720,
    compositorMetalTargetWidth: 1280,
    compositorMetalTargetHeight: 720,
    nativePreviewDrawableWidth: 1920,
    nativePreviewDrawableHeight: 1080,
    nativePreviewIosurfaceInvalidations: 0,
    compositorMetalCachedCaptureSourceImportsLiveCount: 2,
    compositorMetalCachedCaptureSourceImportsPeakCount: 2,
    compositorMetalCachedCaptureSourceImportsCeiling: 2,
    compositorMetalTargetRingSlotsLiveCount: 3,
    compositorMetalTargetRingSlotsPeakCount: 3,
    compositorMetalTargetRingSlotsCeiling: 5,
    encoderBridgeMetalTargetRefsInFlightLiveCount: 1,
    encoderBridgeMetalTargetRefsInFlightPeakCount: 2,
    encoderBridgeMetalTargetRefsInFlightCeiling: 5,
    nativePreviewIosurfaceImportLiveCount: 2,
    nativePreviewIosurfaceImportPeakCount: 2,
    nativePreviewIosurfaceImportCeiling: 3,
    cameraSurfaceLiveCount: 2,
    cameraSurfacePeakCount: 3,
    cameraSurfaceEstimatedBytes: 10,
    screenSurfaceLiveCount: 3,
    screenSurfacePeakCount: 4,
    screenSurfaceEstimatedBytes: 20,
    ...overrides
  }
}

function evidenceGates(overrides = {}) {
  return {
    requireNativePreview: false,
    requirePresenterAdvancement: false,
    requireMetalCompositor: false,
    requireReleaseRecordingPath: false,
    minimumPreviewPresentFps: 1,
    maximumPreviewFrameAgeMs: 1_000,
    maximumPreviewLatencyP95Ms: 1_000,
    minimumSampleCoverage: 0.95,
    maximumSampleGapMs: 6_000,
    maximumSurfaceLiveCount: 12,
    maximumSurfacePeakCount: 16,
    maximumSurfaceSlopePerMinute: 0.05,
    surfaceSlopeMinimumMinutes: 10,
    surfaceGrowthAllowance: 2,
    minimumRealSourceRateFraction: 0.6,
    maximumRealSourceAgeMs: 1_000,
    ...overrides
  }
}

function device(kind, id, status = 'available') {
  return { kind, id, name: id, status }
}
