/** Pure acquisition configuration and final artifact checks. Never starts media. */
import assert from 'node:assert/strict'
export function outputsConfig(env = process.env) {
  const seconds = Number(env.VIDEORC_OUTPUTS_SECONDS ?? 4)
  assert.ok(
    Number.isInteger(seconds) && seconds >= 3 && seconds <= 10,
    'Output windows must be 3–10 seconds'
  )
  return { seconds, deadlineMs: 600000, maxArtifactBytes: 128 * 1024 * 1024 }
}
export function assessOutputProbe(probe, orientation, seconds) {
  const video = probe.streams?.find((s) => s.codec_type === 'video')
  const audio = probe.streams?.find((s) => s.codec_type === 'audio')
  const fraction = (value) => {
    const [n, d = '1'] = String(value).split('/')
    return Number(n) / Number(d)
  }
  const duration = Number(video?.duration ?? probe.format?.duration)
  const bitrate = Number(video?.bit_rate)
  const checks = {
    dimensions:
      video?.width === (orientation === 'h' ? 1920 : 1080) &&
      video?.height === (orientation === 'h' ? 1080 : 1920),
    fps: Math.abs(fraction(video?.avg_frame_rate) - 60) <= 0.5,
    frames: Number(video?.nb_read_frames) >= duration * 59,
    duration: Number.isFinite(duration) && duration >= seconds - 0.5 && duration <= seconds + 30,
    codec: video?.codec_name === 'h264' && video?.profile === 'High',
    color:
      video?.color_space === 'bt709' &&
      video?.color_transfer === 'bt709' &&
      video?.color_primaries === 'bt709' &&
      video?.color_range === 'tv',
    // Static fixture lower floor, not a hard-content encoder-capacity qualification.
    bitrate: Number.isFinite(bitrate) && bitrate >= 100000 && bitrate <= 7500000,
    audio:
      audio?.codec_name === 'aac' &&
      Number(audio?.sample_rate) === 48000 &&
      Number(audio?.channels) >= 1
  }
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    measured: { duration, bitrate, fps: fraction(video?.avg_frame_rate) }
  }
}
export function assertOutputPixels(frames, { expected, absent = false, tolerance = 28 }) {
  assert.ok(frames.length > 0 && frames.length % 3 === 0, 'Decoded pixels unavailable')
  let matched = 0
  for (let i = 0; i < frames.length; i += 3)
    if (expected.every((v, c) => Math.abs(frames[i + c] - v) <= tolerance)) matched++
  const fraction = matched / (frames.length / 3)
  assert.ok(
    absent ? fraction < 0.05 : fraction > 0.6,
    `Final artifact placement/consent failed (${fraction})`
  )
  return fraction
}

/**
 * The fake web's copy of the managed output admission and profile
 * (apps/desktop/src/shared/cloud-output-profile.ts, web
 * lib/cloud/media/output-profile.ts). Pinned to the same vectors,
 * protocol-fixtures/cloud-parity-outputs.json, by its test.
 */
const SIDES = { horizontal: [1920, 1080], vertical: [1080, 1920] }
export function fakeManagedOutputProblem(outputs) {
  if (
    !Array.isArray(outputs) ||
    outputs.length < 1 ||
    outputs.length > 2 ||
    new Set(outputs.map((o) => o.orientation)).size !== outputs.length
  )
    return 'Choose one output per orientation before opening the room.'
  for (const o of outputs) {
    if (
      !SIDES[o.orientation] ||
      ![o.width, o.height, o.fps, o.videoKbps].every((n) => Number.isSafeInteger(n) && n > 0)
    )
      return 'Cloud room outputs need a size, a frame rate and a bitrate.'
    const [width, height] = SIDES[o.orientation]
    if (o.width * height !== o.height * width)
      return o.orientation === 'vertical'
        ? 'A vertical cloud output must be 9:16.'
        : 'A horizontal cloud output must be 16:9.'
    if (o.width > width || o.height > height) {
      const long = Math.max(o.width, o.height)
      const label = long <= 2560 ? '1440p' : long <= 3840 ? '4K' : 'This size'
      return `Cloud talk shows send 1080p. ${label} hasn't been measured on cloud outputs yet, so it can't be used. Choose 1080p or lower for the room, or stream directly.`
    }
    if (o.fps > 60) return 'Cloud talk shows send at most 60 fps.'
  }
  return null
}
export function fakeManagedOutputProfile(outputs) {
  return {
    version: 1,
    requested: outputs.map((o) => ({ ...o })),
    effective: outputs.map((o) => {
      const [width, height] = SIDES[o.orientation]
      const differences = []
      if (o.width !== width || o.height !== height) differences.push('resolution')
      if (o.fps > 30) differences.push('fps')
      if (o.videoKbps !== 6000) differences.push('bitrate')
      return {
        orientation: o.orientation,
        width,
        height,
        fps: 60,
        pictureFps: 30,
        videoKbps: 6000,
        audioKbps: 160,
        differences
      }
    }),
    qualification: 'phase0-1080p30-picture',
    higherProfilesQualified: false,
    pricePerHour: null,
    maxProgramEgresses: outputs.length * 2
  }
}
