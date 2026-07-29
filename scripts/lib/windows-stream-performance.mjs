import { readFile } from 'node:fs/promises'

import {
  evaluateWindowsPerformanceBudget,
  loadWindowsPerformanceBudget,
  validateWindowsPerformanceBudget
} from './windows-performance-budget.mjs'
import {
  performanceSamplingEvidenceFailures,
  performanceSamplingInvariants
} from './performance-sampling-schedule.mjs'
import {
  WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS,
  packagedAppPayloadManifestSha256
} from './performance-contract.mjs'

const WINDOWS_PACKAGED_APP_PAYLOAD_SPECS = WINDOWS_PACKAGED_APP_PAYLOAD_COMPONENTS.map(
  (relativePath) => ({ relativePath, requiresCodeSignature: false })
)

export const WINDOWS_STREAM_PERFORMANCE_TIMING = Object.freeze({
  warmupMs: 60_000,
  measurementMs: 180_000,
  sampleIntervalMs: 1_000,
  repetitions: 3
})

export const WINDOWS_STREAM_ENDURANCE_TIMING = Object.freeze({
  warmupMs: 60_000,
  measurementMs: 600_000,
  sampleIntervalMs: 1_000,
  repetitions: 1
})

export const WINDOWS_STREAM_PERFORMANCE_THRESHOLDS = Object.freeze({
  durationToleranceRatio: 0.02,
  frameCountToleranceRatio: 0.02,
  fpsTolerance: 0.01,
  maximumFrameGapMs: 100,
  maximumFreezeMs: 100,
  maximumRepeatedFrameRun: 2,
  maximumDuplicatePtsCount: 2,
  maximumDuplicatePtsRun: 2,
  maximumKeyframeIntervalSeconds: 2,
  maximumQueueLossRatio: 0.001,
  minimumEncoderSpeedP05: 0.98,
  minimumRollingBitrateRatio: 0.9,
  maximumRollingBitrateRatio: 1.1,
  totalBitrateToleranceRatio: 0.1,
  maximumAvMedianAbsoluteOffsetMs: 60,
  maximumAvSampleOffsetMs: 150,
  maximumProjectedDriftMsPer30Min: 20
})

// Mirrors apps/desktop/src/main/window-capture-protection.ts. Keep the values
// role-specific so physical evidence proves every owned window independently.
export const WINDOWS_CAPTURE_PROTECTION_MARKERS = Object.freeze({
  main: '#8b1e3f',
  preview: '#2e8b57',
  comments: '#5f4b8b',
  notes: '#c41e3a',
  captions: '#d2691e',
  'proof-surface': '#1e90a8'
})

export function redactWindowsStreamSecrets(value, secrets = []) {
  const secretValues = [...new Set((secrets ?? []).filter(nonEmptyString))].sort(
    (left, right) => right.length - left.length
  )
  const redactText = (text) => {
    let redacted = text
    for (const secret of secretValues) {
      redacted = redacted.split(secret).join('[redacted-stream-secret]')
    }
    return redacted.replace(/\brtmps?:\/\/[^\s"'<>()[\]{}]+/giu, '[redacted-rtmp-url]')
  }
  const visit = (current) => {
    if (typeof current === 'string') return redactText(current)
    if (Array.isArray(current)) return current.map(visit)
    if (!isRecord(current)) return current
    return Object.fromEntries(Object.entries(current).map(([key, nested]) => [key, visit(nested)]))
  }
  return visit(value)
}

export function windowsStreamSecretLeaks(value, secrets = []) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return [...new Set((secrets ?? []).filter(nonEmptyString))].filter((secret) =>
    serialized.includes(secret)
  )
}

export function buildWindowsStreamPerformanceMatrix() {
  const scenarios = []
  for (const fps of [30, 60]) {
    for (const topology of ['stream', 'record-stream']) {
      for (const previewOpen of [true, false]) {
        scenarios.push(
          Object.freeze({
            id: `1080p${fps}-${topology}-${previewOpen ? 'preview' : 'no-preview'}`,
            width: 1920,
            height: 1080,
            fps,
            // The Step 2 matrix is a local/manual RTMP qualification. Provider-
            // specific YouTube 10/12 Mbps scenarios are added separately in Step 5;
            // manual, Twitch, X, and mixed/shared output remain on the validated
            // 6 Mbps ceiling.
            bitrateKbps: 6_000,
            provider: 'custom',
            videoPreset: 'custom',
            recordEnabled: topology === 'record-stream',
            topology: topology === 'record-stream' ? 'record-plus-stream' : 'stream-only',
            previewOpen,
            warmupMs: WINDOWS_STREAM_PERFORMANCE_TIMING.warmupMs,
            measurementMs: WINDOWS_STREAM_PERFORMANCE_TIMING.measurementMs,
            sampleIntervalMs: WINDOWS_STREAM_PERFORMANCE_TIMING.sampleIntervalMs,
            repetitions: WINDOWS_STREAM_PERFORMANCE_TIMING.repetitions
          })
        )
      }
    }
  }
  scenarios.push(
    providerScenario({
      id: 'youtube-1080p30',
      fps: 30,
      bitrateKbps: 10_000,
      videoPreset: 'stream-youtube-1080p30'
    }),
    providerScenario({
      id: 'youtube-1080p60',
      fps: 60,
      bitrateKbps: 12_000,
      videoPreset: 'stream-youtube-1080p60'
    }),
    Object.freeze({
      id: '1080p60-av-endurance',
      width: 1920,
      height: 1080,
      fps: 60,
      bitrateKbps: 6_000,
      provider: 'custom',
      videoPreset: 'custom',
      recordEnabled: false,
      topology: 'stream-only',
      previewOpen: true,
      avEndurance: true,
      ...WINDOWS_STREAM_ENDURANCE_TIMING
    })
  )
  return scenarios
}

function providerScenario({ id, fps, bitrateKbps, videoPreset }) {
  return Object.freeze({
    id,
    width: 1920,
    height: 1080,
    fps,
    bitrateKbps,
    provider: 'youtube',
    videoPreset,
    recordEnabled: false,
    topology: 'stream-only',
    previewOpen: true,
    warmupMs: WINDOWS_STREAM_PERFORMANCE_TIMING.warmupMs,
    measurementMs: WINDOWS_STREAM_PERFORMANCE_TIMING.measurementMs,
    sampleIntervalMs: WINDOWS_STREAM_PERFORMANCE_TIMING.sampleIntervalMs,
    repetitions: WINDOWS_STREAM_PERFORMANCE_TIMING.repetitions
  })
}

export function formatWindowsStreamPerformanceMatrix(
  matrix = buildWindowsStreamPerformanceMatrix()
) {
  const lines = [
    'windows-stream-performance: protected matrix',
    `matrix timing: warm-up ${WINDOWS_STREAM_PERFORMANCE_TIMING.warmupMs / 1000}s, measured ${WINDOWS_STREAM_PERFORMANCE_TIMING.measurementMs / 1000}s, ${WINDOWS_STREAM_PERFORMANCE_TIMING.repetitions} repetitions; A/V endurance measured ${WINDOWS_STREAM_ENDURANCE_TIMING.measurementMs / 1000}s once`
  ]
  for (const [index, scenario] of matrix.entries()) {
    lines.push(
      `${index + 1}. ${scenario.id} — ${scenario.width}x${scenario.height}@${scenario.fps} | ` +
        `${scenario.topology} | preview=${scenario.previewOpen ? 'open' : 'closed'} | ` +
        `measured=${scenario.measurementMs / 1000}s | runs=${scenario.repetitions}`
    )
  }
  lines.push(
    `total: ${matrix.length} scenarios, ${matrix.reduce((sum, scenario) => sum + scenario.repetitions, 0)} measured runs`
  )
  return lines.join('\n')
}

export function parseWindowsStreamPerformanceArgs(
  argv,
  matrix = buildWindowsStreamPerformanceMatrix()
) {
  const values = [...argv]
  const list = takeFlag(values, '--list')
  const gate = takeFlag(values, '--gate')
  const calibrate = takeFlag(values, '--calibrate')
  const preparePremiumProfile = takeFlag(values, '--prepare-premium-profile')
  const requireBridge = takeFlag(values, '--require-bridge')
  const videoOnly = takeFlag(values, '--video-only')
  if (gate && calibrate) {
    throw new Error('--gate and --calibrate are mutually exclusive.')
  }

  const scenarioId = takeOption(values, '--scenario')
  const requestedRuns = takeOption(values, '--runs')
  const expectFallback = takeOption(values, '--expect-fallback')
  const bridge = takeOption(values, '--bridge') ?? (expectFallback ? 'mf' : 'auto')
  const output = takeOption(values, '--output')
  if (values.length > 0) {
    throw new Error(`Unknown Windows stream performance argument: ${values[0]}`)
  }
  if (!['auto', 'mf', 'raw'].includes(bridge)) {
    throw new Error(`--bridge must be auto, mf, or raw; received ${bridge}.`)
  }
  if (requireBridge && bridge !== 'mf') {
    throw new Error('--require-bridge requires --bridge mf.')
  }
  if (expectFallback !== undefined && expectFallback !== 'software-open-h264') {
    throw new Error(`--expect-fallback must be software-open-h264; received ${expectFallback}.`)
  }
  if (expectFallback && (bridge !== 'mf' || requireBridge)) {
    throw new Error(
      '--expect-fallback software-open-h264 requests --bridge mf without --require-bridge.'
    )
  }
  const mode = calibrate ? 'calibrate' : gate || !scenarioId ? 'gate' : 'diagnostic'
  if (mode === 'gate' && bridge === 'raw') {
    throw new Error(
      'The protected gate cannot use --bridge raw; it must prove the Media Foundation production path.'
    )
  }
  if (mode === 'gate' && expectFallback) {
    throw new Error('The protected gate cannot qualify an expected encoder fallback.')
  }

  if (preparePremiumProfile) {
    if (
      list ||
      gate ||
      calibrate ||
      scenarioId ||
      requestedRuns !== undefined ||
      expectFallback ||
      requireBridge ||
      videoOnly ||
      bridge !== 'auto'
    ) {
      throw new Error(
        '--prepare-premium-profile is interactive and cannot be combined with run-selection options.'
      )
    }
    return {
      list: false,
      mode: 'prepare-premium-profile',
      preparePremiumProfile: true,
      scenarios: [],
      scenarioId: null,
      repetitions: 0,
      bridge: 'auto',
      expectFallback: null,
      requireBridge: false,
      videoOnly: false,
      output: output ?? null
    }
  }

  const scenarios = scenarioId ? matrix.filter((scenario) => scenario.id === scenarioId) : matrix
  if (scenarioId && scenarios.length === 0) {
    throw new Error(`Unknown Windows stream performance scenario: ${scenarioId}.`)
  }
  const repetitions = requestedRuns === undefined ? (scenarioId ? 1 : null) : Number(requestedRuns)
  if (repetitions !== null && (!Number.isInteger(repetitions) || repetitions <= 0)) {
    throw new Error(`--runs must be a positive integer; received ${requestedRuns}.`)
  }
  if (!scenarioId && requestedRuns !== undefined) {
    throw new Error(
      'The protected full matrix uses each scenario’s fixed repetition count; --runs requires --scenario.'
    )
  }
  if (!scenarioId && videoOnly) {
    throw new Error('The protected full matrix requires audible A/V evidence.')
  }

  return {
    list,
    mode,
    preparePremiumProfile: false,
    scenarios,
    scenarioId: scenarioId ?? null,
    repetitions,
    bridge,
    expectFallback: expectFallback ?? null,
    requireBridge,
    videoOnly,
    output: output ?? null
  }
}

export function validateWindowsStreamRunEvidence(evidence) {
  const failures = []
  if (evidence?.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (evidence?.kind !== 'videorc.windows-stream-performance-run') {
    failures.push('kind must be videorc.windows-stream-performance-run')
  }
  if (!['gate', 'calibrate', 'diagnostic'].includes(evidence?.mode)) {
    failures.push('mode must be gate, calibrate, or diagnostic')
  }
  if (!buildWindowsStreamPerformanceMatrix().some((item) => item.id === evidence?.scenarioId)) {
    failures.push('scenarioId was not in the protected matrix')
  }
  if (!positiveInteger(evidence?.repetition)) failures.push('repetition was invalid')
  if (!nonEmptyString(evidence?.candidate?.executablePath)) {
    failures.push('candidate.executablePath was missing')
  }
  if (!/^[a-f0-9]{64}$/.test(evidence?.candidate?.sha256 ?? '')) {
    failures.push('candidate.sha256 must be a lowercase SHA-256 digest')
  }
  if (!/^[a-f0-9]{64}$/.test(evidence?.candidate?.packagePayload?.sha256 ?? '')) {
    failures.push('candidate.packagePayload.sha256 must be a lowercase SHA-256 digest')
  }
  const payloadComponents = evidence?.candidate?.packagePayload?.components
  const canonicalPayloadSha256 = packagedAppPayloadManifestSha256(payloadComponents, {
    payloadSpecs: WINDOWS_PACKAGED_APP_PAYLOAD_SPECS
  })
  if (!canonicalPayloadSha256) {
    failures.push('candidate.packagePayload.components did not bind every packaged executable')
  } else if (
    /^[a-f0-9]{64}$/.test(evidence?.candidate?.packagePayload?.sha256 ?? '') &&
    evidence.candidate.packagePayload.sha256 !== canonicalPayloadSha256
  ) {
    failures.push('candidate.packagePayload.sha256 did not match the canonical payload manifest')
  }
  for (const field of ['warmupMs', 'measurementMs', 'sampleIntervalMs']) {
    if (!positiveInteger(evidence?.timing?.[field])) {
      failures.push(`timing.${field} was invalid`)
    }
  }
  if (evidence?.stimulus?.motion?.started !== true) {
    failures.push('stimulus.motion.started must be true')
  }
  if (!nonEmptyString(evidence?.stimulus?.motion?.browserPath)) {
    failures.push('stimulus.motion.browserPath was missing')
  }
  if (evidence?.stimulus?.audio?.required === true) {
    if (evidence.stimulus.audio.started !== true) {
      failures.push('stimulus.audio.started must be true when audio is required')
    }
    if (!nonEmptyString(evidence.stimulus.audio.browserPath)) {
      failures.push('stimulus.audio.browserPath was missing when audio is required')
    }
  }
  for (const field of [
    'receiverMedia',
    'ffprobeJson',
    'framemd5',
    'analyzerJson',
    'supportBundle',
    'processSamples',
    'gpuSamples',
    'captureProtection',
    'settings',
    'verdict'
  ]) {
    if (!nonEmptyString(evidence?.artifacts?.[field])) {
      failures.push(`artifacts.${field} was missing`)
    }
  }
  if (!isRecord(evidence?.media)) failures.push('media evidence was missing')
  if (!isRecord(evidence?.pipeline)) failures.push('pipeline evidence was missing')
  if (!isRecord(evidence?.network)) failures.push('network evidence was missing')
  if (!isRecord(evidence?.avSync)) failures.push('A/V sync evidence was missing')
  if (!isRecord(evidence?.process)) failures.push('process evidence was missing')
  if (!isRecord(evidence?.captureProtection)) {
    failures.push('capture-protection pixel evidence was missing')
  }
  if (!isRecord(evidence?.budget)) failures.push('budget evidence was missing')
  return failures
}

export function evaluateWindowsStreamRun(
  evidence,
  thresholds = WINDOWS_STREAM_PERFORMANCE_THRESHOLDS
) {
  const blockers = []
  const failures = validateWindowsStreamRunEvidence(evidence).filter((failure) => {
    if (failure === 'stimulus.audio.started must be true when audio is required') return false
    if (failure === 'stimulus.audio.browserPath was missing when audio is required') return false
    if (failure === 'artifacts.supportBundle was missing') return false
    if (failure === 'artifacts.gpuSamples was missing') return false
    if (failure === 'artifacts.captureProtection was missing') return false
    if (failure === 'capture-protection pixel evidence was missing') return false
    return true
  })
  const scenario = buildWindowsStreamPerformanceMatrix().find(
    (candidate) => candidate.id === evidence?.scenarioId
  )

  if (evidence?.stimulus?.motion?.started !== true) {
    blockers.push('visible every-frame-changing motion stimulus did not start')
  }
  if (evidence?.stimulus?.motion?.processLivenessVerdict !== 'PASS') {
    blockers.push(
      ...(evidence?.stimulus?.motion?.processLivenessBlockers?.length
        ? evidence.stimulus.motion.processLivenessBlockers.map(
            (blocker) => `motion stimulus: ${blocker}`
          )
        : ['motion stimulus process liveness evidence was missing'])
    )
  }
  if (evidence?.stimulus?.audio?.required === true) {
    if (evidence.stimulus.audio.started !== true) {
      blockers.push('audible A/V alignment stimulus did not start')
    }
    if (evidence?.stimulus?.audio?.processLivenessVerdict !== 'PASS') {
      blockers.push(
        ...(evidence?.stimulus?.audio?.processLivenessBlockers?.length
          ? evidence.stimulus.audio.processLivenessBlockers.map(
              (blocker) => `A/V stimulus: ${blocker}`
            )
          : ['A/V stimulus process liveness evidence was missing'])
      )
    }
    if (evidence?.avSync?.measured !== true) {
      blockers.push('A/V alignment evidence was not measured')
    }
    if (scenario?.avEndurance === true && evidence?.avSync?.driftBinding !== true) {
      blockers.push('A/V drift could not be bound across the measured window')
    }
  }
  if (!nonEmptyString(evidence?.artifacts?.supportBundle)) {
    blockers.push('support bundle evidence was missing')
  }
  if (
    !nonEmptyString(evidence?.artifacts?.gpuSamples) ||
    evidence?.process?.gpuVerdict !== 'PASS'
  ) {
    blockers.push('complete app-attributed GPU counter evidence was missing')
  }
  if (evidence?.pipeline?.diagnosticTimelineVerdict !== 'PASS') {
    blockers.push(
      ...(evidence?.pipeline?.diagnosticTimelineBlockers?.length
        ? evidence.pipeline.diagnosticTimelineBlockers.map(
            (blocker) => `diagnostic timeline: ${blocker}`
          )
        : ['complete diagnostic timeline evidence was missing'])
    )
  }
  if (evidence?.process?.telemetryVerdict !== 'PASS') {
    blockers.push(
      ...(evidence?.process?.telemetryBlockers?.length
        ? evidence.process.telemetryBlockers.map((blocker) => `process telemetry: ${blocker}`)
        : ['complete process telemetry evidence was missing'])
    )
  }
  if (
    !nonEmptyString(evidence?.artifacts?.captureProtection) ||
    !isRecord(evidence?.captureProtection)
  ) {
    blockers.push('capture-protection pixel evidence was missing')
  } else if (evidence.captureProtection.verdict === 'FAIL') {
    failures.push(
      ...(evidence.captureProtection.failures ?? [
        'Videorc control-window pixels leaked into the stream'
      ])
    )
  } else if (
    evidence.captureProtection.verdict !== 'PASS' ||
    evidence.captureProtection.markerAbsent !== true ||
    evidence.captureProtection.underlyingStimulusPresent !== true
  ) {
    blockers.push(
      'capture-protection pixels did not prove both marker absence and underlying stimulus presence'
    )
  }
  if (evidence?.mode === 'gate') {
    if (
      evidence?.budget?.required !== true ||
      evidence?.budget?.active !== true ||
      evidence?.budget?.applicable !== true
    ) {
      blockers.push('an active applicable reviewed Windows hardware-class budget was missing')
    }
  }

  if (scenario) {
    requireEqual(failures, 'warm-up duration', evidence?.timing?.warmupMs, scenario.warmupMs)
    requireEqual(
      failures,
      'measurement duration',
      evidence?.timing?.measurementMs,
      scenario.measurementMs
    )
    requireEqual(
      failures,
      'sample interval',
      evidence?.timing?.sampleIntervalMs,
      scenario.sampleIntervalMs
    )
    requireEqual(failures, 'width', evidence?.media?.width, scenario.width)
    requireEqual(failures, 'height', evidence?.media?.height, scenario.height)
    requireAtMost(
      failures,
      'fps deviation',
      Math.abs(evidence?.media?.fps - scenario.fps),
      thresholds.fpsTolerance,
      `fps ${formatNumber(evidence?.media?.fps)} did not match requested ${scenario.fps}`
    )
    const expectedDurationSeconds = scenario.measurementMs / 1000
    requireAtMost(
      failures,
      'duration deviation',
      ratioDifference(evidence?.media?.durationSeconds, expectedDurationSeconds),
      thresholds.durationToleranceRatio,
      `duration ${formatNumber(evidence?.media?.durationSeconds)}s was outside ${(thresholds.durationToleranceRatio * 100).toFixed(0)}% of ${expectedDurationSeconds}s`
    )
    const expectedFrames = expectedDurationSeconds * scenario.fps
    requireAtMost(
      failures,
      'frame count deviation',
      ratioDifference(evidence?.media?.frameCount, expectedFrames),
      thresholds.frameCountToleranceRatio,
      `frame count ${formatNumber(evidence?.media?.frameCount)} was outside ${(thresholds.frameCountToleranceRatio * 100).toFixed(0)}% of ${expectedFrames}`
    )
  }

  requireAtMost(failures, 'frame gap', evidence?.media?.maxFrameGapMs, thresholds.maximumFrameGapMs)
  requireAtMost(
    failures,
    'freeze',
    evidence?.media?.longestCorroboratedFreezeMs,
    thresholds.maximumFreezeMs
  )
  requireAtMost(
    failures,
    'repeated-frame run',
    evidence?.media?.maxRepeatedFrameRun,
    thresholds.maximumRepeatedFrameRun
  )
  requireAtMost(
    failures,
    'duplicate PTS count',
    evidence?.media?.duplicatePtsCount,
    thresholds.maximumDuplicatePtsCount
  )
  requireAtMost(
    failures,
    'duplicate PTS run',
    evidence?.media?.maxDuplicatePtsRun,
    thresholds.maximumDuplicatePtsRun
  )
  requireAtMost(
    failures,
    'keyframe interval',
    evidence?.media?.maxKeyframeIntervalSeconds,
    thresholds.maximumKeyframeIntervalSeconds
  )
  const wrongColorTags = [
    ['primaries', evidence?.media?.colorPrimaries],
    ['transfer', evidence?.media?.colorTransfer],
    ['matrix', evidence?.media?.colorSpace],
    ['range', evidence?.media?.colorRange]
  ].filter(([, value]) => !['bt709', 'tv'].includes(value))
  if (
    evidence?.media?.colorPrimaries !== 'bt709' ||
    evidence?.media?.colorTransfer !== 'bt709' ||
    evidence?.media?.colorSpace !== 'bt709' ||
    evidence?.media?.colorRange !== 'tv'
  ) {
    failures.push(
      `color tags were not BT.709 video-range: ${wrongColorTags
        .map(([field, value]) => `${field}=${value ?? 'missing'}`)
        .join(', ')}`
    )
  }

  const selectedMediaFoundation =
    evidence?.pipeline?.effectiveBridgeOutput === 'windows-media-foundation-h264-mpegts'
  if (evidence?.mode === 'gate') {
    requireEqual(
      failures,
      'gate requested bridge output',
      evidence?.pipeline?.requestedBridgeOutput,
      'windows-media-foundation-h264-mpegts'
    )
    requireEqual(
      failures,
      'gate effective bridge output',
      evidence?.pipeline?.effectiveBridgeOutput,
      'windows-media-foundation-h264-mpegts'
    )
    if (nonEmptyString(evidence?.pipeline?.fallbackReason)) {
      failures.push(`gate bridge fallback was active: ${evidence.pipeline.fallbackReason}`)
    }
  }
  if (selectedMediaFoundation || evidence?.pipeline?.requireMediaFoundation === true) {
    requireEqual(
      failures,
      'effective encode backend',
      evidence?.pipeline?.effectiveEncodeBackend,
      'hardware-media-foundation'
    )
    requireEqual(
      failures,
      'encoded output backend',
      evidence?.pipeline?.encodedOutputBackend,
      'media-foundation'
    )
    requireEqual(failures, 'rawVideoCopiedFrames', evidence?.pipeline?.rawVideoCopiedFrames, 0)
    requirePositive(failures, 'encoded frames', evidence?.pipeline?.encodedFrames)
    requirePositive(failures, 'encoded bytes', evidence?.pipeline?.encodedBytes)
  }
  if (evidence?.pipeline?.expectedFallback === 'software-open-h264') {
    requireEqual(
      failures,
      'fallback bridge output',
      evidence?.pipeline?.effectiveBridgeOutput,
      'raw-yuv420p'
    )
    requireEqual(
      failures,
      'fallback encode backend',
      evidence?.pipeline?.effectiveEncodeBackend,
      'software-open-h264'
    )
    if (!nonEmptyString(evidence?.pipeline?.fallbackReason)) {
      failures.push('expected software-open-h264 fallback reason was missing')
    }
  }
  if (evidence?.pipeline?.fallbackChanged === true) {
    failures.push('effective encoder fallback changed mid-run')
  }
  if (
    nonEmptyString(evidence?.pipeline?.fallbackReason) &&
    evidence?.pipeline?.fallbackAcknowledged !== true
  ) {
    failures.push(`unacknowledged fallback: ${evidence.pipeline.fallbackReason}`)
  }
  const queueLoss =
    finiteOrNaN(evidence?.pipeline?.coalescedFrames) +
    finiteOrNaN(evidence?.pipeline?.droppedFrames)
  const submittedFrames = evidence?.pipeline?.submittedFrames
  const queueLossRatio =
    Number.isFinite(queueLoss) && Number.isFinite(submittedFrames) && submittedFrames > 0
      ? queueLoss / submittedFrames
      : Number.NaN
  requireAtMost(
    failures,
    'coalesced plus dropped frame ratio',
    queueLossRatio,
    thresholds.maximumQueueLossRatio
  )
  requireAtLeast(
    failures,
    'encoder speed fifth percentile',
    evidence?.pipeline?.encoderSpeedP05,
    thresholds.minimumEncoderSpeedP05
  )

  const targetBitrate = evidence?.network?.targetBitrateKbps
  const minimumBitrate = targetBitrate * thresholds.minimumRollingBitrateRatio
  const maximumBitrate = targetBitrate * thresholds.maximumRollingBitrateRatio
  if (!Array.isArray(evidence?.network?.rollingBitrateKbps)) {
    failures.push('rolling receiver bitrate evidence was missing')
  } else {
    for (const bitrate of evidence.network.rollingBitrateKbps) {
      if (!Number.isFinite(bitrate) || bitrate < minimumBitrate || bitrate > maximumBitrate) {
        failures.push(
          `rolling receiver bitrate ${formatNumber(bitrate)}kbps was outside ${formatNumber(minimumBitrate)}-${formatNumber(maximumBitrate)}kbps`
        )
        break
      }
    }
  }
  const totalBitrateRatio = ratioDifference(evidence?.network?.measuredBitrateKbps, targetBitrate)
  requireAtMost(
    failures,
    'total bitrate deviation',
    totalBitrateRatio,
    thresholds.totalBitrateToleranceRatio,
    `total bitrate ${formatNumber(evidence?.network?.measuredBitrateKbps)}kbps was outside ${(thresholds.totalBitrateToleranceRatio * 100).toFixed(0)}% of ${formatNumber(targetBitrate)}kbps`
  )
  requireEqual(failures, 'network reconnect count', evidence?.network?.reconnects, 0)
  if (evidence?.network?.lifecycle?.verdict === 'FAIL') {
    failures.push(
      ...(evidence.network.lifecycle.failures ?? ['selected stream target lifecycle failed'])
    )
  } else if (evidence?.network?.lifecycle?.verdict !== 'PASS') {
    blockers.push(
      ...(evidence?.network?.lifecycle?.blockers ?? [
        'selected stream target lifecycle evidence was missing'
      ])
    )
  }
  if (
    !Number.isFinite(evidence?.network?.measurementClock?.startSkewMs) ||
    evidence.network.measurementClock.startSkewMs > (scenario?.sampleIntervalMs ?? 0) ||
    !Number.isFinite(evidence?.network?.measurementClock?.endSkewMs) ||
    evidence.network.measurementClock.endSkewMs > (scenario?.sampleIntervalMs ?? 0)
  ) {
    blockers.push('receiver and telemetry were not bound to one measurement clock')
  }
  if (evidence?.network?.measurementClock?.collectorBoundaries?.verdict !== 'PASS') {
    blockers.push(
      ...(evidence?.network?.measurementClock?.collectorBoundaries?.blockers?.length
        ? evidence.network.measurementClock.collectorBoundaries.blockers.map(
            (blocker) => `measurement collector: ${blocker}`
          )
        : ['long-running collectors were not bound to the shared measurement boundaries'])
    )
  }
  if (evidence?.network?.unexpectedExit === true) {
    failures.push('FFmpeg/backend had an unexpected exit')
  }

  if (evidence?.avSync?.required === true && evidence?.avSync?.measured === true) {
    requireAtMost(
      failures,
      'A/V median absolute offset',
      evidence.avSync.medianAbsoluteOffsetMs,
      thresholds.maximumAvMedianAbsoluteOffsetMs
    )
    requireAtMost(
      failures,
      'A/V maximum absolute offset',
      evidence.avSync.maxAbsoluteOffsetMs,
      thresholds.maximumAvSampleOffsetMs
    )
    if (scenario?.avEndurance === true && evidence.avSync.driftBinding === true) {
      requireAtMost(
        failures,
        'projected A/V drift',
        Math.abs(evidence.avSync.projectedDriftMsPer30Min),
        thresholds.maximumProjectedDriftMsPer30Min
      )
    }
  }

  if (evidence?.process?.telemetryCollected !== true) {
    failures.push('process CPU/RSS telemetry was not collected')
  }
  if (evidence?.process?.teardownClean !== true) {
    failures.push('app-owned process teardown was not clean')
  }
  if (evidence?.process?.leakDetected === true) {
    failures.push('app-owned process leak was detected')
  }
  for (const failure of evidence?.budget?.failures ?? []) {
    failures.push(`Windows hardware budget: ${failure}`)
  }

  if (failures.length > 0) return { verdict: 'FAIL', failures, blockers }
  if (blockers.length > 0) return { verdict: 'BLOCKED', failures, blockers }
  return { verdict: 'PASS', failures, blockers }
}

export function evaluateWindowsStreamAggregate({ mode, runs }) {
  const failures = []
  const blockers = []
  for (const run of runs ?? []) {
    if (run?.verdict === 'FAIL') {
      failures.push(
        `${run.scenarioId ?? 'unknown'}#${run.repetition ?? '?'} failed${
          run.failures?.length ? `: ${run.failures.join('; ')}` : ''
        }`
      )
    }
    if (run?.verdict === 'BLOCKED') {
      blockers.push(
        `${run.scenarioId ?? 'unknown'}#${run.repetition ?? '?'} blocked${
          run.blockers?.length ? `: ${run.blockers.join('; ')}` : ''
        }`
      )
    }
  }
  if (failures.length > 0) return { verdict: 'FAIL', failures, blockers }
  if (blockers.length > 0) return { verdict: 'BLOCKED', failures, blockers }
  if (mode === 'calibrate') return { verdict: 'CALIBRATION', failures, blockers }

  const expected = new Set(
    buildWindowsStreamPerformanceMatrix().flatMap((scenario) =>
      Array.from({ length: scenario.repetitions }, (_, index) => `${scenario.id}#${index + 1}`)
    )
  )
  const actual = new Set(
    (runs ?? [])
      .filter((run) => run?.verdict === 'PASS')
      .map((run) => `${run.scenarioId}#${run.repetition}`)
  )
  const complete =
    actual.size === expected.size && [...expected].every((runKey) => actual.has(runKey))
  return {
    verdict: mode === 'gate' ? (complete ? 'PASS' : 'BLOCKED') : 'DIAGNOSTIC',
    failures,
    blockers:
      mode === 'gate' && !complete
        ? ['protected gate evidence did not cover the complete fixed matrix']
        : blockers
  }
}

export function receiverBitrateEvidence(packets, { durationSeconds, windowSeconds = 5 } = {}) {
  const usable = (packets ?? [])
    .map((packet) => ({
      pts: Number(packet?.pts_time ?? packet?.ptsTime),
      size: Number(packet?.size)
    }))
    .filter(
      (packet) => Number.isFinite(packet.pts) && Number.isFinite(packet.size) && packet.size >= 0
    )
    .sort((left, right) => left.pts - right.pts)
  const totalBytes = usable.reduce((sum, packet) => sum + packet.size, 0)
  const measuredDuration =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : usable.length > 1
        ? usable.at(-1).pts - usable[0].pts
        : 0
  const firstPts = usable[0]?.pts ?? 0
  const rollingBitrateKbps = []
  if (measuredDuration >= windowSeconds && windowSeconds > 0) {
    for (let start = 0; start + windowSeconds <= measuredDuration + 1e-9; start += windowSeconds) {
      const end = start + windowSeconds
      const bytes = usable
        .filter((packet) => {
          const normalizedPts = packet.pts - firstPts
          return normalizedPts >= start && normalizedPts < end
        })
        .reduce((sum, packet) => sum + packet.size, 0)
      rollingBitrateKbps.push((bytes * 8) / windowSeconds / 1_000)
    }
  }
  return {
    measuredBitrateKbps: measuredDuration > 0 ? (totalBytes * 8) / measuredDuration / 1_000 : null,
    rollingBitrateKbps,
    windowSeconds,
    packetCount: usable.length,
    totalBytes
  }
}

/**
 * Correlates FFmpeg's output-media clock with the harness wall clock. A raw
 * `Date.now()` taken when one progress chunk arrives is not an epoch: pipe or
 * event-loop delay can make the media lead telemetry while appearing aligned.
 * Multiple promptly delivered progress observations must agree on the same
 * media-start wall time before the acceptance runner may start collectors.
 */
export function evaluateWindowsReceiverProgressClock(
  samples,
  {
    minimumSamples = 3,
    minimumMediaSpanUs = 500_000,
    maximumFirstOutTimeUs = 1_000_000,
    maximumObservationGapMs = 750,
    maximumUncertaintyMs = 250
  } = {}
) {
  const blockers = []
  const measured = Array.isArray(samples)
    ? samples.map((sample) => ({
        observedAtMs: Number(sample?.observedAtMs),
        outTimeUs: Number(sample?.outTimeUs),
        frame: Number(sample?.frame),
        totalSize: Number(sample?.totalSize)
      }))
    : []
  if (!Number.isInteger(minimumSamples) || minimumSamples < 2) {
    throw new Error('Receiver clock minimumSamples must be at least two.')
  }
  if (measured.length < minimumSamples) {
    blockers.push(`receiver progress clock retained ${measured.length}/${minimumSamples} samples`)
  }
  if (
    measured.some(
      (sample) =>
        !Number.isFinite(sample.observedAtMs) ||
        !Number.isFinite(sample.outTimeUs) ||
        sample.outTimeUs < 0 ||
        !Number.isFinite(sample.frame) ||
        !Number.isFinite(sample.totalSize)
    )
  ) {
    blockers.push('receiver progress clock contained an invalid observation')
  }
  for (let index = 1; index < measured.length; index += 1) {
    const previous = measured[index - 1]
    const current = measured[index]
    if (current.observedAtMs <= previous.observedAtMs) {
      blockers.push('receiver progress wall-clock observations were not strictly monotonic')
      break
    }
    if (current.outTimeUs <= previous.outTimeUs) {
      blockers.push('receiver progress media timestamps were not strictly monotonic')
      break
    }
    if (current.observedAtMs - previous.observedAtMs > maximumObservationGapMs) {
      blockers.push('receiver progress observations had an unbounded delivery gap')
      break
    }
  }
  const first = measured[0]
  const last = measured.at(-1)
  if (first && first.outTimeUs > maximumFirstOutTimeUs) {
    blockers.push('receiver progress media timestamps did not begin near zero')
  }
  const mediaSpanUs = first && last ? last.outTimeUs - first.outTimeUs : null
  if (!Number.isFinite(mediaSpanUs) || mediaSpanUs < minimumMediaSpanUs) {
    blockers.push('receiver progress clock did not span enough output media time')
  }
  const estimatedStarts = measured
    .map((sample) => sample.observedAtMs - sample.outTimeUs / 1_000)
    .filter(Number.isFinite)
  const minimumEstimatedStart = estimatedStarts.length > 0 ? Math.min(...estimatedStarts) : null
  const maximumEstimatedStart = estimatedStarts.length > 0 ? Math.max(...estimatedStarts) : null
  const uncertaintyMs =
    Number.isFinite(minimumEstimatedStart) && Number.isFinite(maximumEstimatedStart)
      ? maximumEstimatedStart - minimumEstimatedStart
      : null
  if (!Number.isFinite(uncertaintyMs) || uncertaintyMs > maximumUncertaintyMs) {
    blockers.push(
      `receiver progress clock uncertainty ${formatNumber(uncertaintyMs)}ms exceeded ${maximumUncertaintyMs}ms`
    )
  }
  const startedAtMs = blockers.length === 0 ? percentileNearestRank(estimatedStarts, 0.5) : null
  return {
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers,
    startedAtMs,
    uncertaintyMs,
    mediaSpanUs,
    samples: measured,
    thresholds: {
      minimumSamples,
      minimumMediaSpanUs,
      maximumFirstOutTimeUs,
      maximumObservationGapMs,
      maximumUncertaintyMs
    }
  }
}

export function evaluateWindowsStreamCollectorBoundaries({
  collectorsStartedAtMs,
  expectedMeasurementEndedAtMs,
  intervalMs,
  collectors
} = {}) {
  const blockers = []
  if (
    !Number.isFinite(collectorsStartedAtMs) ||
    !Number.isFinite(expectedMeasurementEndedAtMs) ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    expectedMeasurementEndedAtMs <= collectorsStartedAtMs
  ) {
    return {
      verdict: 'BLOCKED',
      blockers: ['collector boundary timing contract was invalid']
    }
  }
  const requiredCollectors = ['process', 'diagnostics', 'gpu', 'captureProtection']
  const evidence = {}
  for (const name of requiredCollectors) {
    const boundary = collectors?.[name]
    const startedAtMs = Number(boundary?.startedAtMs)
    const endedAtMs = Number(boundary?.endedAtMs)
    const collectorBlockers = []
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
      collectorBlockers.push('start/end epoch was missing')
    } else {
      if (endedAtMs < startedAtMs) collectorBlockers.push('end preceded start')
      if (Math.abs(startedAtMs - collectorsStartedAtMs) > intervalMs) {
        collectorBlockers.push('start differed from the shared boundary by more than one interval')
      }
      if (Math.abs(endedAtMs - expectedMeasurementEndedAtMs) > intervalMs) {
        collectorBlockers.push('end differed from the shared boundary by more than one interval')
      }
    }
    blockers.push(...collectorBlockers.map((blocker) => `${name}: ${blocker}`))
    evidence[name] = {
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
      endedAtMs: Number.isFinite(endedAtMs) ? endedAtMs : null,
      startSkewMs: Number.isFinite(startedAtMs)
        ? Math.abs(startedAtMs - collectorsStartedAtMs)
        : null,
      endSkewMs: Number.isFinite(endedAtMs)
        ? Math.abs(endedAtMs - expectedMeasurementEndedAtMs)
        : null,
      blockers: collectorBlockers
    }
  }
  return {
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers,
    collectors: evidence
  }
}

export function summarizeWindowsStreamDiagnosticSamples(samples, options = {}) {
  const measured = (samples ?? []).filter(isRecord)
  const first = measured[0] ?? {}
  const last = measured.at(-1) ?? {}
  const separateOutputEncoders = measured.some(
    (sample) => sample.encoderBridgeSeparateOutputEncodersActive === true
  )
  const rawVideoCopiedField = separateOutputEncoders
    ? 'encoderBridgeStreamRawVideoCopiedFrames'
    : 'encoderBridgeRawVideoCopiedFrames'
  const progressDroppedField = separateOutputEncoders
    ? 'encoderBridgeStreamDroppedFrames'
    : 'encoderBridgeDroppedFrames'
  const encoderSpeedField = separateOutputEncoders
    ? 'encoderBridgeStreamEncoderSpeed'
    : 'encoderSpeed'
  const requestedOutputStates = diagnosticStateSet(
    measured,
    (sample) => sample.encoderBridgeRequestedVideoOutput
  )
  const effectiveOutputStates = diagnosticStateSet(
    measured,
    (sample) => sample.encoderBridgeEffectiveVideoOutput
  )
  const encodeBackendStates = diagnosticStateSet(
    measured,
    (sample) => sample.effectiveEncodeBackend ?? sample.encodeBackend
  )
  const encodedOutputBackendStates = diagnosticStateSet(
    measured,
    (sample) => sample.encoderBridgeEncodedOutputBackend
  )
  const fallbackStates = diagnosticStateSet(
    measured,
    (sample) => sample.encoderBridgeEncodedOutputFallbackReason
  )
  const requestedBridgeOutput = lastNonEmptyString(
    measured.map((sample) => sample.encoderBridgeRequestedVideoOutput)
  )
  const effectiveBridgeOutput = lastNonEmptyString(
    measured.map((sample) => sample.encoderBridgeEffectiveVideoOutput)
  )
  const effectiveEncodeBackend = lastNonEmptyString(
    measured.map((sample) => sample.effectiveEncodeBackend ?? sample.encodeBackend)
  )
  const speedSamples = measured
    .map((sample) => sample[encoderSpeedField])
    .filter((value) => Number.isFinite(value))
  const encodedFrames = maxFinite(
    measured.map((sample) => sample.encoderBridgeStreamEncodedOutputFrames)
  )
  const encodedFramesDelta = counterDelta(
    first.encoderBridgeStreamEncodedOutputFrames,
    last.encoderBridgeStreamEncodedOutputFrames
  )
  const rawVideoCopiedFrames = maxFinite(measured.map((sample) => sample[rawVideoCopiedField]))
  const rawVideoCopiedFramesDelta = counterDelta(
    first[rawVideoCopiedField],
    last[rawVideoCopiedField]
  )
  const coalescedFrames = counterDelta(first[progressDroppedField], last[progressDroppedField])
  const streamDropField = measured.some((sample) =>
    Number.isFinite(sample.encoderBridgeStreamQueueDroppedFrames)
  )
    ? 'encoderBridgeStreamQueueDroppedFrames'
    : 'encoderBridgeOutputQueueDroppedFrames'
  const droppedFrames = counterDelta(first[streamDropField], last[streamDropField])
  const deliveredFrames =
    effectiveBridgeOutput === 'raw-yuv420p' ? rawVideoCopiedFramesDelta : encodedFramesDelta
  const submittedFrames =
    Number.isFinite(deliveredFrames) && Number.isFinite(droppedFrames)
      ? deliveredFrames + droppedFrames
      : null
  return {
    requestedBridgeOutput,
    effectiveBridgeOutput,
    effectiveEncodeBackend,
    encodedOutputBackend: lastNonEmptyString(
      measured.map((sample) => sample.encoderBridgeEncodedOutputBackend)
    ),
    separateOutputEncoders,
    encodedFrames,
    encodedBytes: maxFinite(measured.map((sample) => sample.encoderBridgeStreamEncodedOutputBytes)),
    rawVideoCopiedFrames,
    submittedFrames,
    coalescedFrames,
    droppedFrames,
    encoderSpeedP05: percentileNearestRank(speedSamples, 0.05),
    fallbackReason:
      [...measured]
        .reverse()
        .map((sample) => sample.encoderBridgeEncodedOutputFallbackReason)
        .find(nonEmptyString) ?? null,
    fallbackAcknowledged: options.fallbackAcknowledged === true,
    fallbackChanged: [
      requestedOutputStates,
      effectiveOutputStates,
      encodeBackendStates,
      encodedOutputBackendStates,
      fallbackStates
    ].some((states) => states.size > 1)
  }
}

export function evaluateWindowsStreamDiagnosticTimeline(
  timeline,
  { measurementMs, intervalMs, recordEnabled = false } = {}
) {
  const blockers = []
  if (!isRecord(timeline)) {
    return {
      verdict: 'BLOCKED',
      blockers: ['diagnostic timeline evidence was missing']
    }
  }
  if (
    !Number.isFinite(measurementMs) ||
    measurementMs <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    return {
      verdict: 'BLOCKED',
      blockers: ['diagnostic timeline timing contract was invalid']
    }
  }
  if (timeline?.timing?.measurementMs !== measurementMs) {
    blockers.push('diagnostic timeline measurement did not match the scenario')
  }
  if (timeline?.timing?.intervalMs !== intervalMs) {
    blockers.push('diagnostic timeline interval did not match the scenario')
  }
  blockers.push(
    ...performanceSamplingEvidenceFailures(timeline.sampling, measurementMs, intervalMs).map(
      (failure) => `diagnostics: ${failure}`
    )
  )

  const scheduled = Array.isArray(timeline.samples) ? timeline.samples : []
  if (scheduled.length !== timeline?.sampling?.collectedSamples) {
    blockers.push('diagnostic sample count disagreed with wall-clock sampling evidence')
  }
  if (!isRecord(timeline.terminal)) {
    blockers.push('diagnostic terminal boundary sample was missing')
  }
  if (
    !Number.isFinite(timeline?.terminalTiming?.observedAtMs) ||
    !Number.isFinite(timeline?.terminalTiming?.measurementEndedAtMs) ||
    timeline.terminalTiming.observedAtMs < timeline.terminalTiming.measurementEndedAtMs ||
    timeline.terminalTiming.observedAtMs - timeline.terminalTiming.measurementEndedAtMs > intervalMs
  ) {
    blockers.push('diagnostic terminal boundary was not sampled within one interval')
  }

  const measured = [...scheduled, ...(isRecord(timeline.terminal) ? [timeline.terminal] : [])]
  if (measured.length === 0) {
    blockers.push('diagnostic timeline contained no samples')
    return { verdict: 'BLOCKED', blockers }
  }
  const sessionIds = new Set()
  for (const [index, sample] of measured.entries()) {
    if (!nonEmptyString(sample.sessionId)) {
      blockers.push(`diagnostic sample ${index} had no active sessionId`)
    } else {
      sessionIds.add(sample.sessionId)
    }
  }
  if (sessionIds.size !== 1) {
    blockers.push('diagnostic timeline did not preserve one active session identity')
  }

  const separateOutputEncoderStates = new Set(
    measured.map((sample) => sample.encoderBridgeSeparateOutputEncodersActive)
  )
  const separateOutputEncoders = measured.every(
    (sample) => sample.encoderBridgeSeparateOutputEncodersActive === true
  )
  if (separateOutputEncoderStates.size > 1) {
    blockers.push('diagnostic output-encoder topology changed during measurement')
  }
  if (recordEnabled && !separateOutputEncoders) {
    blockers.push(
      'record-plus-stream diagnostics did not prove separate output encoders throughout'
    )
  }
  const speedField = separateOutputEncoders ? 'encoderBridgeStreamEncoderSpeed' : 'encoderSpeed'
  const progressDroppedField = separateOutputEncoders
    ? 'encoderBridgeStreamDroppedFrames'
    : 'encoderBridgeDroppedFrames'
  const rawVideoCopiedField = separateOutputEncoders
    ? 'encoderBridgeStreamRawVideoCopiedFrames'
    : 'encoderBridgeRawVideoCopiedFrames'
  const requiredStrings = [
    'encoderBridgeRequestedVideoOutput',
    'encoderBridgeEffectiveVideoOutput',
    'encoderBridgeEncodedOutputBackend'
  ]
  for (const field of requiredStrings) {
    if (measured.some((sample) => !nonEmptyString(sample[field]))) {
      blockers.push(`diagnostic timeline field ${field} was missing`)
    }
    if (diagnosticStateSet(measured, (sample) => sample[field]).size > 1) {
      blockers.push(`diagnostic timeline field ${field} changed during measurement`)
    }
  }
  const effectiveEncodeBackendStates = diagnosticStateSet(
    measured,
    (sample) => sample.effectiveEncodeBackend ?? sample.encodeBackend
  )
  if (
    measured.some(
      (sample) => !nonEmptyString(sample.effectiveEncodeBackend ?? sample.encodeBackend)
    )
  ) {
    blockers.push('diagnostic timeline effective encode backend was missing')
  }
  if (effectiveEncodeBackendStates.size > 1) {
    blockers.push('diagnostic timeline effective encode backend changed during measurement')
  }
  if (measured.some((sample) => !Number.isFinite(sample[speedField]) || sample[speedField] <= 0)) {
    blockers.push(`diagnostic timeline field ${speedField} was missing or invalid`)
  }

  const effectiveOutputs = new Set(
    measured.map((sample) => sample.encoderBridgeEffectiveVideoOutput)
  )
  const counterFields = [
    progressDroppedField,
    'encoderBridgeStreamQueueDroppedFrames',
    ...(effectiveOutputs.has('raw-yuv420p')
      ? [rawVideoCopiedField]
      : ['encoderBridgeStreamEncodedOutputFrames', 'encoderBridgeStreamEncodedOutputBytes'])
  ]
  for (const field of counterFields) {
    blockers.push(...monotonicDiagnosticCounterFailures(measured, field))
  }

  return {
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers,
    sessionId: sessionIds.size === 1 ? [...sessionIds][0] : null,
    separateOutputEncoders,
    sampling: timeline.sampling
  }
}

export function evaluateWindowsStreamProcessTelemetry(
  telemetry,
  {
    measurementMs,
    intervalMs,
    requiredRoles = ['backend', 'electron-main', 'electron-renderer', 'electron-gpu', 'ffmpeg']
  } = {}
) {
  const blockers = []
  if (!isRecord(telemetry)) {
    return { verdict: 'BLOCKED', blockers: ['Windows process telemetry was missing'] }
  }
  if (
    !Number.isFinite(measurementMs) ||
    measurementMs <= 0 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    return {
      verdict: 'BLOCKED',
      blockers: ['Windows process telemetry timing contract was invalid']
    }
  }
  if (telemetry?.timing?.requestedMeasurementMs !== measurementMs) {
    blockers.push('process telemetry measurement did not match the scenario')
  }
  if (telemetry?.timing?.intervalMs !== intervalMs) {
    blockers.push('process telemetry interval did not match the scenario')
  }
  blockers.push(
    ...performanceSamplingEvidenceFailures(telemetry.sampling, measurementMs, intervalMs).map(
      (failure) => `process telemetry: ${failure}`
    )
  )
  const invariants = performanceSamplingInvariants(measurementMs, intervalMs)
  const collectedSamples = telemetry?.sampling?.collectedSamples
  const memorySamples = Array.isArray(telemetry?.memory?.samples)
    ? telemetry.memory.samples.length
    : 0
  const cpuSamples = Array.isArray(telemetry?.cpu?.samples) ? telemetry.cpu.samples.length : 0
  if (
    !Number.isInteger(collectedSamples) ||
    collectedSamples < invariants.minSamples ||
    memorySamples !== collectedSamples ||
    cpuSamples !== collectedSamples ||
    telemetry?.memory?.summary?.samples !== collectedSamples ||
    telemetry?.cpu?.summary?.samples !== collectedSamples
  ) {
    blockers.push('process telemetry series did not exactly cover the collected schedule')
  }
  for (const role of requiredRoles) {
    if ((telemetry?.memory?.summary?.roles?.[role]?.minMeasuredCount ?? 0) < 1) {
      blockers.push(`process memory did not continuously cover required role ${role}`)
    }
    const cpu = telemetry?.cpu?.summary?.byRole?.[role]
    if (
      !isRecord(cpu) ||
      cpu.samples !== collectedSamples ||
      !Number.isFinite(cpu.averagePercent) ||
      !Number.isFinite(cpu.p95Percent) ||
      !Number.isFinite(cpu.maxPercent)
    ) {
      blockers.push(`process CPU did not continuously cover required role ${role}`)
    }
  }
  return {
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers,
    requiredRoles,
    sampling: telemetry.sampling
  }
}

export function evaluateWindowsStreamTargetLifecycle({
  snapshots,
  targetId,
  expectedSessionId,
  measurementStartedAtMs,
  measurementEndedAtMs,
  expectedMeasurementEndedAtMs,
  intervalMs,
  receiverAlive,
  pollingEvidence
} = {}) {
  const failures = []
  const blockers = []
  if (
    !nonEmptyString(targetId) ||
    !Number.isFinite(measurementStartedAtMs) ||
    !Number.isFinite(measurementEndedAtMs) ||
    !Number.isFinite(expectedMeasurementEndedAtMs) ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    return {
      verdict: 'BLOCKED',
      failures,
      blockers: ['stream target lifecycle timing contract was invalid']
    }
  }
  const events = (snapshots ?? [])
    .filter(
      (event) =>
        isRecord(event) &&
        Number.isFinite(event.receivedAtMs) &&
        ['rpc', 'diagnostics-rpc'].includes(event.source) &&
        isRecord(event.snapshot) &&
        Array.isArray(event.snapshot.targets)
    )
    .sort((left, right) => left.receivedAtMs - right.receivedAtMs)
  if (pollingEvidence?.verdict !== 'PASS') {
    blockers.push(
      ...(pollingEvidence?.blockers?.length
        ? pollingEvidence.blockers.map((blocker) => `target polling: ${blocker}`)
        : ['authoritative stream-target polling evidence was missing'])
    )
  }
  const sessionIds = new Set(events.map((event) => event.snapshot.sessionId).filter(nonEmptyString))
  if (events.some((event) => !nonEmptyString(event.snapshot.sessionId))) {
    blockers.push('authoritative stream-target snapshot omitted its session identity')
  }
  if (sessionIds.size !== 1) {
    blockers.push('authoritative stream-target snapshots did not preserve one session identity')
  }
  const observedSessionId = sessionIds.size === 1 ? [...sessionIds][0] : null
  if (nonEmptyString(expectedSessionId) && observedSessionId !== expectedSessionId.trim()) {
    blockers.push('stream-target and diagnostic timelines belonged to different sessions')
  }
  const targetEvents = events
    .map((event) => ({
      receivedAtMs: event.receivedAtMs,
      target: event.snapshot.targets.find((target) => target?.targetId === targetId) ?? null
    }))
    .filter((event) => isRecord(event.target))
  const stateAtStart = [...targetEvents]
    .reverse()
    .find((event) => event.receivedAtMs <= measurementStartedAtMs)
  if (stateAtStart?.target?.state !== 'live') {
    blockers.push('selected stream target was not confirmed live at measurement start')
  }
  const startObservationAgeMs = stateAtStart
    ? measurementStartedAtMs - stateAtStart.receivedAtMs
    : null
  if (Number.isFinite(startObservationAgeMs) && startObservationAgeMs > intervalMs) {
    blockers.push('selected stream target start observation was older than one interval')
  }
  const measuredEvents = targetEvents.filter(
    (event) =>
      event.receivedAtMs >= measurementStartedAtMs && event.receivedAtMs <= measurementEndedAtMs
  )
  if (measuredEvents.length === 0) {
    blockers.push('selected stream target had no observations during measurement')
  }
  const coverageEvents = targetEvents.filter(
    (event) =>
      event.receivedAtMs >= (stateAtStart?.receivedAtMs ?? measurementStartedAtMs) &&
      event.receivedAtMs <= measurementEndedAtMs
  )
  const coverageGaps = coverageEvents
    .slice(1)
    .map((event, index) => event.receivedAtMs - coverageEvents[index].receivedAtMs)
  if (coverageGaps.some((gap) => gap > intervalMs)) {
    blockers.push('selected stream target observation cadence exceeded one interval')
  }
  for (const event of measuredEvents) {
    if (event.target.state !== 'live') {
      failures.push(
        `selected stream target entered ${event.target.state ?? 'unknown'} during measurement`
      )
    }
  }
  const stateAtEnd = [...targetEvents]
    .reverse()
    .find((event) => event.receivedAtMs <= measurementEndedAtMs)
  if (!stateAtEnd) {
    blockers.push('selected stream target had no observation at or before measurement end')
  } else if (stateAtEnd.target.state !== 'live') {
    failures.push('selected stream target was not live immediately before stop')
  }
  const endObservationAgeMs = stateAtEnd ? measurementEndedAtMs - stateAtEnd.receivedAtMs : null
  if (Number.isFinite(endObservationAgeMs) && endObservationAgeMs > intervalMs) {
    blockers.push('selected stream target end observation was older than one interval')
  }
  const endSkewMs = Math.abs(measurementEndedAtMs - expectedMeasurementEndedAtMs)
  if (endSkewMs > intervalMs) {
    blockers.push(
      `stream lifecycle final check was ${endSkewMs}ms from the shared measurement boundary`
    )
  }
  if (receiverAlive !== true) {
    failures.push('local RTMP receiver was not alive at the measurement end boundary')
  }
  return {
    verdict: failures.length > 0 ? 'FAIL' : blockers.length > 0 ? 'BLOCKED' : 'PASS',
    failures,
    blockers,
    stateAtStart: stateAtStart?.target?.state ?? null,
    stateAtEnd: stateAtEnd?.target?.state ?? null,
    measuredEvents: measuredEvents.length,
    sessionId: observedSessionId,
    maximumObservationGapMs: coverageGaps.length > 0 ? Math.max(...coverageGaps) : null,
    startObservationAgeMs,
    endObservationAgeMs,
    endSkewMs
  }
}

export function windowsStreamAvDriftFitOptions(scenario) {
  const measurementSeconds = Number(scenario?.measurementMs) / 1_000
  return {
    minPairs: 5,
    minSpanSec:
      scenario?.avEndurance === true && Number.isFinite(measurementSeconds)
        ? measurementSeconds * 0.9
        : 30
  }
}

export function summarizeWindowsStreamBudgetProcessTelemetry(telemetry) {
  if (!isRecord(telemetry)) return null
  const totalCpuSamples = (telemetry?.cpu?.samples ?? [])
    .map((sample) => {
      const values = Object.values(sample?.byRole ?? {}).filter(Number.isFinite)
      return values.length > 0 ? values.reduce((total, value) => total + value, 0) : null
    })
    .filter(Number.isFinite)
  return {
    ...telemetry,
    cpu: {
      ...telemetry.cpu,
      summary: {
        ...telemetry?.cpu?.summary,
        totalP95Percent: percentileNearestRank(totalCpuSamples, 0.95)
      }
    }
  }
}

export function summarizeWindowsStreamBmpBudgetMetrics(samples, previewOpen) {
  const measured = (samples ?? []).filter(isRecord)
  const first = measured[0] ?? {}
  const last = measured.at(-1) ?? {}
  const firstRequests = finiteRecordTotal(first.previewImagePollCounts)
  const lastRequests = finiteRecordTotal(last.previewImagePollCounts)
  const requestCount =
    Number.isFinite(firstRequests) && Number.isFinite(lastRequests)
      ? Math.max(0, lastRequests - firstRequests)
      : null
  const frameValues = measured
    .map((sample) => sample?.previewSurfaceStatus?.framesRendered)
    .filter(Number.isFinite)
  const intervalValues = measured
    .map(
      (sample) => sample?.previewSurfaceStatus?.intervalP95Ms ?? sample?.previewRenderFrameTimeP95Ms
    )
    .filter(Number.isFinite)
  return {
    requestCount,
    // Zero requests proves zero response bytes. The backend does not expose
    // cumulative response bytes, so a nonzero request delta remains unknown
    // and therefore fails closed against a disabled-BMP budget.
    bytes: requestCount === 0 ? 0 : null,
    intervalP95Ms: intervalValues.length > 0 ? Math.max(...intervalValues) : null,
    advancedFrames: frameValues.length > 1 ? Math.max(0, frameValues.at(-1) - frameValues[0]) : null
  }
}

export function evaluateWindowsCaptureProtectionEvidence({
  roles,
  placementReadiness,
  requiredRoles = Object.keys(WINDOWS_CAPTURE_PROTECTION_MARKERS),
  maximumMarkerPixelRatio = 0.002
} = {}) {
  const failures = []
  const blockers = []
  const evidenceByRole = roles ?? {}
  if (placementReadiness?.verdict !== 'PASS') {
    blockers.push(
      ...(placementReadiness?.blockers?.length
        ? placementReadiness.blockers.map((blocker) => `placement: ${blocker}`)
        : ['capture-protection placement continuity was not proved'])
    )
  }
  const missingRoles = requiredRoles.filter((role) => !(role in evidenceByRole))
  if (missingRoles.length > 0) {
    blockers.push(
      `capture-protection evidence was missing required window roles: ${missingRoles.join(', ')}`
    )
  }
  const entries = Object.entries(evidenceByRole)
  for (const [role, evidence] of entries) {
    const sampledFrames = evidence?.markerMetrics?.sampledFrames ?? 0
    const expectedFrames = evidence?.expectedFrames
    const markerRatio = evidence?.markerMetrics?.maxMarkerPixelRatio
    if (sampledFrames <= 0 || !Number.isFinite(markerRatio)) {
      blockers.push(`${role}: capture-protection pixel sampler returned no decoded frames`)
    } else {
      if (!positiveInteger(expectedFrames) || sampledFrames !== expectedFrames) {
        blockers.push(
          `${role}: capture-protection pixel coverage ${sampledFrames}/${positiveInteger(expectedFrames) ? expectedFrames : 'missing'} decoded frames was incomplete`
        )
      }
      if (markerRatio > maximumMarkerPixelRatio) {
        failures.push(
          `${role}: Videorc marker leaked into the stream (${(markerRatio * 100).toFixed(3)}% > ${(maximumMarkerPixelRatio * 100).toFixed(3)}%)`
        )
      }
    }
    if (evidence?.stimulusVisibility?.visible !== true) {
      blockers.push(
        `${role}: underlying motion-stimulus signature was not present (${evidence?.stimulusVisibility?.reason ?? 'unmeasured'})`
      )
    } else if (
      evidence?.stimulusVisibility?.expectedFrames !== expectedFrames ||
      evidence?.stimulusVisibility?.completeFrames !== expectedFrames ||
      !Number.isFinite(evidence?.stimulusVisibility?.visibleFrameRatio) ||
      evidence.stimulusVisibility.visibleFrameRatio < 0.95
    ) {
      blockers.push(
        `${role}: underlying motion-stimulus temporal coverage did not prove at least 95% of decoded frames`
      )
    }
  }
  return {
    verdict: failures.length > 0 ? 'FAIL' : blockers.length > 0 ? 'BLOCKED' : 'PASS',
    markerAbsent:
      entries.length > 0 &&
      entries.every(([, evidence]) => {
        const ratio = evidence?.markerMetrics?.maxMarkerPixelRatio
        return Number.isFinite(ratio) && ratio <= maximumMarkerPixelRatio
      }),
    underlyingStimulusPresent:
      entries.length > 0 &&
      entries.every(([, evidence]) => evidence?.stimulusVisibility?.visible === true),
    failures,
    blockers,
    thresholds: { maximumMarkerPixelRatio },
    requiredRoles,
    placementReadiness: placementReadiness ?? null,
    roles: evidenceByRole
  }
}

export function measureWindowsCaptureProtectionMarkerPixels(
  rgb,
  { marker, width, height, maximumChannelDistance = 18 } = {}
) {
  const [targetRed, targetGreen, targetBlue] = parseHexColor(marker)
  const frameBytes = width * height * 3
  const sampledFrames = Math.floor((rgb?.length ?? 0) / frameBytes)
  let maxMarkerPixels = 0
  let totalMarkerPixels = 0
  for (let frame = 0; frame < sampledFrames; frame += 1) {
    const start = frame * frameBytes
    let markerPixels = 0
    for (let offset = start; offset < start + frameBytes; offset += 3) {
      if (
        Math.abs(rgb[offset] - targetRed) <= maximumChannelDistance &&
        Math.abs(rgb[offset + 1] - targetGreen) <= maximumChannelDistance &&
        Math.abs(rgb[offset + 2] - targetBlue) <= maximumChannelDistance
      ) {
        markerPixels += 1
      }
    }
    maxMarkerPixels = Math.max(maxMarkerPixels, markerPixels)
    totalMarkerPixels += markerPixels
  }
  const framePixels = width * height
  return {
    marker,
    sampleWidth: width,
    sampleHeight: height,
    sampledFrames,
    framePixels,
    maxMarkerPixels,
    totalMarkerPixels,
    maxMarkerPixelRatio: framePixels > 0 ? maxMarkerPixels / framePixels : 0,
    meanMarkerPixelRatio:
      sampledFrames > 0 && framePixels > 0 ? totalMarkerPixels / (sampledFrames * framePixels) : 0
  }
}

export function parseWindowsStreamDisplayBounds(value) {
  const parts = String(value ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
  if (parts.length !== 4 || !parts.every(Number.isInteger) || parts[2] < 640 || parts[3] < 480) {
    throw new Error(
      'VIDEORC_WINDOWS_ACCEPTANCE_DISPLAY_BOUNDS must be x,y,width,height with integer dimensions of at least 640x480.'
    )
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
}

export function parseWindowsDxgiOutputDeviceName(detail) {
  const value = nonEmptyString(detail) ? detail.trim() : ''
  const prefix = 'Windows DXGI output '
  if (!value.startsWith(prefix) || !value.endsWith('.')) {
    throw new Error(
      'The selected screen detail did not contain a canonical Windows DXGI output device name.'
    )
  }
  const description = value.slice(prefix.length, -1)
  const adapterSeparator = description.indexOf(' on ')
  const deviceName = adapterSeparator === -1 ? description : description.slice(0, adapterSeparator)
  const adapterName =
    adapterSeparator === -1 ? null : description.slice(adapterSeparator + ' on '.length)
  if (
    !/^\\\\\.\\DISPLAY[1-9]\d*$/u.test(deviceName) ||
    (adapterSeparator !== -1 && !nonEmptyString(adapterName))
  ) {
    throw new Error(
      'The selected screen detail did not contain a canonical Windows DXGI output device name.'
    )
  }
  return deviceName
}

export function evaluateWindowsStreamDxgiDisplayBinding({
  selectedScreen,
  displayTopology,
  expectedPhysicalBounds,
  expectedElectronBounds
} = {}) {
  const blockers = []
  let deviceName = null
  try {
    deviceName = parseWindowsDxgiOutputDeviceName(selectedScreen?.detail)
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error))
  }

  const physicalBounds = isIntegerRectangle(expectedPhysicalBounds)
    ? { ...expectedPhysicalBounds }
    : null
  const electronBounds = isIntegerRectangle(expectedElectronBounds)
    ? { ...expectedElectronBounds }
    : null
  if (!physicalBounds) blockers.push('Expected physical display bounds were missing or invalid.')
  if (!electronBounds) blockers.push('Expected Electron display bounds were missing or invalid.')
  if (
    physicalBounds &&
    electronBounds &&
    !rectanglesApproximatelyEqual(physicalBounds, electronBounds, 0)
  ) {
    blockers.push('Expected Electron and physical display bounds did not match exactly.')
  }

  const topology = Array.isArray(displayTopology) ? displayTopology : []
  if (!Array.isArray(displayTopology)) {
    blockers.push('The authoritative Windows display topology was missing.')
  }
  for (const [index, display] of topology.entries()) {
    if (!nonEmptyString(display?.deviceName)) {
      blockers.push(`Authoritative Windows display ${index} had no device name.`)
    } else if (!/^\\\\\.\\DISPLAY[1-9]\d*$/u.test(display.deviceName)) {
      blockers.push(`Authoritative Windows display ${index} had a non-canonical device name.`)
    }
    if (!isIntegerRectangle(display?.desktopBounds)) {
      blockers.push(`Authoritative Windows display ${index} had invalid desktop bounds.`)
    }
  }
  const exactMatches = deviceName
    ? topology.filter((display) => display?.deviceName === deviceName)
    : []
  if (deviceName && exactMatches.length !== 1) {
    blockers.push(
      `The selected DXGI device ${deviceName} matched ${exactMatches.length} authoritative Windows displays; expected exactly one.`
    )
  }
  const match = exactMatches.length === 1 ? exactMatches[0] : null
  const matchedBounds = isIntegerRectangle(match?.desktopBounds) ? { ...match.desktopBounds } : null
  if (match && !matchedBounds) {
    blockers.push(`The selected DXGI device ${deviceName} had invalid physical desktop bounds.`)
  }
  if (
    matchedBounds &&
    physicalBounds &&
    !rectanglesApproximatelyEqual(matchedBounds, physicalBounds, 0)
  ) {
    blockers.push(
      `The selected DXGI device ${deviceName} did not match the expected physical desktop bounds exactly.`
    )
  }
  if (
    matchedBounds &&
    electronBounds &&
    !rectanglesApproximatelyEqual(matchedBounds, electronBounds, 0)
  ) {
    blockers.push(
      `The selected DXGI device ${deviceName} did not match the expected Electron display bounds exactly.`
    )
  }

  return {
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers,
    deviceName,
    matchCount: exactMatches.length,
    matchedDisplay:
      match && matchedBounds
        ? {
            deviceName: match.deviceName,
            desktopBounds: matchedBounds
          }
        : null,
    expectedPhysicalBounds: physicalBounds,
    expectedElectronBounds: electronBounds
  }
}

export function windowsStreamCaptureProtectionPlacement(
  displayBounds,
  { outputWidth = 1920, outputHeight = 1080, electronDisplay } = {}
) {
  const bounds = parseWindowsStreamDisplayBounds(
    `${displayBounds?.x},${displayBounds?.y},${displayBounds?.width},${displayBounds?.height}`
  )
  const matchedDisplay = resolveWindowsStreamElectronDisplay(bounds, [electronDisplay])
  if (bounds.width * outputHeight !== bounds.height * outputWidth) {
    throw new Error(
      `The selected DXGI display must exactly match the ${outputWidth}:${outputHeight} acceptance aspect ratio so evidence crops cannot fall into compositor letterboxing.`
    )
  }
  const mapGlobal = ({ x, y, width, height }) => ({
    x: bounds.x + Math.round((x / outputWidth) * bounds.width),
    y: bounds.y + Math.round((y / outputHeight) * bounds.height),
    width: Math.round((width / outputWidth) * bounds.width),
    height: Math.round((height / outputHeight) * bounds.height)
  })
  return {
    displayBinding: matchedDisplay,
    // The independent every-frame-changing fixture is the background behind
    // every protected crop. The audible/flash fixture occupies the otherwise
    // unused lower-left region and never masks a protected role.
    motion: mapGlobal({ x: 0, y: 0, width: outputWidth, height: outputHeight }),
    av: mapGlobal({ x: 16, y: 700, width: 880, height: 360 }),
    windows: {
      main: mapGlobal({ x: 16, y: 16, width: 960, height: 660 }),
      comments: mapGlobal({ x: 1450, y: 24, width: 420, height: 360 }),
      notes: mapGlobal({ x: 1450, y: 392, width: 420, height: 300 }),
      captions: mapGlobal({ x: 930, y: 730, width: 420, height: 300 }),
      preview: mapGlobal({ x: 1450, y: 730, width: 420, height: 300 })
    },
    crops: {
      main: { x: 40, y: 40, width: 300, height: 220 },
      comments: { x: 1490, y: 64, width: 300, height: 220 },
      notes: { x: 1490, y: 432, width: 300, height: 220 },
      captions: { x: 970, y: 770, width: 300, height: 220 },
      preview: { x: 1490, y: 770, width: 300, height: 220 },
      'proof-surface': { x: 1490, y: 770, width: 300, height: 220 }
    },
    cropBounds: Object.fromEntries(
      Object.entries({
        main: { x: 40, y: 40, width: 300, height: 220 },
        comments: { x: 1490, y: 64, width: 300, height: 220 },
        notes: { x: 1490, y: 432, width: 300, height: 220 },
        captions: { x: 970, y: 770, width: 300, height: 220 },
        preview: { x: 1490, y: 770, width: 300, height: 220 },
        'proof-surface': { x: 1490, y: 770, width: 300, height: 220 }
      }).map(([role, crop]) => [role, mapGlobal(crop)])
    )
  }
}

export function resolveWindowsStreamElectronDisplay(displayBounds, displays) {
  const physicalBounds = parseWindowsStreamDisplayBounds(
    `${displayBounds?.x},${displayBounds?.y},${displayBounds?.width},${displayBounds?.height}`
  )
  const matches = (displays ?? []).filter(
    (display) =>
      isRecord(display) &&
      isRectangle(display.bounds) &&
      display.scaleFactor === 1 &&
      rectanglesApproximatelyEqual(display.bounds, physicalBounds, 0)
  )
  if (matches.length !== 1) {
    throw new Error(
      `The selected DXGI display must match exactly one Electron display at 100% scaling; found ${matches.length}.`
    )
  }
  const match = matches[0]
  return {
    id: String(match.id),
    bounds: { ...match.bounds },
    scaleFactor: match.scaleFactor
  }
}

export function evaluateWindowsCaptureProtectionPlacement({
  placement,
  states,
  requiredRoles = Object.keys(WINDOWS_CAPTURE_PROTECTION_MARKERS),
  boundsTolerancePx = 3
} = {}) {
  const blockers = []
  const evidence = {}
  for (const role of requiredRoles) {
    const state = states?.[role]
    const actualBounds = state?.bounds
    const expectedBounds = placement?.windows?.[role]
    const cropBounds = placement?.cropBounds?.[role]
    const roleBlockers = []
    if (!isRecord(state)) roleBlockers.push('state was missing')
    if (state?.open !== true && role !== 'proof-surface') roleBlockers.push('window was not open')
    if (state?.exists !== true && role === 'proof-surface')
      roleBlockers.push('surface did not exist')
    if (state?.visible !== true) roleBlockers.push('window was not visible')
    if (state?.captureProtectionMarkerInstalled !== true) {
      roleBlockers.push('capture-protection marker was not acknowledged')
    }
    if (!isRectangle(actualBounds)) {
      roleBlockers.push('actual bounds were missing')
    } else {
      if (
        expectedBounds &&
        !rectanglesApproximatelyEqual(actualBounds, expectedBounds, boundsTolerancePx)
      ) {
        roleBlockers.push('actual bounds did not match requested placement')
      }
      if (isRectangle(cropBounds) && !rectangleContains(actualBounds, cropBounds)) {
        roleBlockers.push('window did not cover its evidence crop')
      }
    }
    if (roleBlockers.length > 0) {
      blockers.push(`${role}: ${roleBlockers.join('; ')}`)
    }
    evidence[role] = { ...state, expectedBounds: expectedBounds ?? null, cropBounds, roleBlockers }
  }
  return {
    verdict: blockers.length > 0 ? 'BLOCKED' : 'PASS',
    blockers,
    requiredRoles,
    roles: evidence
  }
}

export function evaluateWindowsCaptureProtectionPlacementTimeline({
  initial,
  timeline,
  final
} = {}) {
  const blockers = []
  if (initial?.verdict !== 'PASS') {
    blockers.push(
      ...(initial?.blockers?.length
        ? initial.blockers.map((blocker) => `initial: ${blocker}`)
        : ['initial placement evidence was missing'])
    )
  }
  const expectedSamples = timeline?.expectedSamples
  const intervalMs = timeline?.intervalMs
  const measurementMs = timeline?.measurementMs
  const maximumSampleLatenessMs = timeline?.maximumSampleLatenessMs
  const measurementStartedAtMs = timeline?.measurementStartedAtMs
  const measurementEndedAtMs = timeline?.measurementEndedAtMs
  const samples = Array.isArray(timeline?.samples) ? timeline.samples : []
  if (!positiveInteger(expectedSamples) || samples.length !== expectedSamples) {
    blockers.push(
      `measurement placement coverage ${samples.length}/${positiveInteger(expectedSamples) ? expectedSamples : 'missing'} was incomplete`
    )
  }
  if (!positiveInteger(intervalMs)) {
    blockers.push('measurement placement interval was missing or invalid')
  }
  if (!positiveInteger(measurementMs)) {
    blockers.push('measurement placement duration was missing or invalid')
  }
  if (!positiveInteger(maximumSampleLatenessMs)) {
    blockers.push('measurement placement lateness ceiling was missing or invalid')
  }
  if (!Number.isFinite(measurementStartedAtMs) || !Number.isFinite(measurementEndedAtMs)) {
    blockers.push('measurement placement start/end timestamps were missing')
  } else if (positiveInteger(measurementMs) && positiveInteger(maximumSampleLatenessMs)) {
    const measuredSpanMs = measurementEndedAtMs - measurementStartedAtMs
    if (
      measuredSpanMs < measurementMs ||
      measuredSpanMs > measurementMs + maximumSampleLatenessMs
    ) {
      blockers.push(
        `measurement placement span ${measuredSpanMs}ms did not cover ${measurementMs}ms within ${maximumSampleLatenessMs}ms lateness`
      )
    }
  }
  let previousSampledAtMs = null
  for (const [index, sample] of samples.entries()) {
    const scheduledAtMs = sample?.scheduledAtMs
    const sampledAtMs = sample?.sampledAtMs
    if (
      positiveInteger(intervalMs) &&
      Number.isFinite(measurementStartedAtMs) &&
      scheduledAtMs !== measurementStartedAtMs + index * intervalMs
    ) {
      blockers.push(`measurement sample ${index + 1}: scheduled timestamp was not slot-aligned`)
    }
    if (!Number.isFinite(scheduledAtMs) || !Number.isFinite(sampledAtMs)) {
      blockers.push(`measurement sample ${index + 1}: timestamps were missing`)
    } else {
      const latenessMs = sampledAtMs - scheduledAtMs
      if (
        latenessMs < 0 ||
        (positiveInteger(maximumSampleLatenessMs) && latenessMs > maximumSampleLatenessMs)
      ) {
        blockers.push(
          `measurement sample ${index + 1}: ${latenessMs}ms lateness exceeded ${positiveInteger(maximumSampleLatenessMs) ? maximumSampleLatenessMs : 'missing'}ms`
        )
      }
      if (
        previousSampledAtMs !== null &&
        positiveInteger(intervalMs) &&
        positiveInteger(maximumSampleLatenessMs) &&
        sampledAtMs - previousSampledAtMs < intervalMs - maximumSampleLatenessMs
      ) {
        blockers.push(
          `measurement sample ${index + 1}: samples were clustered after a blind interval`
        )
      }
      if (previousSampledAtMs !== null && sampledAtMs <= previousSampledAtMs) {
        blockers.push(`measurement sample ${index + 1}: sampled timestamps were not monotonic`)
      }
      previousSampledAtMs = sampledAtMs
    }
    if (sample?.evaluation?.verdict !== 'PASS') {
      const reasons = sample?.evaluation?.blockers?.join('; ') || 'placement state was unavailable'
      blockers.push(`measurement sample ${index + 1}: ${reasons}`)
    }
  }
  if (final?.verdict !== 'PASS') {
    blockers.push(
      ...(final?.blockers?.length
        ? final.blockers.map((blocker) => `final: ${blocker}`)
        : ['final placement evidence was missing'])
    )
  }
  return {
    verdict: blockers.length > 0 ? 'BLOCKED' : 'PASS',
    blockers,
    initial: initial ?? null,
    timeline: timeline ?? null,
    final: final ?? null
  }
}

export async function loadWindowsStreamPerformanceBudget({
  path,
  context,
  profileId,
  read = readFile,
  verifyArtifact
}) {
  return loadWindowsPerformanceBudget({
    path,
    context,
    profileId,
    read,
    requireComparison: true,
    ...(verifyArtifact ? { verifyArtifact } : {})
  })
}

export function validateWindowsStreamPerformanceBudget(document) {
  return validateWindowsPerformanceBudget(document, { requireComparison: true })
}

export function evaluateWindowsStreamResourceBudget(profile, metrics) {
  return evaluateWindowsPerformanceBudget(profile, metrics)
}

function takeFlag(values, name) {
  const index = values.indexOf(name)
  if (index === -1) return false
  values.splice(index, 1)
  return true
}

function parseHexColor(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`Capture-protection marker must be a six-digit hex color; received ${value}.`)
  }
  return [1, 3, 5].map((start) => Number.parseInt(value.slice(start, start + 2), 16))
}

function takeOption(values, name) {
  const equalsIndex = values.findIndex((value) => value.startsWith(`${name}=`))
  if (equalsIndex !== -1) {
    return values.splice(equalsIndex, 1)[0].slice(name.length + 1)
  }
  const index = values.indexOf(name)
  if (index === -1) return undefined
  if (index + 1 >= values.length || values[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a value.`)
  }
  const [, value] = values.splice(index, 2)
  return value
}

function requireAtMost(failures, label, value, maximum, message) {
  if (!Number.isFinite(value)) failures.push(`${label} metric was missing`)
  else if (value - maximum > Number.EPSILON * Math.max(1, Math.abs(maximum)) * 8) {
    failures.push(message ?? `${label} ${formatNumber(value)} exceeded ${formatNumber(maximum)}`)
  }
}

function requireAtLeast(failures, label, value, minimum) {
  if (!Number.isFinite(value)) failures.push(`${label} metric was missing`)
  else if (minimum - value > Number.EPSILON * Math.max(1, Math.abs(minimum)) * 8) {
    failures.push(`${label} ${formatNumber(value)} was below ${formatNumber(minimum)}`)
  }
}

function requireEqual(failures, label, value, expected) {
  if (value !== expected) failures.push(`${label} ${value ?? 'missing'} did not equal ${expected}`)
}

function requirePositive(failures, label, value) {
  if (!Number.isFinite(value) || value <= 0) failures.push(`${label} must be greater than zero`)
}

function ratioDifference(value, expected) {
  if (!Number.isFinite(value) || !Number.isFinite(expected) || expected <= 0) return Number.NaN
  return Math.abs(value - expected) / expected
}

function finiteOrNaN(value) {
  return Number.isFinite(value) ? value : Number.NaN
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(Number(value.toFixed(3))) : 'missing'
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function diagnosticStateSet(samples, select) {
  return new Set(
    samples.map((sample) => {
      const value = select(sample)
      return nonEmptyString(value) ? value.trim() : '<missing>'
    })
  )
}

function lastNonEmptyString(values) {
  return [...values].reverse().find(nonEmptyString)?.trim() ?? null
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function isRectangle(value) {
  return (
    isRecord(value) &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width > 0 &&
    value.height > 0
  )
}

function isIntegerRectangle(value) {
  return (
    isRectangle(value) &&
    ['x', 'y', 'width', 'height'].every((field) => Number.isInteger(value[field]))
  )
}

function rectanglesApproximatelyEqual(left, right, tolerance) {
  return ['x', 'y', 'width', 'height'].every(
    (field) => Math.abs(left[field] - right[field]) <= tolerance
  )
}

function rectangleContains(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

function counterDelta(first, last) {
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return null
  return last - first
}

function maxFinite(values) {
  const finite = values.filter((value) => Number.isFinite(value))
  return finite.length > 0 ? Math.max(...finite) : null
}

function monotonicDiagnosticCounterFailures(samples, field) {
  let previous = null
  for (const [index, sample] of samples.entries()) {
    const value = sample?.[field]
    if (!Number.isFinite(value) || value < 0) {
      return [`diagnostic cumulative counter ${field} was missing or invalid at sample ${index}`]
    }
    if (previous !== null && value < previous) {
      return [`diagnostic cumulative counter ${field} decreased at sample ${index}`]
    }
    previous = value
  }
  return []
}

function finiteRecordTotal(value) {
  if (!isRecord(value)) return null
  const counters = Object.values(value).filter(Number.isFinite)
  return counters.length > 0 ? counters.reduce((total, counter) => total + counter, 0) : null
}

function percentileNearestRank(values, percentile) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]
}
