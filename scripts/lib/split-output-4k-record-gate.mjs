export const SPLIT_OUTPUT_4K_RECORD_GATES = Object.freeze({
  recording: Object.freeze({
    width: 3840,
    height: 2160,
    fps: 30,
    bitrateKbps: 30000
  }),
  stream: Object.freeze({
    width: 1920,
    height: 1080,
    fps: 30,
    maxBitrateKbps: 6000
  }),
  activeVideoToolboxOutputEncoders: 2,
  maxRecordingQueueDepth: 16,
  maxRecordingQueueOldestFrameAgeMs: 250,
  maxStreamQueueDepth: 8,
  maxStreamQueueOldestFrameAgeMs: 150
})

export function evaluateSplitOutput4kRecordEvidence(
  { manifest, receivedStreamProbe, streamAvSyncVerdict } = {},
  gates = SPLIT_OUTPUT_4K_RECORD_GATES
) {
  const failures = []
  const warnings = []
  const request = manifest?.request ?? {}
  const result = manifest?.result ?? {}
  const diagnostics = manifest?.diagnostics ?? {}
  const finalFile = diagnostics.finalFile ?? {}
  const recordingOutput = diagnostics.recordingOutput ?? {}
  const streamOutput = diagnostics.streamOutput ?? {}

  requireProfile(failures, 'requested recording profile', request, gates.recording)
  if (request.streamEnabled !== true) {
    failures.push('streaming was not enabled for the baseline session')
  }
  if (request.streamingSettingsEnabled !== true) {
    failures.push('modern streaming settings were not enabled for the baseline session')
  }
  if (request.streamOutputPreset !== 'stream-safe-1080p30') {
    failures.push(
      `stream output preset ${formatValue(request.streamOutputPreset)} was not stream-safe-1080p30`
    )
  }

  requireDimensions(failures, 'local recording artifact', finalFile, gates.recording)
  requireProfile(failures, 'diagnostic recording output', recordingOutput, gates.recording)
  requireStreamProfile(failures, 'diagnostic stream output', streamOutput, gates.stream)
  requireDimensions(
    failures,
    'RTMP-received stream artifact',
    receivedStreamProbe?.video,
    gates.stream
  )

  if (result.blockedBeforeEncoding === true) {
    failures.push(
      `recording was blocked before encoding: ${(result.acceptanceFailures ?? []).join('; ') || 'unknown reason'}`
    )
  }
  if (result.finalFilePass !== true) {
    failures.push(
      `local recording final-file gate failed: ${(result.acceptanceFailures ?? []).join('; ') || 'see quality report'}`
    )
  }
  if (result.startupPass !== true) {
    failures.push('local recording startup-resolution gate failed')
  }
  if (!['record-stream-split-output', '4k-accepted'].includes(result.mediaQualityMode)) {
    failures.push(
      `media quality mode ${formatValue(result.mediaQualityMode)} did not prove split output`
    )
  }

  requireEquals(
    failures,
    'active VideoToolbox output encoder count',
    diagnostics.encoderBridgeActiveVideoToolboxOutputEncoders,
    gates.activeVideoToolboxOutputEncoders
  )
  requireTrue(
    failures,
    'separate output encoders',
    diagnostics.encoderBridgeSeparateOutputEncodersActive
  )
  requirePositive(
    failures,
    'recording VideoToolbox output frames',
    diagnostics.encoderBridgeRecordingVideoToolboxOutputFrames
  )
  requirePositive(
    failures,
    'recording VideoToolbox output bytes',
    diagnostics.encoderBridgeRecordingVideoToolboxOutputBytes
  )
  requirePositive(
    failures,
    'stream VideoToolbox output frames',
    diagnostics.encoderBridgeStreamVideoToolboxOutputFrames
  )
  requirePositive(
    failures,
    'stream VideoToolbox output bytes',
    diagnostics.encoderBridgeStreamVideoToolboxOutputBytes
  )
  requireEquals(
    failures,
    'raw-video copied frames',
    diagnostics.encoderBridgeRawVideoCopiedFrames,
    0
  )
  requireEquals(
    failures,
    'Metal target copied frames',
    diagnostics.encoderBridgeMetalTargetCopiedFrames,
    0
  )
  requirePositive(failures, 'zero-copy frames', diagnostics.encoderBridgeZeroCopyFrames)
  requireQueueContract(failures, diagnostics, 'recording', {
    depth: 'encoderBridgeRecordingQueueDepth',
    oldestAge: 'encoderBridgeRecordingQueueOldestFrameAgeMs',
    pressure: 'encoderBridgeRecordingQueueCapacityPressureEvents',
    dropped: 'encoderBridgeRecordingQueueDroppedFrames',
    maxDepth: gates.maxRecordingQueueDepth,
    maxOldestAgeMs: gates.maxRecordingQueueOldestFrameAgeMs,
    allowDrops: false
  })
  requireQueueContract(failures, diagnostics, 'stream', {
    depth: 'encoderBridgeStreamQueueDepth',
    oldestAge: 'encoderBridgeStreamQueueOldestFrameAgeMs',
    pressure: 'encoderBridgeStreamQueueCapacityPressureEvents',
    dropped: 'encoderBridgeStreamQueueDroppedFrames',
    maxDepth: gates.maxStreamQueueDepth,
    maxOldestAgeMs: gates.maxStreamQueueOldestFrameAgeMs,
    allowDrops: true
  })

  const repeatedRun = diagnostics.finalFile?.maxRepeatedFrameRun
  if (isFiniteNumber(repeatedRun) && repeatedRun > 2) {
    warnings.push(
      `local recording artifact reported repeated-frame run ${repeatedRun}; final-file gate verdict remains authoritative`
    )
  }
  const longestFreezeMs = diagnostics.finalFile?.longestFreezeMs
  if (isFiniteNumber(longestFreezeMs) && longestFreezeMs > 100) {
    warnings.push(
      `local recording artifact reported freeze ${longestFreezeMs.toFixed(0)}ms; final-file gate verdict remains authoritative`
    )
  }

  if (streamAvSyncVerdict) {
    if (streamAvSyncVerdict.pass !== true) {
      failures.push(
        `stream A/V sync gate failed: ${(streamAvSyncVerdict.failures ?? []).join('; ') || 'unknown failure'}`
      )
    }
    warnings.push(...(streamAvSyncVerdict.warnings ?? []))
  }

  return {
    pass: failures.length === 0,
    failures,
    warnings,
    summary: {
      recordingOutput,
      streamOutput,
      receivedStream: receivedStreamProbe?.video
        ? {
            width: receivedStreamProbe.video.width ?? null,
            height: receivedStreamProbe.video.height ?? null,
            avgFps: receivedStreamProbe.video.avgFps ?? null,
            nominalFps: receivedStreamProbe.video.nominalFps ?? null
          }
        : null,
      activeVideoToolboxOutputEncoders:
        diagnostics.encoderBridgeActiveVideoToolboxOutputEncoders ?? null,
      separateOutputEncodersActive: diagnostics.encoderBridgeSeparateOutputEncodersActive ?? null,
      mediaQualityMode: result.mediaQualityMode ?? null
    }
  }
}

function requireDimensions(failures, label, actual, expected) {
  requireEquals(failures, `${label} width`, actual?.width, expected.width)
  requireEquals(failures, `${label} height`, actual?.height, expected.height)
}

function requireProfile(failures, label, actual, expected) {
  requireDimensions(failures, label, actual, expected)
  requireEquals(failures, `${label} fps`, actual?.fps, expected.fps)
  requireEquals(failures, `${label} bitrate`, actual?.bitrateKbps, expected.bitrateKbps)
}

function requireStreamProfile(failures, label, actual, expected) {
  requireDimensions(failures, label, actual, expected)
  requireEquals(failures, `${label} fps`, actual?.fps, expected.fps)
  if (!isFiniteNumber(actual?.bitrateKbps)) {
    failures.push(`${label} bitrate was not reported`)
  } else if (actual.bitrateKbps > expected.maxBitrateKbps) {
    failures.push(`${label} bitrate ${actual.bitrateKbps} exceeded ${expected.maxBitrateKbps}`)
  }
}

function requirePositive(failures, label, actual) {
  if (!isFiniteNumber(actual) || actual <= 0) {
    failures.push(`${label} was not positive: ${formatValue(actual)}`)
  }
}

function requireQueueContract(
  failures,
  diagnostics,
  label,
  { depth, oldestAge, pressure, dropped, maxDepth, maxOldestAgeMs, allowDrops }
) {
  for (const [field, metric] of [
    [depth, 'depth'],
    [pressure, 'capacity pressure'],
    [dropped, 'dropped frames']
  ]) {
    if (!isFiniteNumber(diagnostics[field])) {
      failures.push(`${label} queue ${metric} was not reported`)
    }
  }
  const actualDepth = diagnostics[depth]
  if (isFiniteNumber(actualDepth) && actualDepth > maxDepth) {
    failures.push(`${label} queue depth ${actualDepth} exceeded ${maxDepth}`)
  }
  const actualAge = diagnostics[oldestAge]
  if (isFiniteNumber(actualDepth) && actualDepth > 0 && !isFiniteNumber(actualAge)) {
    failures.push(`${label} queue oldest-frame age was not reported while non-empty`)
  } else if (isFiniteNumber(actualAge) && actualAge > maxOldestAgeMs) {
    failures.push(
      `${label} queue oldest-frame age ${actualAge.toFixed(0)}ms exceeded ${maxOldestAgeMs}ms`
    )
  }
  if (isFiniteNumber(diagnostics[pressure]) && diagnostics[pressure] > 0) {
    failures.push(`${label} queue hit capacity ${diagnostics[pressure]} time(s)`)
  }
  if (!allowDrops && isFiniteNumber(diagnostics[dropped]) && diagnostics[dropped] > 0) {
    failures.push(`${label} queue dropped ${diagnostics[dropped]} frame(s)`)
  }
}

function requireTrue(failures, label, actual) {
  if (actual !== true) {
    failures.push(`${label} was not true: ${formatValue(actual)}`)
  }
}

function requireEquals(failures, label, actual, expected) {
  if (actual !== expected) {
    failures.push(`${label} ${formatValue(actual)} did not equal ${formatValue(expected)}`)
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function formatValue(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}
