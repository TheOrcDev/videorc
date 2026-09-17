export function selectWindowsDshowMicrophone(devices, preferredId) {
  const available = (devices ?? []).filter(
    (device) =>
      device?.kind === 'microphone' &&
      device?.status === 'available' &&
      /^microphone:windows-dshow:[0-9a-f]+$/i.test(device.id ?? '')
  )
  if (!preferredId) return available[0] ?? null
  const selected = available.find((device) => device.id === preferredId)
  if (!selected) {
    throw new Error(
      `Requested microphone ${preferredId} was not available as a Windows DirectShow microphone.`
    )
  }
  return selected
}

export function selectWindowsDshowCamera(devices, preferredId) {
  const available = (devices ?? []).filter(
    (device) =>
      device?.kind === 'camera' &&
      device?.status === 'available' &&
      /^camera:windows-dshow:[0-9a-f]+$/i.test(device.id ?? '')
  )
  if (!preferredId) return available[0] ?? null
  const selected = available.find((device) => device.id === preferredId)
  if (!selected) {
    throw new Error(
      `Requested camera ${preferredId} was not available as a Windows DirectShow camera.`
    )
  }
  return selected
}

export function assertLiveAudioUpdate(result, expected) {
  const matches =
    result?.applied === true &&
    result.sessionId === expected.sessionId &&
    approximatelyEqual(result.microphoneGainDb, expected.microphoneGainDb) &&
    result.microphoneMuted === expected.microphoneMuted
  if (!matches) {
    throw new Error(
      `Live microphone update was not applied as requested: expected=${JSON.stringify(expected)} result=${JSON.stringify(result)}`
    )
  }
}

export function liveAudioEvidenceWindows({
  gainAckSeconds,
  muteAckSeconds,
  unmuteAckSeconds,
  stopSeconds,
  applicationSettleSeconds = 1,
  durationSeconds = 1
}) {
  const windows = {
    baseline: {
      startSeconds: Math.max(0.5, gainAckSeconds - 4.5),
      durationSeconds
    },
    gained: { startSeconds: gainAckSeconds + applicationSettleSeconds, durationSeconds },
    muted: { startSeconds: muteAckSeconds + applicationSettleSeconds, durationSeconds },
    restored: { startSeconds: unmuteAckSeconds + applicationSettleSeconds, durationSeconds }
  }
  const boundaries = [
    ['baseline', windows.baseline, gainAckSeconds],
    ['gained', windows.gained, muteAckSeconds],
    ['muted', windows.muted, unmuteAckSeconds],
    ['restored', windows.restored, stopSeconds]
  ]
  for (const [label, window, boundary] of boundaries) {
    if (
      !Number.isFinite(window.startSeconds) ||
      !Number.isFinite(boundary) ||
      window.startSeconds < 0 ||
      window.startSeconds + window.durationSeconds + 0.2 > boundary
    ) {
      throw new Error(`The ${label} command timing left no stable audio evidence window.`)
    }
  }
  return windows
}

export function evaluateLiveAudioEvidence({
  baselineDb,
  gainedDb,
  mutedDb,
  restoredDb,
  expectedGainDeltaDb = 6,
  gainToleranceDb = 1.5,
  restoreToleranceDb = 1.5,
  audibleFloorDb = -55,
  mutedCeilingDb = -70
}) {
  const failures = []
  if (!Number.isFinite(baselineDb) || baselineDb < audibleFloorDb) {
    failures.push(
      `baseline window was not audible enough for calibration: ${formatDb(baselineDb)} (need >= ${audibleFloorDb} dB)`
    )
  }
  const gainDelta = gainedDb - baselineDb
  if (!Number.isFinite(gainDelta) || Math.abs(gainDelta - expectedGainDeltaDb) > gainToleranceDb) {
    failures.push(
      `gain delta was ${formatDb(gainDelta)}, expected ${expectedGainDeltaDb.toFixed(1)} ± ${gainToleranceDb.toFixed(1)} dB`
    )
  }
  if (Number.isFinite(mutedDb) && mutedDb > mutedCeilingDb) {
    failures.push(
      `mute window remained audible at ${formatDb(mutedDb)} (need <= ${mutedCeilingDb} dB)`
    )
  }
  const restoreDelta = restoredDb - baselineDb
  if (!Number.isFinite(restoreDelta) || Math.abs(restoreDelta) > restoreToleranceDb) {
    failures.push(
      `restored window differed from baseline by ${formatDb(restoreDelta)} (need ± ${restoreToleranceDb.toFixed(1)} dB)`
    )
  }
  return failures
}

export function parseFfmpegMaxVolume(stderr) {
  const match = String(stderr).match(/max_volume:\s*(-?inf|-?\d+(?:\.\d+)?)\s*dB/i)
  if (!match)
    throw new Error(`FFmpeg volumedetect did not report max_volume: ${String(stderr).slice(-500)}`)
  return match[1].toLowerCase() === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1])
}

export function parseCaptureMediaClock(message, receivedAtMs) {
  const match = String(message).match(/(?:^|\s)mediaSeconds=(\d+(?:\.\d+)?)(?:\s|$)/)
  const mediaSeconds = match ? Number(match[1]) : Number.NaN
  if (
    !Number.isFinite(mediaSeconds) ||
    mediaSeconds < 0 ||
    !Number.isFinite(receivedAtMs) ||
    receivedAtMs <= 0
  ) {
    throw new Error(`Capture media clock evidence was invalid: ${String(message)}`)
  }
  return { mediaSeconds, receivedAtMs }
}

export function projectWallTimeToMediaSeconds(clock, wallTimeMs) {
  if (
    !Number.isFinite(clock?.mediaSeconds) ||
    !Number.isFinite(clock?.receivedAtMs) ||
    clock.receivedAtMs <= 0 ||
    !Number.isFinite(wallTimeMs)
  ) {
    throw new Error('Capture media clock projection requires finite timestamps.')
  }
  return clock.mediaSeconds + (wallTimeMs - clock.receivedAtMs) / 1_000
}

function approximatelyEqual(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 0.001
}

function formatDb(value) {
  return `${Number.isFinite(value) ? value.toFixed(1) : '-inf'} dB`
}
