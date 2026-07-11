export function summarizeRecordingDiagnostics(
  samples,
  { targetFps, scenarioStartedAt, stopRequestedAt, warmupMs }
) {
  const numeric = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const activeSamples = samples.filter((sample) => {
    const receivedAt = sample.receivedAt ?? 0
    return (
      sample.activeOutputMode === 'record' &&
      receivedAt >= scenarioStartedAt &&
      receivedAt <= stopRequestedAt
    )
  })
  const steadySamples = activeSamples.filter(
    (sample) => (sample.receivedAt ?? 0) - scenarioStartedAt >= warmupMs
  )
  const measuredSamples = steadySamples.length ? steadySamples : activeSamples
  const captureFpsValues = numericValues(measuredSamples, 'captureFps', numeric)
  const renderFpsValues = numericValues(measuredSamples, 'renderFps', numeric)
  const speedValues = numericValues(measuredSamples, 'encoderSpeed', numeric)
  const backendRssValues = numericValues(measuredSamples, 'backendRssBytes', numeric)
  const ffmpegProcessValues = numericValues(measuredSamples, 'activeFfmpegProcesses', numeric)
  const ffprobeProcessValues = numericValues(measuredSamples, 'activeFfprobeProcesses', numeric)
  return {
    activeSamples: activeSamples.length,
    steadySamples: steadySamples.length,
    minFps: minimum([...captureFpsValues, ...renderFpsValues]),
    minCaptureFps: minimum(captureFpsValues),
    minRenderFps: minimum(renderFpsValues),
    minSpeed: minimum(speedValues),
    droppedFrames: maximum(measuredSamples, 'droppedFrames'),
    micDroppedFrames: maximum(measuredSamples, 'micDroppedFrames'),
    previewDroppedFrames: maximum(measuredSamples, 'previewDroppedFrames'),
    maintenanceSamples: measuredSamples.filter((sample) => sample.ffmpegMaintenanceRunning).length,
    maintenanceCancelSamples: measuredSamples.filter(
      (sample) => sample.ffmpegMaintenanceCancelRequested
    ).length,
    duplicateCaptureSamples: measuredSamples.filter(
      (sample) =>
        Array.isArray(sample.duplicateCaptureSources) && sample.duplicateCaptureSources.length > 0
    ).length,
    maxBackendRssBytes: backendRssValues.length ? Math.max(...backendRssValues) : null,
    maxActiveFfmpegProcesses: ffmpegProcessValues.length ? Math.max(...ffmpegProcessValues) : 0,
    maxActiveFfprobeProcesses: ffprobeProcessValues.length ? Math.max(...ffprobeProcessValues) : 0,
    targetFps
  }
}

export function evaluateRecordingPerformance({ scenario, stats, polls, thresholds }) {
  const failures = []
  if (stats.steadySamples < thresholds.minSteadySamples) {
    failures.push(
      `[${scenario.label}] captured ${stats.steadySamples} steady diagnostic samples; expected ${thresholds.minSteadySamples}`
    )
  }
  if (stats.minSpeed === null || stats.minSpeed < thresholds.minSpeed) {
    failures.push(
      `[${scenario.label}] encoder speed ${format(stats.minSpeed)}x fell below ${thresholds.minSpeed}x`
    )
  }
  const minFps = scenario.fps * thresholds.minFpsRatio
  if (stats.minCaptureFps === null) {
    failures.push(`[${scenario.label}] capture FPS telemetry was missing`)
  } else if (stats.minCaptureFps < minFps) {
    failures.push(
      `[${scenario.label}] capture FPS ${format(stats.minCaptureFps)} fell below ${format(minFps)}`
    )
  }
  if (stats.minRenderFps === null) {
    failures.push(`[${scenario.label}] render FPS telemetry was missing`)
  } else if (stats.minRenderFps < minFps) {
    failures.push(
      `[${scenario.label}] render FPS ${format(stats.minRenderFps)} fell below ${format(minFps)}`
    )
  }
  addPositiveFailure(failures, scenario, 'FFmpeg dropped frames', stats.droppedFrames)
  addPositiveFailure(failures, scenario, 'native microphone dropped frames', stats.micDroppedFrames)
  addPositiveFailure(failures, scenario, 'preview dropped frames', stats.previewDroppedFrames)
  addPositiveFailure(
    failures,
    scenario,
    'recording/maintenance overlap samples',
    stats.maintenanceSamples
  )
  addPositiveFailure(
    failures,
    scenario,
    'maintenance cancellation samples',
    stats.maintenanceCancelSamples
  )
  addPositiveFailure(failures, scenario, 'duplicate capture samples', stats.duplicateCaptureSamples)
  if (
    Number.isFinite(stats.maxBackendRssBytes) &&
    stats.maxBackendRssBytes > thresholds.maxBackendRssMb * 1024 * 1024
  ) {
    failures.push(
      `[${scenario.label}] backend RSS ${(stats.maxBackendRssBytes / 1048576).toFixed(1)}MiB exceeded ${thresholds.maxBackendRssMb}MiB`
    )
  }
  if (stats.maxActiveFfmpegProcesses > thresholds.maxActiveFfmpegProcesses) {
    failures.push(
      `[${scenario.label}] FFmpeg process count ${stats.maxActiveFfmpegProcesses} exceeded ${thresholds.maxActiveFfmpegProcesses}`
    )
  }
  if (stats.maxActiveFfprobeProcesses > thresholds.maxActiveFfprobeProcesses) {
    failures.push(
      `[${scenario.label}] FFprobe process count ${stats.maxActiveFfprobeProcesses} exceeded ${thresholds.maxActiveFfprobeProcesses}`
    )
  }
  const requiredPolls = Math.max(1, Math.ceil(polls.attempts * thresholds.minPreviewPollRatio))
  if (polls.successes < requiredPolls) {
    failures.push(
      `[${scenario.label}] preview polls succeeded ${polls.successes}/${polls.attempts}; expected at least ${requiredPolls}`
    )
  }
  return failures
}

export function evaluateRecordingArtifact({ scenario, report }) {
  const failures = []
  const label = `[${scenario.label}]`
  if (!report || typeof report !== 'object') {
    return [`${label} final-artifact analyzer report was missing`]
  }
  if (report.verdict?.pass !== true) {
    const reasons = Array.isArray(report.verdict?.failures)
      ? report.verdict.failures.filter(Boolean)
      : []
    failures.push(
      `${label} final-artifact analyzer failed${reasons.length ? `: ${reasons.join('; ')}` : ''}`
    )
  }
  const metrics = report.metrics ?? {}
  if (metrics.hasVideo !== true) {
    failures.push(`${label} final artifact did not prove a video stream`)
  }
  if (metrics.hasAudio !== true) {
    failures.push(`${label} final artifact did not prove a required audio stream`)
  }
  if (!Number.isFinite(metrics.observedFrames) || metrics.observedFrames <= 0) {
    failures.push(`${label} final artifact did not report decoded frame progress`)
  }
  if (!Number.isFinite(metrics.observedFps) || metrics.observedFps <= 0) {
    failures.push(`${label} final artifact did not report decoded frame cadence`)
  }
  if (!Number.isFinite(metrics.longestFreezeMs)) {
    failures.push(`${label} final artifact did not report freeze analysis`)
  }
  if (!Number.isFinite(metrics.maxRepeatedFrameRun)) {
    failures.push(`${label} final artifact did not report repeated-frame analysis`)
  }
  return failures
}

export function analyzeAvProbe(probe, { requireAudio = true, requireVideo = true } = {}) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : []
  const videoStreams = streams.filter((stream) => stream.codec_type === 'video')
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio')
  if (requireVideo && videoStreams.length === 0) {
    throw new Error('Recording artifact is missing a video stream.')
  }
  if (requireAudio && audioStreams.length === 0) {
    throw new Error('Recording artifact is missing a required audio stream.')
  }

  const formatDuration = finiteNumber(probe?.format?.duration)
  const videoDuration = streamDuration(videoStreams) ?? formatDuration
  const audioDuration = streamDuration(audioStreams) ?? formatDuration
  if (!Number.isFinite(videoDuration)) {
    throw new Error('Could not read video duration from recording artifact.')
  }
  if (requireAudio && !Number.isFinite(audioDuration)) {
    throw new Error('Could not read audio duration from recording artifact.')
  }
  return {
    videoStreams: videoStreams.length,
    audioStreams: audioStreams.length,
    videoDurationSeconds: videoDuration,
    audioDurationSeconds: Number.isFinite(audioDuration) ? audioDuration : null,
    skewMs: Number.isFinite(audioDuration) ? Math.abs(videoDuration - audioDuration) * 1000 : null
  }
}

function numericValues(samples, key, numeric) {
  return samples.map((sample) => numeric(sample[key])).filter((value) => value !== null)
}

function minimum(values) {
  return values.length ? Math.min(...values) : null
}

function maximum(samples, key) {
  return Math.max(0, ...samples.map((sample) => sample[key] ?? 0))
}

function addPositiveFailure(failures, scenario, label, count) {
  if (count > 0) failures.push(`[${scenario.label}] ${label}: ${count}`)
}

function streamDuration(streams) {
  for (const stream of streams) {
    const duration = finiteNumber(stream.duration)
    if (Number.isFinite(duration)) return duration
  }
  return null
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function format(value) {
  return typeof value === 'number' ? value.toFixed(2) : 'missing'
}
