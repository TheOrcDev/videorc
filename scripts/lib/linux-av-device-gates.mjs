// Pure gates for the Linux microphone (L2) and camera (L3) box smoke, so the
// contracts the ogre run asserts are unit-tested off the box.

export const LINUX_PULSE_MICROPHONE_PREFIX = 'microphone:linux-pulse:'
export const LINUX_V4L2_CAMERA_PREFIX = 'camera:linux-v4l2:'

/** Available devices of one kind whose id carries the Linux prefix. */
export function linuxDevices(devices, kind) {
  const prefix = kind === 'microphone' ? LINUX_PULSE_MICROPHONE_PREFIX : LINUX_V4L2_CAMERA_PREFIX
  return (devices ?? []).filter(
    (device) =>
      device.kind === kind && device.id?.startsWith(prefix) && device.status === 'available'
  )
}

/** devices.list must list at least one available device of the kind. */
export function assessLinuxDeviceList(devices, kind) {
  const found = linuxDevices(devices, kind)
  const failures = []
  if (found.length === 0) {
    const rows = (devices ?? [])
      .filter((device) => device.kind === kind)
      .map((device) => `${device.id} (${device.status}: ${device.detail ?? ''})`)
    failures.push(`no available Linux ${kind} listed; rows: ${rows.join(', ') || 'none'}`)
  }
  return { ok: failures.length === 0, failures, devices: found }
}

// A capsule in a room averages tens of dB below full scale. A whole window
// within this of 0 dBFS is a pegged or DC input (ogre's internal mic with the
// lid shut reads a constant -1.0), which a peak floor alone would pass.
export const PEGGED_MEAN_DB = -6

function peggedFailure(label, meanDb, maxMeanDb) {
  if (!Number.isFinite(meanDb) || meanDb <= maxMeanDb) return null
  return `${label} mean ${meanDb} dB is within ${-maxMeanDb} dB of full scale: a pegged or DC microphone, not room sound`
}

/**
 * audio.meter.sample on a real mic must measure the device: ready or silent
 * with a numeric peak, never the old macOS-only "unavailable", and not a
 * pegged input.
 */
export function assessMicMeter(result, { maxMeanDb = PEGGED_MEAN_DB } = {}) {
  const failures = []
  if (!['ready', 'silent'].includes(result?.status)) {
    failures.push(`meter status ${result?.status}: ${result?.message ?? ''}`)
  }
  if (!Number.isFinite(result?.peakDb)) failures.push(`meter peakDb ${result?.peakDb}`)
  const pegged = peggedFailure('meter', result?.meanDb, maxMeanDb)
  if (pegged) failures.push(pegged)
  return { ok: failures.length === 0, failures }
}

/**
 * The recording's audio must come from the device: an audio stream whose
 * peak is above digital silence (the session's zero-PCM filler measures
 * -91 dB) and whose mean is not pinned at full scale. A quiet room still
 * clears -70 dB on a live capsule.
 */
export function assessMicRecordingAudio(
  { hasAudio, maxVolumeDb, meanVolumeDb } = {},
  { minPeakDb = -70, maxMeanDb = PEGGED_MEAN_DB } = {}
) {
  const failures = []
  if (!hasAudio) failures.push('recording has no audio stream')
  if (!Number.isFinite(maxVolumeDb)) failures.push(`audio max_volume ${maxVolumeDb}`)
  else if (maxVolumeDb <= minPeakDb) {
    failures.push(
      `audio peak ${maxVolumeDb} dB (mean ${meanVolumeDb} dB) is at or below ${minPeakDb} dB: silence, not the microphone`
    )
  }
  const pegged = peggedFailure('audio', meanVolumeDb, maxMeanDb)
  if (pegged) failures.push(pegged)
  return { ok: failures.length === 0, failures }
}

/** Parses ffmpeg volumedetect stderr into { maxVolumeDb, meanVolumeDb }. */
export function parseVolumedetect(text) {
  const read = (key) => {
    const match = new RegExp(`${key}:\\s*(-?(?:\\d+(?:\\.\\d+)?|inf))\\s*dB`).exec(text ?? '')
    if (!match) return null
    return match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1])
  }
  return { maxVolumeDb: read('max_volume'), meanVolumeDb: read('mean_volume') }
}

/** A live camera preview: state live with frames and real dimensions. */
export function assessCameraPreview(status, { minFrames = 10 } = {}) {
  const failures = []
  if (status?.state !== 'live') {
    failures.push(`camera state ${status?.state}: ${status?.message ?? ''}`)
  } else {
    if ((status.framesCaptured ?? 0) < minFrames) {
      failures.push(`camera framesCaptured=${status.framesCaptured ?? 0} < ${minFrames}`)
    }
    if (!(status.width > 0 && status.height > 0)) {
      failures.push(`camera live without dimensions (${status.width}x${status.height})`)
    }
  }
  return { ok: failures.length === 0, failures }
}

// Plan 257 S2: the camera streams one of its own V4L2 modes, which its live
// message names ("... the camera's native NV12 1280x720@30 from ..." or, when
// short of the canvas, "... is using NV12 1280x720@30 from ...").
const NATIVE_MODE = /(?:native|is using) ([A-Z0-9]{2,4}) (\d+)x(\d+)@(\d+)/

export function cameraNativeMode(message) {
  const match = NATIVE_MODE.exec(message ?? '')
  if (!match) return null
  return {
    format: match[1],
    width: Number(match[2]),
    height: Number(match[3]),
    fps: Number(match[4])
  }
}

export function assessCameraNativeMode(status) {
  const mode = cameraNativeMode(status?.message)
  return mode
    ? { ok: true, failures: [], mode }
    : {
        ok: false,
        failures: [
          `camera did not start one of its own modes: ${status?.message ?? '(no message)'}`
        ],
        mode: null
      }
}

/** utime + stime clock ticks from a /proc/<pid>/stat line. */
export function procStatCpuTicks(text) {
  // The command name may hold spaces and parentheses: fields restart after
  // the last ')'. utime and stime are fields 14 and 15 (11 and 12 after it).
  const rest = String(text ?? '')
    .slice(String(text ?? '').lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)
  const utime = Number(rest[11])
  const stime = Number(rest[12])
  return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : null
}

export function cpuPercent(ticksBefore, ticksAfter, elapsedMs, clockTicks = 100) {
  if (![ticksBefore, ticksAfter, elapsedMs, clockTicks].every(Number.isFinite)) return null
  if (elapsedMs <= 0 || clockTicks <= 0 || ticksAfter < ticksBefore) return null
  return ((ticksAfter - ticksBefore) * 100 * 1000) / clockTicks / elapsedMs
}

/** Plan 257 S2 done-when: the camera child is under 40 % CPU at 720p30. */
export function assessCameraChildCpu(sample, { maxPercent = 40 } = {}) {
  if (!sample || typeof sample.cpuPercent !== 'number') {
    return { ok: false, failures: ['camera FFmpeg child CPU was not measured'] }
  }
  return sample.cpuPercent < maxPercent
    ? { ok: true, failures: [] }
    : {
        ok: false,
        failures: [
          `camera FFmpeg child used ${sample.cpuPercent.toFixed(1)} % CPU (max ${maxPercent} %)`
        ]
      }
}
