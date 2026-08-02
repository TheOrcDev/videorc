import { readFile } from 'node:fs/promises'

import {
  WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND,
  attachWindowsNaturalFallbackPolicy,
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

export const WINDOWS_STREAM_NATURAL_FALLBACK_SCENARIOS = Object.freeze([
  '1080p30-stream-preview',
  '1080p30-stream-no-preview',
  '1080p30-record-stream-preview',
  '1080p30-record-stream-no-preview'
])

export const WINDOWS_STREAM_D3D11_PREVIEW = Object.freeze({
  transport: 'd3d11-shared-texture',
  backing: 'directcomposition-swapchain',
  hostKind: 'backend-d3d11-presenter'
})

export const WINDOWS_STREAM_NATURAL_FALLBACK_HARDWARE_CLASS = 'unsupported-natural-fallback'

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
    for (const sourceComposition of ['screen-only', 'screen-camera']) {
      for (const topology of ['stream', 'record-stream']) {
        for (const previewOpen of [true, false]) {
          const sourceId = sourceComposition === 'screen-only' ? '' : 'screen-camera-'
          scenarios.push(
            Object.freeze({
              id: `1080p${fps}-${sourceId}${topology}-${previewOpen ? 'preview' : 'no-preview'}`,
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
              sourceComposition,
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
      sourceComposition: 'screen-only',
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
    sourceComposition: 'screen-only',
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
      `${index + 1}. ${scenario.id} — ${scenario.width}x${scenario.height}@${scenario.fps} | ${scenario.sourceComposition} | ` +
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
  const deriveNaturalFallbackPolicy = takeFlag(values, '--derive-natural-fallback-policy')
  const preparePremiumProfile = takeFlag(values, '--prepare-premium-profile')
  const requireBridge = takeFlag(values, '--require-bridge')
  const d3d11 = takeFlag(values, '--d3d11')
  const requireD3d11 = takeFlag(values, '--require-d3d11')
  const videoOnly = takeFlag(values, '--video-only')
  if (gate && calibrate) {
    throw new Error('--gate and --calibrate are mutually exclusive.')
  }

  const scenarioId = takeOption(values, '--scenario')
  const requestedRuns = takeOption(values, '--runs')
  const expectFallback = takeOption(values, '--expect-fallback')
  const requestedProfiles = takeOption(values, '--profiles')
  const pathEvidence = takeOption(values, '--path-evidence')
  const fallbackCalibrations = takeOption(values, '--fallback-calibrations')
  const budget = takeOption(values, '--budget')
  const bridge =
    takeOption(values, '--bridge') ?? (expectFallback === 'software-open-h264' ? 'mf' : 'auto')
  const output = takeOption(values, '--output')
  if (values.length > 0) {
    throw new Error(`Unknown Windows stream performance argument: ${values[0]}`)
  }
  if (deriveNaturalFallbackPolicy) {
    if (
      list ||
      gate ||
      calibrate ||
      preparePremiumProfile ||
      requireBridge ||
      d3d11 ||
      requireD3d11 ||
      videoOnly ||
      scenarioId ||
      requestedRuns !== undefined ||
      expectFallback ||
      requestedProfiles ||
      pathEvidence ||
      bridge !== 'auto' ||
      output
    ) {
      throw new Error(
        '--derive-natural-fallback-policy cannot be combined with launch or run-selection options.'
      )
    }
    if (!fallbackCalibrations || !budget) {
      throw new Error(
        '--derive-natural-fallback-policy requires --fallback-calibrations and --budget.'
      )
    }
    assertSinglePortableAbsolutePath(fallbackCalibrations, '--fallback-calibrations')
    assertLiteralPath(budget, '--budget')
    if (!budget.toLocaleLowerCase('en-US').endsWith('.json')) {
      throw new Error('--budget must identify one JSON budget document.')
    }
    return {
      list: false,
      mode: 'derive-natural-fallback-policy',
      deriveNaturalFallbackPolicy: true,
      fallbackCalibrations,
      budget,
      preparePremiumProfile: false,
      scenarios: [],
      scenarioId: null,
      repetitions: 0,
      bridge: 'auto',
      expectFallback: null,
      requireBridge: false,
      d3d11: false,
      requireD3d11: false,
      profiles: [],
      pathEvidence: null,
      videoOnly: false,
      output: null
    }
  }
  if (fallbackCalibrations !== undefined || budget !== undefined) {
    throw new Error(
      '--fallback-calibrations and --budget require --derive-natural-fallback-policy.'
    )
  }
  if (!['auto', 'mf', 'raw'].includes(bridge)) {
    throw new Error(`--bridge must be auto, mf, or raw; received ${bridge}.`)
  }
  if (requireBridge && bridge !== 'mf') {
    throw new Error('--require-bridge requires --bridge mf.')
  }
  if (requireD3d11 && !d3d11) {
    throw new Error('--require-d3d11 requires --d3d11.')
  }
  if (expectFallback !== undefined && !['software-open-h264', 'natural'].includes(expectFallback)) {
    throw new Error(
      `--expect-fallback must be software-open-h264 or natural; received ${expectFallback}.`
    )
  }
  if (expectFallback === 'software-open-h264' && (bridge !== 'mf' || requireBridge)) {
    throw new Error(
      '--expect-fallback software-open-h264 requests --bridge mf without --require-bridge.'
    )
  }
  if (expectFallback === 'natural' && (d3d11 || requireD3d11)) {
    throw new Error('--expect-fallback natural cannot be combined with an explicit D3D11 path.')
  }
  if (pathEvidence !== undefined && !['forced', 'default', 'natural'].includes(pathEvidence)) {
    throw new Error(
      `--path-evidence must be forced, default, or natural; received ${pathEvidence}.`
    )
  }
  if (pathEvidence === 'forced' && (!d3d11 || !requireD3d11)) {
    throw new Error('--path-evidence forced requires --d3d11 --require-d3d11.')
  }
  if (pathEvidence === 'natural' && expectFallback !== 'natural') {
    throw new Error('--path-evidence natural requires --expect-fallback natural.')
  }
  if (pathEvidence === 'default' && (d3d11 || requireD3d11 || expectFallback)) {
    throw new Error('--path-evidence default must use automatic capability selection.')
  }
  const mode = calibrate ? 'calibrate' : gate || !scenarioId ? 'gate' : 'diagnostic'
  if (mode === 'gate' && bridge === 'raw') {
    throw new Error(
      'The protected gate cannot use --bridge raw; it must prove the Media Foundation production path.'
    )
  }
  if (mode === 'gate' && expectFallback === 'software-open-h264') {
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
      d3d11 ||
      requireD3d11 ||
      requestedProfiles ||
      pathEvidence ||
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
      deriveNaturalFallbackPolicy: false,
      fallbackCalibrations: null,
      budget: null,
      preparePremiumProfile: true,
      scenarios: [],
      scenarioId: null,
      repetitions: 0,
      bridge: 'auto',
      expectFallback: null,
      requireBridge: false,
      d3d11: false,
      requireD3d11: false,
      profiles: [],
      pathEvidence: null,
      videoOnly: false,
      output: output ?? null
    }
  }

  const profiles =
    requestedProfiles === undefined
      ? []
      : requestedProfiles.split(',').map((profile) => profile.trim())
  if (profiles.some((profile) => !profile)) {
    throw new Error('--profiles must contain non-empty comma-separated values.')
  }
  const duplicateProfiles = profiles.filter((profile, index) => profiles.indexOf(profile) !== index)
  if (duplicateProfiles.length > 0) {
    throw new Error(`Duplicate Windows stream profile: ${duplicateProfiles[0]}.`)
  }
  const unknownProfile = profiles.find((profile) => !['1080p30', '1080p60'].includes(profile))
  if (unknownProfile) {
    throw new Error(`Unknown Windows stream profile: ${unknownProfile}.`)
  }
  if (scenarioId && profiles.length > 0) {
    throw new Error('--scenario and --profiles are mutually exclusive.')
  }
  const scenarios = scenarioId
    ? matrix.filter((scenario) => scenario.id === scenarioId)
    : profiles.length > 0
      ? matrix.filter((scenario) => profiles.includes(scenario.fps === 60 ? '1080p60' : '1080p30'))
      : matrix
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
  if (expectFallback === 'natural') {
    if (
      !['calibrate', 'gate'].includes(mode) ||
      scenarioId ||
      profiles.length !== 1 ||
      profiles[0] !== '1080p30' ||
      requestedRuns !== undefined ||
      bridge !== 'auto' ||
      requireBridge
    ) {
      throw new Error(
        'Natural fallback runs require exactly --calibrate/--gate --profiles 1080p30 --expect-fallback natural.'
      )
    }
  }

  const selectedScenarios =
    expectFallback === 'natural'
      ? matrix.filter((scenario) => WINDOWS_STREAM_NATURAL_FALLBACK_SCENARIOS.includes(scenario.id))
      : scenarios
  if (
    expectFallback === 'natural' &&
    (selectedScenarios.length !== WINDOWS_STREAM_NATURAL_FALLBACK_SCENARIOS.length ||
      selectedScenarios.some((scenario) => scenario.repetitions !== 3))
  ) {
    throw new Error(
      'Natural fallback calibration matrix must contain exactly four 1080p30 contexts with three repetitions.'
    )
  }

  return {
    list,
    mode,
    deriveNaturalFallbackPolicy: false,
    fallbackCalibrations: null,
    budget: null,
    preparePremiumProfile: false,
    scenarios: selectedScenarios,
    scenarioId: scenarioId ?? null,
    repetitions,
    bridge,
    expectFallback: expectFallback ?? null,
    requireBridge,
    d3d11,
    requireD3d11,
    profiles,
    pathEvidence: pathEvidence ?? (expectFallback === 'natural' ? 'natural' : null),
    videoOnly,
    output: output ?? null
  }
}

export function resolveWindowsStreamPathEvidence(options) {
  if (options?.pathEvidence) return options.pathEvidence
  if (options?.expectFallback === 'natural') return 'natural'
  return options?.d3d11 === true && options?.requireD3d11 === true ? 'forced' : 'default'
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
  if (!/^[a-f0-9]{40}$/.test(evidence?.candidate?.sourceCommit ?? '')) {
    failures.push('candidate.sourceCommit must be a lowercase 40-character commit')
  }
  if (!/^[a-f0-9]{64}$/.test(evidence?.candidate?.installerSha256 ?? '')) {
    failures.push('candidate.installerSha256 must be a lowercase SHA-256 digest')
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
  if (
    evidence?.pipeline?.requireD3d11 === true ||
    ['forced', 'default'].includes(evidence?.pipeline?.expectedD3d11Path)
  ) {
    requireEqual(failures, 'D3D11 media state', evidence?.pipeline?.d3d11?.state, 'live')
    requireEqual(failures, 'D3D11 media requested', evidence?.pipeline?.d3d11?.requested, true)
    requireEqual(
      failures,
      'D3D11 media required mode',
      evidence?.pipeline?.d3d11?.required,
      evidence?.pipeline?.expectedD3d11Path === 'forced'
    )
    validateWindowsD3d11AdapterEvidence(evidence?.pipeline?.d3d11, failures, {
      auxiliaryRequired: scenario?.recordEnabled === true
    })
    requireEqual(
      failures,
      'D3D11 capture readback frames',
      evidence?.pipeline?.d3d11?.captureReadbackFrames,
      0
    )
    requireEqual(
      failures,
      'D3D11 compositor CPU fallback frames',
      evidence?.pipeline?.d3d11?.compositorCpuFallbackFrames,
      0
    )
    requireEqual(
      failures,
      'D3D11 encoder system-memory samples',
      evidence?.pipeline?.d3d11?.encoderSystemMemorySamples,
      0
    )
    requireEqual(
      failures,
      'D3D11 raw video copied frames',
      evidence?.pipeline?.d3d11?.rawVideoCopiedFrames,
      0
    )
    requireEqual(
      failures,
      'D3D11 preview BMP requests',
      evidence?.pipeline?.d3d11?.previewBmpRequests,
      0
    )
    requireEqual(failures, 'D3D11 preview BMP bytes', evidence?.pipeline?.d3d11?.previewBmpBytes, 0)
    requirePositive(
      failures,
      'D3D11 texture imports',
      evidence?.pipeline?.d3d11?.textureImportFrames
    )
    requirePositive(
      failures,
      'D3D11 encoder GPU samples',
      evidence?.pipeline?.d3d11?.encoderGpuSamples
    )
    if (scenario?.sourceComposition === 'screen-camera') {
      requirePositive(
        failures,
        'D3D11 camera upload frames',
        evidence?.pipeline?.d3d11?.cameraUploadFrames
      )
    } else {
      requireEqual(
        failures,
        'D3D11 camera upload frames',
        evidence?.pipeline?.d3d11?.cameraUploadFrames,
        0
      )
    }
    requireEqual(
      failures,
      'D3D11 cursor correctness',
      evidence?.pipeline?.d3d11?.cursorCorrect,
      true
    )
    if (scenario?.previewOpen === true) {
      requireEqual(
        failures,
        'D3D11 preview input continuity',
        evidence?.pipeline?.d3d11?.inputContinuity,
        true
      )
      requireEqual(
        failures,
        'D3D11 preview physical-input evidence verdict',
        evidence?.pipeline?.d3d11?.inputContinuityEvidence?.verdict,
        'PASS'
      )
      requireEqual(
        failures,
        'D3D11 preview physical-input execution',
        evidence?.pipeline?.d3d11?.inputContinuityEvidence?.physicalInput,
        true
      )
      requireEqual(
        failures,
        'D3D11 preview input applicability',
        evidence?.pipeline?.d3d11?.inputContinuityEvidence?.applicable,
        true
      )
    } else {
      requireEqual(
        failures,
        'D3D11 closed-preview input applicability',
        evidence?.pipeline?.d3d11?.inputContinuityEvidence?.applicable,
        false
      )
    }
    requireAtMost(
      failures,
      'D3D11 message dispatch p95',
      evidence?.pipeline?.d3d11?.messageDispatchP95Ms,
      50
    )
    requireAtMost(
      failures,
      'D3D11 message dispatch maximum',
      evidence?.pipeline?.d3d11?.messageDispatchMaxMs,
      100
    )
    for (const [label, value] of [
      ['D3D11 texture-pool pressure events', evidence?.pipeline?.d3d11?.texturePoolPressureEvents],
      ['D3D11 adapter mismatches', evidence?.pipeline?.d3d11?.adapterMismatches],
      ['D3D11 device resets', evidence?.pipeline?.d3d11?.deviceResets]
    ]) {
      requireEqual(failures, label, value, 0)
    }
    if (scenario?.previewOpen === true) {
      requirePositive(
        failures,
        'D3D11 preview presents',
        evidence?.pipeline?.d3d11?.previewPresents
      )
    }
    if (nonEmptyString(evidence?.pipeline?.d3d11?.fallbackReason)) {
      failures.push(
        `D3D11-required run reported fallback: ${evidence.pipeline.d3d11.fallbackReason}`
      )
    }
    if (
      evidence?.pipeline?.d3d11?.stateChanged === true ||
      evidence?.pipeline?.d3d11?.adapterChanged === true ||
      evidence?.pipeline?.d3d11?.fallbackChanged === true
    ) {
      failures.push('D3D11 path identity changed during the measured run')
    }
  }
  if (evidence?.pipeline?.expectedFallback === 'natural') {
    requireEqual(
      failures,
      'natural D3D11 fallback state',
      evidence?.pipeline?.d3d11?.state,
      'fallback'
    )
    if (!nonEmptyString(evidence?.pipeline?.d3d11?.fallbackReason)) {
      failures.push('natural D3D11 fallback reason was missing')
    }
    if (evidence?.pipeline?.d3d11?.captureBackend !== 'legacy-ffmpeg') {
      failures.push('natural D3D11 fallback did not report the legacy capture backend')
    }
    for (const field of [
      'adapterLuid',
      'captureAdapterLuid',
      'compositorAdapterLuid',
      'primaryEncoderAdapterLuid',
      'auxiliaryEncoderAdapterLuid'
    ]) {
      if (nonEmptyString(evidence?.pipeline?.d3d11?.[field])) {
        failures.push(`natural D3D11 fallback must not claim ${field}`)
      }
    }
    requireEqual(
      failures,
      'natural fallback media verdict',
      evidence?.calibration?.mediaVerdict,
      'PASS'
    )
    requireEqual(
      failures,
      'natural fallback lifecycle verdict',
      evidence?.calibration?.lifecycleVerdict,
      'PASS'
    )
    requireEqual(
      failures,
      'natural fallback proof-surface verdict',
      evidence?.calibration?.previewProofSurfaceVerdict,
      'PASS'
    )
    if (evidence?.context?.profile !== '1080p30') {
      failures.push('natural fallback attempted to qualify a profile other than 1080p30')
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

export function evaluateWindowsStreamAggregate({ mode, runs, scenarios }) {
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
    (scenarios ?? buildWindowsStreamPerformanceMatrix()).flatMap((scenario) =>
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
  const firstD3d11 = isRecord(first.windowsD3d11Media) ? first.windowsD3d11Media : {}
  const lastD3d11 = isRecord(last.windowsD3d11Media) ? last.windowsD3d11Media : {}
  const d3d11States = diagnosticStateSet(measured, (sample) => sample.windowsD3d11Media?.state)
  const d3d11Adapters = diagnosticStateSet(
    measured,
    (sample) => sample.windowsD3d11Media?.adapterLuid
  )
  const d3d11RoleAdapters = [
    'captureAdapterLuid',
    'compositorAdapterLuid',
    'primaryEncoderAdapterLuid',
    'auxiliaryEncoderAdapterLuid'
  ].map((field) => diagnosticStateSet(measured, (sample) => sample.windowsD3d11Media?.[field]))
  const d3d11FallbackReasons = diagnosticStateSet(
    measured,
    (sample) => sample.windowsD3d11Media?.fallbackReason
  )
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
      fallbackStates
    ].some((states) => states.size > 1),
    ...(measured.some((sample) => isRecord(sample.windowsD3d11Media))
      ? {
          d3d11: {
            state: lastD3d11.state ?? null,
            requested: lastD3d11.requested === true,
            required: lastD3d11.required === true,
            adapterLuid: lastD3d11.adapterLuid ?? null,
            captureAdapterLuid: lastD3d11.captureAdapterLuid ?? null,
            compositorAdapterLuid: lastD3d11.compositorAdapterLuid ?? null,
            primaryEncoderAdapterLuid: lastD3d11.primaryEncoderAdapterLuid ?? null,
            auxiliaryEncoderAdapterLuid: lastD3d11.auxiliaryEncoderAdapterLuid ?? null,
            generation: lastD3d11.generation ?? null,
            captureBackend: lastD3d11.captureBackend ?? null,
            cursorMode: lastD3d11.cursorMode ?? null,
            cursorRequested: lastD3d11.cursorRequested === true,
            cursorPixelsSource: lastD3d11.cursorPixelsSource ?? null,
            cursorExclusionGuaranteed: lastD3d11.cursorExclusionGuaranteed === true,
            cursorShapeUploads: counterDelta(
              firstD3d11.cursorShapeUploads,
              lastD3d11.cursorShapeUploads
            ),
            cursorCompositedFrames: counterDelta(
              firstD3d11.cursorCompositedFrames,
              lastD3d11.cursorCompositedFrames
            ),
            captureReadbackFrames: counterDelta(
              firstD3d11.captureReadbackFrames,
              lastD3d11.captureReadbackFrames
            ),
            textureImportFrames: counterDelta(
              firstD3d11.textureImportFrames,
              lastD3d11.textureImportFrames
            ),
            cameraUploadFrames: counterDelta(
              firstD3d11.cameraUploadFrames,
              lastD3d11.cameraUploadFrames
            ),
            compositorCpuFallbackFrames: counterDelta(
              firstD3d11.compositorCpuFallbackFrames,
              lastD3d11.compositorCpuFallbackFrames
            ),
            previewPresents: counterDelta(firstD3d11.previewPresents, lastD3d11.previewPresents),
            previewDrops: counterDelta(firstD3d11.previewDrops, lastD3d11.previewDrops),
            previewBmpRequests: counterDelta(
              firstD3d11.previewBmpRequests,
              lastD3d11.previewBmpRequests
            ),
            previewBmpBytes: counterDelta(firstD3d11.previewBmpBytes, lastD3d11.previewBmpBytes),
            encoderGpuSamples: counterDelta(
              firstD3d11.encoderGpuSamples,
              lastD3d11.encoderGpuSamples
            ),
            encoderSystemMemorySamples: counterDelta(
              firstD3d11.encoderSystemMemorySamples,
              lastD3d11.encoderSystemMemorySamples
            ),
            rawVideoCopiedFrames: counterDelta(
              firstD3d11.rawVideoCopiedFrames,
              lastD3d11.rawVideoCopiedFrames
            ),
            texturePoolPressureEvents: counterDelta(
              firstD3d11.texturePoolPressureEvents,
              lastD3d11.texturePoolPressureEvents
            ),
            adapterMismatches: counterDelta(
              firstD3d11.adapterMismatches,
              lastD3d11.adapterMismatches
            ),
            deviceResets: counterDelta(firstD3d11.deviceResets, lastD3d11.deviceResets),
            messageDispatchP95Ms: maxFinite(
              measured.map((sample) => sample.windowsD3d11Media?.messagePumpLagP95Ms)
            ),
            messageDispatchMaxMs: maxFinite(
              measured.map((sample) => sample.windowsD3d11Media?.messagePumpLagMaxMs)
            ),
            fallbackReason: lastD3d11.fallbackReason ?? null,
            stateChanged: d3d11States.size > 1,
            adapterChanged:
              d3d11Adapters.size > 1 || d3d11RoleAdapters.some((states) => states.size > 1),
            fallbackChanged: d3d11FallbackReasons.size > 1
          }
        }
      : {})
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

  const separateOutputEncoders = measured.some(
    (sample) => sample.encoderBridgeSeparateOutputEncodersActive === true
  )
  if (recordEnabled && !separateOutputEncoders) {
    blockers.push('record-plus-stream diagnostics did not prove separate output encoders')
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
  }
  if (
    measured.some(
      (sample) => !nonEmptyString(sample.effectiveEncodeBackend ?? sample.encodeBackend)
    )
  ) {
    blockers.push('diagnostic timeline effective encode backend was missing')
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
  measurementStartedAtMs,
  measurementEndedAtMs,
  expectedMeasurementEndedAtMs,
  intervalMs,
  receiverAlive
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
        isRecord(event.snapshot) &&
        Array.isArray(event.snapshot.targets)
    )
    .sort((left, right) => left.receivedAtMs - right.receivedAtMs)
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
  const measuredEvents = targetEvents.filter(
    (event) =>
      event.receivedAtMs >= measurementStartedAtMs && event.receivedAtMs <= measurementEndedAtMs
  )
  for (const event of measuredEvents) {
    if (event.target.state !== 'live') {
      failures.push(
        `selected stream target entered ${event.target.state ?? 'unknown'} during measurement`
      )
    }
  }
  const stateAtEnd = targetEvents.at(-1)
  if (stateAtEnd?.target?.state !== 'live') {
    failures.push('selected stream target was not live immediately before stop')
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

export function attachWindowsStreamNaturalFallbackPolicy({ document, calibration }) {
  return attachWindowsNaturalFallbackPolicy({ document, calibration })
}

export function windowsStreamCandidateIdentity(candidate) {
  const identity = {
    sourceCommit: candidate?.sourceCommit,
    installerSha256: candidate?.installerSha256,
    executableSha256: candidate?.sha256,
    packagePayloadSha256: candidate?.packagePayload?.sha256
  }
  if (!/^[a-f0-9]{40}$/.test(identity.sourceCommit ?? '')) {
    throw new Error('candidate sourceCommit must be a lowercase 40-character commit.')
  }
  for (const field of ['installerSha256', 'executableSha256', 'packagePayloadSha256']) {
    if (!/^[a-f0-9]{64}$/.test(identity[field] ?? '')) {
      throw new Error(`candidate ${field} must be a lowercase SHA-256 digest.`)
    }
  }
  return identity
}

export function windowsStreamCalibrationMetrics({
  processTelemetry,
  gpuEvidence,
  bmp,
  pipeline,
  mediaVerdict,
  lifecycleVerdict,
  previewProofSurfaceVerdict,
  inputContinuity
}) {
  const processTree = summarizeWindowsStreamBudgetProcessTelemetry(processTelemetry)
  const memory = processTree?.memory?.summary
  const cpu = processTree?.cpu?.summary
  const roles = new Set([...Object.keys(memory?.roles ?? {}), ...Object.keys(cpu?.byRole ?? {})])
  const gpu = gpuEvidence?.summary ?? gpuEvidence
  const d3d11 = pipeline?.d3d11
  return {
    process: {
      cpuP95Percent: finiteOrNull(cpu?.totalP95Percent ?? cpu?.total?.p95Percent),
      rssMaxMiB: divideFinite(memory?.maxTotalRssKb, 1024),
      rssSlopeMiBPerMinute: divideFinite(memory?.totalRss?.slopePerMinute, 1024),
      roles: Object.fromEntries(
        [...roles].sort().map((role) => [
          role,
          {
            rssMaxMiB: divideFinite(memory?.roles?.[role]?.maxRssKb, 1024),
            rssSlopeMiBPerMinute: divideFinite(memory?.roles?.[role]?.slopeRssKbPerMinute, 1024),
            cpuAveragePercent: finiteOrNull(cpu?.byRole?.[role]?.averagePercent),
            cpuP95Percent: finiteOrNull(cpu?.byRole?.[role]?.p95Percent)
          }
        ])
      )
    },
    gpu: {
      engineBusyP95Percent: finiteOrNull(gpu?.engineBusyP95Percent),
      dedicatedMaxMiB: finiteOrNull(gpu?.dedicatedMaxMiB),
      sharedMaxMiB: finiteOrNull(gpu?.sharedMaxMiB)
    },
    bmp: {
      requestCount: finiteOrNull(bmp?.requestCount),
      bytes: finiteOrNull(bmp?.bytes),
      intervalP95Ms: finiteOrNull(bmp?.intervalP95Ms),
      advancedFrames: finiteOrNull(bmp?.advancedFrames)
    },
    encoderSpeedP05: finiteOrNull(pipeline?.encoderSpeedP05),
    mediaVerdict,
    lifecycleVerdict,
    previewProofSurfaceVerdict,
    d3d11: {
      captureReadbackFrames: finiteOrNull(d3d11?.captureReadbackFrames),
      compositorCpuFallbackFrames: finiteOrNull(d3d11?.compositorCpuFallbackFrames),
      rawVideoCopiedFrames: finiteOrNull(d3d11?.rawVideoCopiedFrames),
      encoderSystemMemorySamples: finiteOrNull(d3d11?.encoderSystemMemorySamples),
      cursorCorrect: windowsStreamD3d11CursorCorrect(d3d11),
      inputContinuity: inputContinuity === true,
      messageDispatchP95Ms: finiteOrNull(d3d11?.messageDispatchP95Ms),
      messageDispatchMaxMs: finiteOrNull(d3d11?.messageDispatchMaxMs)
    }
  }
}

export function evaluateWindowsD3d11PreviewInputContinuity({
  applicable,
  before,
  after,
  minimumMovePx = 12
}) {
  if (applicable !== true) {
    return {
      verdict: 'NOT_REQUIRED',
      applicable: false,
      physicalInput: false,
      blockers: []
    }
  }

  const blockers = []
  if (!(after?.state?.clicks > 0)) blockers.push('Electron did not receive the physical click')
  if (!(after?.state?.focusEvents > 0)) {
    blockers.push('Electron input did not receive focus')
  }
  if (!(after?.state?.inputEvents > 0) || after?.state?.value !== 'VIDEORC42') {
    blockers.push('Electron input did not receive the physical keyboard sequence')
  }
  if (after?.state?.activeElementId !== 'videorc-windows-preview-input-target') {
    blockers.push('Electron input did not remain the active element')
  }
  const electronWindowMoved =
    isRecord(before?.initialBounds) &&
    isRecord(after?.bounds) &&
    (Math.abs(after.bounds.x - before.initialBounds.x) >= minimumMovePx ||
      Math.abs(after.bounds.y - before.initialBounds.y) >= minimumMovePx)
  if (!electronWindowMoved) {
    blockers.push('Electron preview window did not move from the physical drag')
  }
  const electronFocused = after?.previewFocused === true && after?.webContentsFocused === true
  if (!electronFocused) blockers.push('Electron preview/webContents did not retain focus')
  const presenterNeverActivated =
    after?.presenter?.windowActive === false && after?.presenter?.windowFocused === false
  if (!presenterNeverActivated) blockers.push('D3D11 presenter activated or took focus')
  const presenterSequenceBefore = before?.presenter?.lastPresentedSequence
  const presenterSequenceAfter = after?.presenter?.lastPresentedSequence
  if (
    after?.presenter?.firstPresentSucceeded !== true ||
    after?.presenter?.sourceLive !== true ||
    !Number.isSafeInteger(presenterSequenceBefore) ||
    !Number.isSafeInteger(presenterSequenceAfter) ||
    presenterSequenceAfter <= presenterSequenceBefore
  ) {
    blockers.push('D3D11 presenter did not remain live and advance through physical input')
  }

  return {
    verdict: blockers.length === 0 ? 'PASS' : 'FAIL',
    applicable: true,
    physicalInput: true,
    blockers,
    clickCount: after?.state?.clicks ?? 0,
    focusEventCount: after?.state?.focusEvents ?? 0,
    inputEventCount: after?.state?.inputEvents ?? 0,
    typedValueMatched: after?.state?.value === 'VIDEORC42',
    electronWindowMoved,
    electronFocused,
    presenterNeverActivated,
    presenterSequenceBefore: Number.isSafeInteger(presenterSequenceBefore)
      ? presenterSequenceBefore
      : null,
    presenterSequenceAfter: Number.isSafeInteger(presenterSequenceAfter)
      ? presenterSequenceAfter
      : null
  }
}

export function normalizeWindowsNaturalFallbackCalibration({
  aggregate,
  aggregatePath,
  aggregateSha256,
  reports
}) {
  const failures = []
  if (aggregate?.schemaVersion !== 1) failures.push('aggregate schemaVersion must be 1')
  if (aggregate?.kind !== 'videorc.windows-stream-performance-aggregate') {
    failures.push('aggregate kind was invalid')
  }
  if (aggregate?.mode !== 'calibrate' || aggregate?.status !== 'calibration') {
    failures.push('aggregate must be a completed CALIBRATION')
  }
  if (!portableAbsolutePath(aggregatePath)) failures.push('aggregatePath must be absolute')
  if (!lowercaseSha256(aggregateSha256)) failures.push('aggregateSha256 was invalid')
  if (aggregate?.hardwareClass !== WINDOWS_STREAM_NATURAL_FALLBACK_HARDWARE_CLASS) {
    failures.push(
      `aggregate hardwareClass must be ${WINDOWS_STREAM_NATURAL_FALLBACK_HARDWARE_CLASS}`
    )
  }
  if (!sameStringSet(aggregate?.scenarios, WINDOWS_STREAM_NATURAL_FALLBACK_SCENARIOS)) {
    failures.push('aggregate scenarios did not match the exact natural-fallback matrix')
  }
  if (
    aggregate?.profileClass !== 'release' ||
    aggregate?.operatingSystem?.platform !== 'win32' ||
    aggregate?.operatingSystem?.arch !== 'x64' ||
    !nonEmptyString(aggregate?.operatingSystem?.release)
  ) {
    failures.push('aggregate release/Windows hardware context was invalid')
  }
  let candidate = null
  try {
    candidate = windowsStreamCandidateIdentity(aggregate?.candidate)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  const reportList = Array.isArray(reports) ? reports : []
  if (reportList.length !== 12) {
    failures.push('natural fallback derivation requires exactly twelve verdict reports')
  }
  const aggregateRuns = Array.isArray(aggregate?.runs) ? aggregate.runs : []
  if (aggregateRuns.length !== 12) {
    failures.push('aggregate did not retain exactly twelve run summaries')
  }
  const runs = []
  const seenContexts = new Set()
  const seenPaths = new Set()
  const seenHashes = new Set()
  for (const [index, report] of reportList.entries()) {
    const label = `fallback report ${index + 1}`
    const evidence = report?.document?.evidence
    const result = report?.document?.result
    const scenario = buildWindowsStreamPerformanceMatrix().find(
      (entry) => entry.id === evidence?.scenarioId
    )
    if (!portableAbsolutePath(report?.path)) failures.push(`${label} path was not absolute`)
    const canonicalPath = canonicalPortablePath(report?.path)
    if (seenPaths.has(canonicalPath)) failures.push(`${label} path was duplicated`)
    else seenPaths.add(canonicalPath)
    if (!lowercaseSha256(report?.sha256) || seenHashes.has(report?.sha256)) {
      failures.push(`${label} digest was invalid or duplicated`)
    } else {
      seenHashes.add(report.sha256)
    }
    if (!scenario || !WINDOWS_STREAM_NATURAL_FALLBACK_SCENARIOS.includes(scenario.id)) {
      failures.push(`${label} scenario was outside the natural-fallback matrix`)
      continue
    }
    if (evidence?.mode !== 'calibrate' || result?.verdict !== 'PASS') {
      failures.push(`${label} was not a passing calibration run`)
    }
    const reevaluated = evaluateWindowsStreamRun(evidence)
    if (reevaluated.verdict !== 'PASS') {
      failures.push(
        `${label} evidence did not independently re-evaluate to PASS: ${[
          ...reevaluated.failures,
          ...reevaluated.blockers
        ].join('; ')}`
      )
    }
    if (
      !Number.isInteger(evidence?.repetition) ||
      evidence.repetition < 1 ||
      evidence.repetition > 3
    ) {
      failures.push(`${label} repetition was invalid`)
    }
    const contextKey = `${scenario.id}#${evidence?.repetition}`
    if (seenContexts.has(contextKey)) failures.push(`${label} duplicated ${contextKey}`)
    else seenContexts.add(contextKey)
    let runCandidate = null
    try {
      runCandidate = windowsStreamCandidateIdentity(evidence?.candidate)
    } catch (error) {
      failures.push(`${label} ${error instanceof Error ? error.message : String(error)}`)
    }
    if (candidate && stableJson(runCandidate) !== stableJson(candidate)) {
      failures.push(`${label} candidate identity differed from the aggregate`)
    }
    if (
      evidence?.context?.hardwareClass !== WINDOWS_STREAM_NATURAL_FALLBACK_HARDWARE_CLASS ||
      evidence?.context?.profile !== '1080p30' ||
      evidence?.context?.mediaPath !== 'legacy-fallback' ||
      evidence?.context?.selectionMode !== 'natural' ||
      evidence?.context?.sourceComposition !== 'screen-only' ||
      evidence?.context?.topology !== scenario.topology ||
      evidence?.context?.previewOpen !== scenario.previewOpen
    ) {
      failures.push(`${label} hardware/media/topology context did not match`)
    }
    if (
      evidence?.timing?.warmupMs !== WINDOWS_STREAM_PERFORMANCE_TIMING.warmupMs ||
      evidence?.timing?.measurementMs !== WINDOWS_STREAM_PERFORMANCE_TIMING.measurementMs ||
      evidence?.timing?.sampleIntervalMs !== WINDOWS_STREAM_PERFORMANCE_TIMING.sampleIntervalMs
    ) {
      failures.push(`${label} timing context did not match the protected calibration`)
    }
    if (
      evidence?.pipeline?.expectedFallback !== 'natural' ||
      evidence?.pipeline?.d3d11?.state !== 'fallback' ||
      evidence?.pipeline?.d3d11?.captureBackend !== 'legacy-ffmpeg' ||
      !nonEmptyString(evidence?.pipeline?.d3d11?.fallbackReason)
    ) {
      failures.push(`${label} did not prove the named natural legacy fallback`)
    }
    const calibration = evidence?.calibration
    if (
      calibration?.mediaVerdict !== 'PASS' ||
      calibration?.lifecycleVerdict !== 'PASS' ||
      calibration?.previewProofSurfaceVerdict !== 'PASS'
    ) {
      failures.push(`${label} media/lifecycle/proof-surface evidence did not pass`)
    }
    const matchingSummary = aggregateRuns.find(
      (run) => run?.scenarioId === scenario.id && run?.repetition === evidence?.repetition
    )
    if (
      !matchingSummary ||
      matchingSummary.verdict !== 'PASS' ||
      canonicalPortablePath(matchingSummary.reportPath) !== canonicalPath ||
      matchingSummary.reportSha256 !== report?.sha256
    ) {
      failures.push(`${label} did not match its aggregate run summary`)
    }
    runs.push({
      topology: scenario.topology,
      previewOpen: scenario.previewOpen,
      repetition: evidence?.repetition,
      verdict: result?.verdict,
      reportPath: report?.path,
      reportSha256: report?.sha256,
      observed: {
        fallbackReason: evidence?.pipeline?.d3d11?.fallbackReason ?? null,
        effectiveCaptureBackend: evidence?.pipeline?.d3d11?.captureBackend ?? null,
        effectiveEncoderBackend: evidence?.pipeline?.effectiveEncodeBackend ?? null
      },
      mediaVerdict: calibration?.mediaVerdict ?? null,
      lifecycleVerdict: calibration?.lifecycleVerdict ?? null,
      previewProofSurfaceVerdict: calibration?.previewProofSurfaceVerdict ?? null,
      encoderSpeedP05: calibration?.encoderSpeedP05 ?? null,
      process: calibration?.process ?? null,
      gpu: calibration?.gpu ?? null,
      bmp: {
        intervalP95Ms: calibration?.bmp?.intervalP95Ms ?? null,
        advancedFrames: calibration?.bmp?.advancedFrames ?? null
      }
    })
  }
  for (const scenarioId of WINDOWS_STREAM_NATURAL_FALLBACK_SCENARIOS) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      if (!seenContexts.has(`${scenarioId}#${repetition}`)) {
        failures.push(`natural fallback evidence omitted ${scenarioId}#${repetition}`)
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Natural fallback calibration was invalid:\n${failures.join('\n')}`)
  }
  const firstEvidence = reports[0].document.evidence
  return {
    schemaVersion: 1,
    kind: 'videorc.windows-natural-fallback-calibration',
    status: 'CALIBRATION',
    candidate,
    aggregatePath,
    aggregateSha256,
    scope: {
      scenario: '1080p30-natural-fallback-matrix',
      profile: '1080p30',
      fps: 30,
      hardwareClass: WINDOWS_STREAM_NATURAL_FALLBACK_HARDWARE_CLASS,
      profileClass: aggregate.profileClass,
      buildMode: 'packaged',
      operatingSystem: aggregate.operatingSystem,
      timing: {
        warmupMs: firstEvidence.timing.warmupMs,
        measurementMs: firstEvidence.timing.measurementMs,
        intervalMs: firstEvidence.timing.sampleIntervalMs
      },
      mediaPath: 'legacy-fallback',
      selectionMode: 'natural',
      d3d11Requested: false,
      d3d11Required: false
    },
    runs: runs.sort(
      (left, right) =>
        WINDOWS_STREAM_NATURAL_FALLBACK_SCENARIOS.indexOf(scenarioIdForFallbackRun(left)) -
          WINDOWS_STREAM_NATURAL_FALLBACK_SCENARIOS.indexOf(scenarioIdForFallbackRun(right)) ||
        left.repetition - right.repetition
    )
  }
}

export function buildWindowsD3d11StreamCalibrations({ aggregate, aggregatePath }) {
  if (aggregate?.mode !== 'calibrate') return []
  const candidate = windowsStreamCandidateIdentity(aggregate.candidate)
  const groups = new Map()
  for (const run of aggregate.runs ?? []) {
    if (run?.verdict !== 'PASS' || !run?.calibration) continue
    if (!groups.has(run.scenarioId)) groups.set(run.scenarioId, [])
    groups.get(run.scenarioId).push(run)
  }
  return [...groups.entries()]
    .map(([scenarioId, runs]) => {
      const scenario = buildWindowsStreamPerformanceMatrix().find(
        (entry) => entry.id === scenarioId
      )
      if (!scenario) throw new Error(`Unknown D3D11 calibration scenario ${scenarioId}.`)
      const expectedRuns = scenario.repetitions
      if (
        runs.length !== expectedRuns ||
        runs.some(
          (run) =>
            !portableAbsolutePath(run.reportPath) ||
            !lowercaseSha256(run.reportSha256) ||
            run.calibration?.d3d11?.captureReadbackFrames !== 0 ||
            run.calibration?.d3d11?.compositorCpuFallbackFrames !== 0 ||
            run.calibration?.d3d11?.rawVideoCopiedFrames !== 0 ||
            run.calibration?.d3d11?.encoderSystemMemorySamples !== 0 ||
            run.calibration?.bmp?.requestCount !== 0 ||
            run.calibration?.bmp?.bytes !== 0
        )
      ) {
        throw new Error(
          `D3D11 calibration ${scenarioId} did not retain ${expectedRuns} passing zero-copy runs.`
        )
      }
      const previewOpen = scenario.previewOpen === true
      return {
        schemaVersion: 1,
        kind: 'videorc.windows-d3d11-stream-calibration',
        id: `${aggregate.hardwareClass}-${scenario.id}`,
        scope: {
          scenario: scenario.id,
          hardwareClass: aggregate.hardwareClass,
          profileClass: aggregate.profileClass,
          buildMode: 'packaged',
          operatingSystem: aggregate.operatingSystem,
          timing: {
            warmupMs: scenario.warmupMs,
            measurementMs: scenario.measurementMs,
            intervalMs: scenario.sampleIntervalMs
          },
          profile: scenario.fps === 60 ? '1080p60' : '1080p30',
          mediaPath: 'd3d11-native',
          sourceComposition: scenario.sourceComposition,
          topology: scenario.topology,
          previewOpen,
          ...(previewOpen ? { preview: WINDOWS_STREAM_D3D11_PREVIEW } : {})
        },
        candidate: {
          sourceCommit: candidate.sourceCommit,
          installerSha256: candidate.installerSha256,
          sha256: candidate.executableSha256,
          packagePayload: {
            sha256: candidate.packagePayloadSha256,
            components: aggregate.candidate.packagePayload.components
          }
        },
        aggregatePath,
        aggregateSha256: null,
        runs: runs
          .sort((left, right) => left.repetition - right.repetition)
          .map((run) => ({
            verdict: run.verdict,
            reportPath: run.reportPath,
            reportSha256: run.reportSha256,
            candidate: aggregate.candidate,
            process: run.calibration.process,
            gpu: { summary: run.calibration.gpu },
            bmp: {
              mode: 'disabled',
              requests: run.calibration.bmp.requestCount,
              bytes: run.calibration.bmp.bytes
            },
            pipeline: {
              zeroCopyVerdict: 'PASS',
              ...run.calibration.d3d11
            }
          }))
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

export function isWindowsD3d11StreamPerformanceBudget(document) {
  return document?.kind === WINDOWS_D3D11_PERFORMANCE_BUDGET_KIND
}

function assertSinglePortableAbsolutePath(value, label) {
  assertLiteralPath(value, label)
  if (String(value).includes(',')) {
    throw new Error(`${label} accepts exactly one candidate root, not a path list.`)
  }
  if (!portableAbsolutePath(value)) {
    throw new Error(`${label} must be one absolute candidate root.`)
  }
}

function assertLiteralPath(value, label) {
  if (!nonEmptyString(value) || /[*?\[\]{}<>]/.test(value) || /^~(?:[\\/]|$)/.test(value)) {
    throw new Error(`${label} does not accept aliases or glob paths.`)
  }
}

function portableAbsolutePath(value) {
  return (
    nonEmptyString(value) &&
    (/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value) || value.startsWith('/'))
  )
}

function canonicalPortablePath(value) {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLocaleLowerCase('en-US')
}

function lowercaseSha256(value) {
  return /^[a-f0-9]{64}$/.test(value ?? '')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((value) => actual.includes(value))
  )
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null
}

function divideFinite(value, divisor) {
  return Number.isFinite(value) ? value / divisor : null
}

function windowsStreamD3d11CursorCorrect(d3d11) {
  if (!isRecord(d3d11)) return false
  if (!nonEmptyString(d3d11.cursorPixelsSource) || !nonEmptyString(d3d11.cursorMode)) {
    return false
  }
  if (d3d11.captureBackend === 'desktop-duplication') {
    if (
      d3d11.cursorRequested !== true ||
      d3d11.cursorExclusionGuaranteed !== false ||
      !['embedded', 'separate'].includes(d3d11.cursorMode)
    ) {
      return false
    }
    if (d3d11.cursorMode === 'separate') {
      return Number.isFinite(d3d11.cursorCompositedFrames) && d3d11.cursorCompositedFrames > 0
    }
    return d3d11.cursorCompositedFrames === 0
  }
  return (
    d3d11.captureBackend === 'windows-graphics-capture-monitor' &&
    d3d11.cursorRequested === false &&
    d3d11.cursorMode === 'excluded-wgc' &&
    d3d11.cursorExclusionGuaranteed === true &&
    d3d11.cursorCompositedFrames === 0
  )
}

function validateWindowsD3d11AdapterEvidence(d3d11, failures, { auxiliaryRequired }) {
  const authority = d3d11?.adapterLuid
  if (!/^[0-9a-f]{16}$/.test(authority ?? '')) {
    failures.push('D3D11 media authority adapterLuid was not canonical')
  }
  for (const field of [
    'captureAdapterLuid',
    'compositorAdapterLuid',
    'primaryEncoderAdapterLuid'
  ]) {
    if (!/^[0-9a-f]{16}$/.test(d3d11?.[field] ?? '')) {
      failures.push(`D3D11 ${field} was not canonical`)
    } else if (d3d11[field] !== authority) {
      failures.push(`D3D11 ${field} did not equal the media authority adapterLuid`)
    }
  }
  const auxiliary = d3d11?.auxiliaryEncoderAdapterLuid
  if (auxiliaryRequired && !/^[0-9a-f]{16}$/.test(auxiliary ?? '')) {
    failures.push('D3D11 auxiliaryEncoderAdapterLuid was required for split output encoders')
  } else if (auxiliary !== null && auxiliary !== undefined) {
    if (!/^[0-9a-f]{16}$/.test(auxiliary)) {
      failures.push('D3D11 auxiliaryEncoderAdapterLuid was not canonical')
    } else if (auxiliary !== authority) {
      failures.push(
        'D3D11 auxiliaryEncoderAdapterLuid did not equal the media authority adapterLuid'
      )
    }
  }
}

function scenarioIdForFallbackRun(run) {
  const topology = run?.topology === 'record-plus-stream' ? 'record-stream' : 'stream'
  return `1080p30-${topology}-${run?.previewOpen ? 'preview' : 'no-preview'}`
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
