// Separate source recordings (plan 157): one Record session can leave three
// files beside each other, Combined (mix), Screen (system audio) and Camera
// (microphone). These gates judge the TAKE, not one file: every armed role
// must exist, each file must carry exactly one video and one audio stream on
// the recording canvas, the audio tracks must be the ones the role promises
// (a swapped mic/system pairing is a hard failure), and the three files must
// cover the same span so an editor can lay them on one timeline.
//
// The pure evaluators take ffprobe JSON (or decoded PCM) that has already
// been read; the smoke scripts (`scripts/smoke-separate-source-take.mjs`,
// `scripts/smoke-separate-source-fixture.mjs`) do the I/O.

import path from 'node:path'

export const TAKE_ROLES = Object.freeze(['combined', 'screen', 'camera'])

/** Mirrors `RecordingRole::audio_track_title` in `source_iso.rs`. */
export const ROLE_AUDIO_TITLES = Object.freeze({
  combined: 'Mix',
  screen: 'System audio',
  camera: 'Microphone'
})

export const DEFAULT_TAKE_GATES = Object.freeze({
  // The three muxers stop on the same request; the ISO legs drain their own
  // FIFOs, so a second of spread is pipeline slack, more is a lost tail.
  maxDurationSpreadSeconds: 1.0,
  // Canvas law: every file of a take is the recording profile canvas.
  requireCanvasDimensions: true,
  // Audio law: one stereo PCM/AAC track per file, titled for its role.
  requireAudioTitles: true,
  expectedAudioChannels: 2
})

/**
 * Sibling paths for one take. The Combined file keeps its legacy name; the
 * ISO files insert the role before the extension (`...-screen.mkv`), which is
 * `recording_role_mkv_path` in `source_iso.rs`. Works for `.mkv` and `.mp4`.
 */
export function takeSiblingPaths(combinedPath) {
  // Windows rules on every host: they split on `/` and `\` alike, so a
  // Windows path read on POSIX never takes `.dir\take` for an extension.
  const extension = path.win32.extname(combinedPath)
  // Splice the role in before the extension; the directory and separators
  // are left exactly as given (POSIX or Windows), so the result sits beside
  // the Combined file on either platform.
  const stem = extension ? combinedPath.slice(0, -extension.length) : combinedPath
  return {
    combined: combinedPath,
    screen: `${stem}-screen${extension}`,
    camera: `${stem}-camera${extension}`
  }
}

/** Reads the role title ffprobe exposes for a stream (MKV `title`, MP4 `handler_name`). */
export function audioStreamTitle(stream) {
  const tags = stream?.tags ?? {}
  const title = tags.title ?? tags.TITLE ?? tags.handler_name ?? null
  return typeof title === 'string' && title.trim() ? title.trim() : null
}

function parseFraction(text) {
  if (typeof text !== 'string' || !text.includes('/')) return Number(text) || 0
  const [numerator, denominator] = text.split('/').map(Number)
  return denominator ? numerator / denominator : 0
}

/**
 * Reduces one raw ffprobe JSON document to the facts the take gates need.
 * `null` when the file was absent (`probe == null`).
 */
export function summarizeRoleProbe(ffprobeJson) {
  if (ffprobeJson == null) return null
  const raw = typeof ffprobeJson === 'string' ? JSON.parse(ffprobeJson) : ffprobeJson
  const streams = Array.isArray(raw.streams) ? raw.streams : []
  const video = streams.filter((stream) => stream.codec_type === 'video')
  const audio = streams.filter((stream) => stream.codec_type === 'audio')
  const primaryVideo = video[0] ?? null
  return {
    durationSeconds: Number(raw.format?.duration) || 0,
    videoStreams: video.length,
    audioStreams: audio.length,
    width: primaryVideo?.width ?? 0,
    height: primaryVideo?.height ?? 0,
    fps: primaryVideo ? parseFraction(primaryVideo.r_frame_rate) : 0,
    audioChannels: audio[0]?.channels ?? 0,
    audioTitle: audio[0] ? audioStreamTitle(audio[0]) : null
  }
}

/**
 * Judges one take.
 *
 * @param {{combined?: object|null, screen?: object|null, camera?: object|null}} summaries
 *   `summarizeRoleProbe` output per role; `null`/absent means the file is missing.
 * @param {{roles?: string[], video?: {width:number,height:number,fps:number}|null}} expectations
 *   `roles` are the roles the session armed (default: all three).
 * @returns {{pass:boolean, failures:string[], warnings:string[]}}
 */
export function evaluateTake(summaries, expectations = {}, gates = DEFAULT_TAKE_GATES) {
  const settings = { ...DEFAULT_TAKE_GATES, ...gates }
  const roles = expectations.roles ?? TAKE_ROLES
  const canvas = expectations.video ?? null
  const failures = []
  const warnings = []

  for (const role of roles) {
    if (!TAKE_ROLES.includes(role)) {
      failures.push(`unknown recording role ${JSON.stringify(role)}`)
      continue
    }
    const summary = summaries[role]
    if (!summary) {
      failures.push(`${role} file is missing from the take`)
      continue
    }
    if (summary.videoStreams !== 1) {
      failures.push(`${role} file has ${summary.videoStreams} video streams (expected 1)`)
    }
    if (summary.audioStreams !== 1) {
      failures.push(`${role} file has ${summary.audioStreams} audio streams (expected 1)`)
    } else {
      if (
        settings.expectedAudioChannels != null &&
        summary.audioChannels !== settings.expectedAudioChannels
      ) {
        failures.push(
          `${role} audio has ${summary.audioChannels} channels (expected ${settings.expectedAudioChannels})`
        )
      }
      const expectedTitle = ROLE_AUDIO_TITLES[role]
      if (summary.audioTitle == null) {
        ;(settings.requireAudioTitles ? failures : warnings).push(
          `${role} audio track carries no title (expected ${JSON.stringify(expectedTitle)})`
        )
      } else if (summary.audioTitle !== expectedTitle) {
        const swappedRole = TAKE_ROLES.find(
          (candidate) => ROLE_AUDIO_TITLES[candidate] === summary.audioTitle
        )
        failures.push(
          swappedRole
            ? `${role} file carries the ${swappedRole} audio track (${JSON.stringify(summary.audioTitle)}); the pairing is swapped`
            : `${role} audio track is titled ${JSON.stringify(summary.audioTitle)} (expected ${JSON.stringify(expectedTitle)})`
        )
      }
    }
    if (canvas && settings.requireCanvasDimensions) {
      if (summary.width !== canvas.width || summary.height !== canvas.height) {
        failures.push(
          `${role} video is ${summary.width}x${summary.height} (expected the ${canvas.width}x${canvas.height} recording canvas)`
        )
      }
      if (canvas.fps && Math.abs(summary.fps - canvas.fps) > 0.5) {
        failures.push(`${role} video is ${summary.fps.toFixed(2)} fps (expected ${canvas.fps})`)
      }
    }
    if (!(summary.durationSeconds > 0)) {
      failures.push(`${role} file reports no positive duration`)
    }
  }

  const durations = roles
    .map((role) => summaries[role]?.durationSeconds)
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
  if (durations.length > 1) {
    const spread = Math.max(...durations) - Math.min(...durations)
    if (spread > settings.maxDurationSpreadSeconds) {
      failures.push(
        `take files differ in duration by ${spread.toFixed(2)}s (limit ${settings.maxDurationSpreadSeconds.toFixed(2)}s)`
      )
    } else if (spread > settings.maxDurationSpreadSeconds / 2) {
      warnings.push(`take files differ in duration by ${spread.toFixed(2)}s`)
    }
  }

  return { pass: failures.length === 0, failures, warnings }
}

/** Which bus ingredient each role's audio carries (`source_audio_tap.rs`). */
export const ROLE_AUDIO_SOURCES = Object.freeze({
  combined: Object.freeze(['microphone', 'system']),
  screen: Object.freeze(['system']),
  camera: Object.freeze(['microphone'])
})

/**
 * Amplitude of `frequency` in one channel of interleaved PCM (Goertzel). Over
 * a whole number of cycles a pure tone reads its peak amplitude and a tone at
 * another whole-cycle frequency reads zero.
 */
export function toneAmplitude(
  samples,
  { frequency, sampleRate = 48000, channels = 2, channel = 0 }
) {
  const frames = Math.floor(samples.length / channels)
  if (frames === 0) return 0
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate)
  let previous = 0
  let before = 0
  for (let frame = 0; frame < frames; frame += 1) {
    const current = samples[frame * channels + channel] + coefficient * previous - before
    before = previous
    previous = current
  }
  const power = previous * previous + before * before - coefficient * previous * before
  return (2 * Math.sqrt(Math.max(power, 0))) / frames
}

/**
 * Judges which source each role's audio carries from its decoded samples,
 * not its track title: a take whose mic and system samples were swapped
 * under the right titles still fails here.
 *
 * @param {{[role: string]: {microphone: number, system: number}|null}} levels
 *   Measured amplitude of the microphone and system fixture tones per role.
 * @param {{microphone: number, system: number}} expected
 *   The amplitude each tone was recorded at.
 * @returns {{pass:boolean, failures:string[]}}
 */
export function evaluateRoleAudioSources(levels, expected, gates = {}) {
  // `tolerance`: a carried tone within ±20% of its level (lossy encode);
  // `maxBleed`: a source a role must not carry stays under 5% of its level.
  const { roles = TAKE_ROLES, tolerance = 0.2, maxBleed = 0.05 } = gates
  const failures = []
  for (const role of roles) {
    const level = levels[role]
    if (!level) {
      failures.push(`${role} audio was not measured`)
      continue
    }
    const wanted = ROLE_AUDIO_SOURCES[role]
    const missing = []
    const foreign = []
    for (const source of ['microphone', 'system']) {
      const amplitude = level[source]
      if (wanted.includes(source)) {
        if (!(Math.abs(amplitude - expected[source]) <= expected[source] * tolerance)) {
          missing.push(source)
        }
      } else if (!(amplitude <= expected[source] * maxBleed)) {
        foreign.push(source)
      }
    }
    const swappedRole =
      missing.length === wanted.length && foreign.length > 0
        ? TAKE_ROLES.find(
            (candidate) =>
              candidate !== role &&
              candidate !== 'combined' &&
              ROLE_AUDIO_SOURCES[candidate].join() === foreign.join()
          )
        : undefined
    if (swappedRole) {
      failures.push(
        `${role} file carries the ${swappedRole} audio samples (${foreign.join(' + ')}); the pairing is swapped`
      )
      continue
    }
    for (const source of missing) {
      failures.push(
        `${role} audio lacks the ${source} (amplitude ${level[source].toFixed(3)}, expected ${expected[source]})`
      )
    }
    for (const source of foreign) {
      failures.push(
        `${role} audio carries the ${source} (amplitude ${level[source].toFixed(3)}); it must hold ${wanted.join(' + ')} only`
      )
    }
  }
  return { pass: failures.length === 0, failures }
}
