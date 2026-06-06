import { DEFAULT_ACCEPTANCE_GATES } from './acceptance-gate.mjs'

const STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  NEEDS_MANUAL: 'needs-manual',
})

export function classifyObsParityEvidence(input, gates = DEFAULT_ACCEPTANCE_GATES) {
  const diagnostics = input.diagnostics ?? {}
  const analyzerVerdict = input.analyzerVerdict ?? null
  const startupVerdict = input.startupVerdict ?? null
  const claimsNative = Boolean(input.claimsNative)
  const finalPassed = analyzerVerdict?.pass === true
  const startupPassed = startupVerdict?.pass === true
  const imagePolls = diagnostics.imagePollDuringSession?.total
  const cpuFallbackFrames = diagnostics.compositorCpuFallbackFrames ?? 0
  const metalTargetFrames = diagnostics.encoderBridgeMetalTargetFrames ?? 0
  const rawVideoCopiedFrames = diagnostics.encoderBridgeRawVideoCopiedFrames ?? 0
  const metalTargetCopiedFrames = diagnostics.encoderBridgeMetalTargetCopiedFrames ?? 0
  const zeroCopyFrames = diagnostics.encoderBridgeZeroCopyFrames ?? 0

  return [
    classifyStartup({ startupVerdict, diagnostics, startupPassed }),
    classifyPreviewLag({ diagnostics, claimsNative, imagePolls, cpuFallbackFrames, gates }),
    classifyPreviewQuality({ diagnostics, claimsNative, imagePolls, cpuFallbackFrames }),
    classifyRecordingHotPath({
      analyzerVerdict,
      diagnostics,
      finalPassed,
      cpuFallbackFrames,
      metalTargetFrames,
      rawVideoCopiedFrames,
      metalTargetCopiedFrames,
      zeroCopyFrames,
      gates,
    }),
  ]
}

function classifyStartup({ startupVerdict, diagnostics, startupPassed }) {
  const evidence = []
  if (startupVerdict?.failures?.length) {
    evidence.push(...startupVerdict.failures)
  }
  if ((diagnostics.encoderBridgeSyntheticFrames ?? 0) > 0) {
    evidence.push(`${diagnostics.encoderBridgeSyntheticFrames} synthetic encoder filler frame(s)`)
  }
  if (diagnostics.recordingStartupBarrierTimeoutReason) {
    evidence.push(`startup barrier timeout: ${diagnostics.recordingStartupBarrierTimeoutReason}`)
  }
  if (diagnostics.recordingStartupBarrierState) {
    evidence.push(`barrier state: ${diagnostics.recordingStartupBarrierState}`)
  }

  if (startupPassed && (diagnostics.encoderBridgeSyntheticFrames ?? 0) === 0 && !diagnostics.recordingStartupBarrierTimeoutReason) {
    return item({
      area: 'First 2 seconds',
      status: STATUS.PASS,
      owner: 'startup barrier',
      evidence: evidence.length ? evidence : ['startup-resolution analyzer passed'],
      nextStep: 'Keep this gate on every real-source and native-preview recording run.',
    })
  }

  return item({
    area: 'First 2 seconds',
    status: STATUS.FAIL,
    owner: 'startup barrier / source readiness',
    evidence: evidence.length ? evidence : ['startup-resolution evidence missing or inconclusive'],
    nextStep: 'Hold recording start until every visible source has fresh target-resolution compositor frames.',
  })
}

function classifyPreviewLag({ diagnostics, claimsNative, imagePolls, cpuFallbackFrames, gates }) {
  const evidence = []
  const owners = new Set()

  if (!claimsNative || diagnostics.previewSurfaceBacking !== 'cametal-layer') {
    owners.add('proof preview transport')
    evidence.push(`preview backing: ${diagnostics.previewSurfaceBacking ?? 'unknown'}`)
  }
  if (imagePolls != null && imagePolls > 0) {
    owners.add('image-poll fallback transport')
    evidence.push(`${imagePolls} image poll(s) during recording`)
  }
  if (cpuFallbackFrames > 0) {
    owners.add('GPU fallback / source availability')
    evidence.push(`${cpuFallbackFrames} CPU fallback frame(s)`)
    if (diagnostics.compositorFallbackReason) {
      evidence.push(`fallback reason: ${diagnostics.compositorFallbackReason}`)
    }
  }
  if (
    diagnostics.previewInputToPresentLatencyP95Ms != null &&
    diagnostics.previewInputToPresentLatencyP95Ms > gates.maxPreviewInputToPresentLatencyP95Ms
  ) {
    owners.add('native presenter currentness')
    evidence.push(`source-to-present p95 ${diagnostics.previewInputToPresentLatencyP95Ms}ms`)
  }
  if (
    diagnostics.previewInputToPresentLatencyP99Ms != null &&
    diagnostics.previewInputToPresentLatencyP99Ms > gates.maxPreviewInputToPresentLatencyP99Ms
  ) {
    owners.add('native presenter currentness')
    evidence.push(`source-to-present p99 ${diagnostics.previewInputToPresentLatencyP99Ms}ms`)
  }
  if (
    diagnostics.previewCompositorFrameLag != null &&
    diagnostics.previewCompositorFrameLag > gates.maxPreviewCompositorFrameLag
  ) {
    owners.add('native presenter currentness')
    evidence.push(`${diagnostics.previewCompositorFrameLag} compositor frame(s) behind`)
  }

  if (owners.size === 0) {
    return item({
      area: 'Preview lag while recording',
      status: STATUS.PASS,
      owner: 'latest-frame presenter',
      evidence: ['native preview currentness metrics are inside the OBS-parity budget'],
      nextStep: 'Confirm with visible-vs-hidden recording comparison and manual hand-motion side-by-side.',
    })
  }

  return item({
    area: 'Preview lag while recording',
    status: STATUS.FAIL,
    owner: [...owners].join(' + '),
    evidence,
    nextStep: 'Make preview consume only the newest compositor frame and remove fallback transport/resource contention.',
  })
}

function classifyPreviewQuality({ diagnostics, claimsNative, imagePolls, cpuFallbackFrames }) {
  const evidence = []
  const owners = new Set()

  if (!claimsNative || diagnostics.previewSurfaceBacking !== 'cametal-layer') {
    owners.add('native Metal preview host')
    evidence.push(`preview backing: ${diagnostics.previewSurfaceBacking ?? 'unknown'}`)
  }
  if (imagePolls != null && imagePolls > 0) {
    owners.add('PNG/JPEG fallback preview')
    evidence.push(`${imagePolls} image poll(s) during recording`)
  }
  if (cpuFallbackFrames > 0) {
    owners.add('GPU compositor parity')
    evidence.push(`${cpuFallbackFrames} CPU fallback frame(s)`)
    if (diagnostics.compositorFallbackReason) {
      evidence.push(`fallback reason: ${diagnostics.compositorFallbackReason}`)
    }
  }

  if (owners.size === 0) {
    return item({
      area: 'Preview quality vs OBS',
      status: STATUS.NEEDS_MANUAL,
      owner: 'visual sampling / color parity',
      evidence: ['metrics show the native path; visual sharpness and color still require OBS side-by-side inspection'],
      nextStep: 'Compare screen text, cursor edges, camera detail, crop/mirror, and color bars against OBS.',
    })
  }

  return item({
    area: 'Preview quality vs OBS',
    status: STATUS.FAIL,
    owner: [...owners].join(' + '),
    evidence,
    nextStep: 'Do not tune fallback screenshots as final quality; finish CAMetalLayer presentation from the full-resolution compositor target.',
  })
}

function classifyRecordingHotPath({
  analyzerVerdict,
  diagnostics,
  finalPassed,
  cpuFallbackFrames,
  metalTargetFrames,
  rawVideoCopiedFrames,
  metalTargetCopiedFrames,
  zeroCopyFrames,
  gates,
}) {
  const evidence = []
  const owners = new Set()

  if (analyzerVerdict?.failures?.length) {
    owners.add('final-file recording path')
    evidence.push(...analyzerVerdict.failures)
  }
  if ((diagnostics.encoderBridgeRepeatedFrames ?? 0) > 0 && !finalPassed) {
    owners.add('encoder bridge / compositor under-run')
    evidence.push(`${diagnostics.encoderBridgeRepeatedFrames} duplicate encoder frame(s)`)
  }
  if ((diagnostics.encoderBridgeSyntheticFrames ?? 0) > 0) {
    owners.add('source readiness')
    evidence.push(`${diagnostics.encoderBridgeSyntheticFrames} synthetic encoder filler frame(s)`)
  }
  if (cpuFallbackFrames > 0) {
    owners.add('GPU fallback / source availability')
    evidence.push(`${cpuFallbackFrames} CPU fallback frame(s)`)
  }
  if (metalTargetFrames <= 0) {
    owners.add('Metal target export evidence')
    evidence.push('encoder bridge observed 0 IOSurface-backed Metal target frames')
  }
  if (metalTargetCopiedFrames > 0) {
    owners.add('zero-copy encoder export')
    evidence.push(`${metalTargetCopiedFrames} Metal target frame(s) copied through raw-video FFmpeg bridge`)
  } else if (rawVideoCopiedFrames > 0 && zeroCopyFrames <= 0) {
    owners.add('zero-copy encoder export')
    evidence.push(`${rawVideoCopiedFrames} raw-video copied encoder frame(s), 0 zero-copy frame(s)`)
  }
  if (diagnostics.minEncoderSpeed != null && diagnostics.minEncoderSpeed < gates.minEncoderSpeed && !finalPassed) {
    owners.add('VideoToolbox / encoder throughput')
    evidence.push(`encoder min speed ${diagnostics.minEncoderSpeed.toFixed(2)}x`)
  }

  if (owners.size === 0) {
    return item({
      area: 'Recording hot path',
      status: STATUS.PASS,
      owner: 'shared compositor / encoder bridge',
      evidence: ['final-file and live bridge metrics are inside the current gates'],
      nextStep: 'Keep expanding toward zero-copy VideoToolbox export and load/endurance coverage.',
    })
  }

  return item({
    area: 'Recording hot path',
    status: STATUS.FAIL,
    owner: [...owners].join(' + '),
    evidence,
    nextStep: 'Protect encoder throughput first; preview may drop stale frames but recording cannot receive fallback or repeated frames.',
  })
}

function item({ area, status, owner, evidence, nextStep }) {
  return {
    area,
    status,
    owner,
    evidence: evidence.filter(Boolean),
    nextStep,
  }
}
