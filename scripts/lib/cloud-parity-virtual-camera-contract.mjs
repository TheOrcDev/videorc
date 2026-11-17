/** Plan 249 S23 `virtual-camera` case: pure rules (no launch, no device).
 *
 * The acquisition (`cloud-parity-virtual-camera.mjs`) reads the registered
 * Videorc Camera from outside the app with the platform's FFmpeg while a
 * local LiveKit room runs and the host has opted the room's Program preview
 * into the camera. It records per-frame summaries (never media) for named
 * phases on one wall clock, and the app's own status and feed inspection.
 * This module judges that evidence. It never sets `productionQualified`.
 *
 * Phases, in order on one reader:
 * - `live`: the Program preview on the camera: 30 +- 1 fps, a moving picture
 *   (not a still), not black, status `room-program-preview`, encodedOutput false.
 * - `paused`: the Program preview not displayed: the camera turns black within
 *   `pauseWithinMs` and the status says `room-program-paused` (privacy: never
 *   a frozen or Studio picture).
 * - `resumed`: displayed again: live within `resumeWithinMs`.
 * - `off`: the opt-in off: the upload ends and the status names no source
 *   (the camera returns to its Studio source).
 * - `reconnected`: on again under a strictly newer generation, live again.
 * Feedback: no `<video>` in the Studio window plays a track labelled
 * Videorc Camera, and the room's camera is never Videorc Camera.
 */
import assert from 'node:assert/strict'

import { cadenceStats, fpsWithin } from './virtual-camera-smoke.mjs'

export const VIRTUAL_CAMERA_CASE = Object.freeze({
  env: 'VIDEORC_ROOM_PROGRAM_CAMERA',
  source: 'room-program-preview',
  pausedSource: 'room-program-paused',
  viewSource: 'program-page-report',
  phases: Object.freeze(['live', 'paused', 'resumed', 'off', 'reconnected'])
})

export const VIRTUAL_CAMERA_CASE_BUDGET = Object.freeze({
  fps: 30,
  fpsTolerance: 1,
  /** The judged live read must cover this share of its window. */
  coverageMin: 0.9,
  /** Mean luma (0..255) at or below this reads as the black paused still. */
  blackLumaMax: 24,
  /** A live frame must be brighter than black somewhere. */
  liveLumaMin: 30,
  /** A live read must show at least this many distinct pictures (not a still). */
  distinctMin: 10,
  pauseWithinMs: 2500,
  resumeWithinMs: 3000,
  /** The camera keeps its cadence through a pause (a black still repeats). */
  pausedFpsMin: 25
})

export function virtualCameraCaseConfig(env = {}) {
  const mode = env.VIDEORC_VIRTUAL_CAMERA_MODE ?? 'acquire-analyze'
  assert.ok(
    ['acquire', 'analyze', 'acquire-analyze'].includes(mode),
    'Invalid VIDEORC_VIRTUAL_CAMERA_MODE'
  )
  const seconds = Number(env.VIDEORC_VIRTUAL_CAMERA_SECONDS ?? 12)
  assert.ok(
    Number.isInteger(seconds) && seconds >= 5 && seconds <= 600,
    'VIDEORC_VIRTUAL_CAMERA_SECONDS 5..600'
  )
  const phaseSeconds = Number(env.VIDEORC_VIRTUAL_CAMERA_PHASE_SECONDS ?? 5)
  assert.ok(
    Number.isInteger(phaseSeconds) && phaseSeconds >= 3 && phaseSeconds <= 60,
    'VIDEORC_VIRTUAL_CAMERA_PHASE_SECONDS 3..60'
  )
  return { mode, liveMs: seconds * 1000, phaseMs: phaseSeconds * 1000, readinessMs: 30_000 }
}

/** BT.709 luma of an rgb24 frame's pixels, and a coarse 8x8 signature. */
export function frameSummary(rgb, width, height) {
  assert.equal(rgb.length, width * height * 3, 'Frame size')
  const cells = new Array(64).fill(0)
  const counts = new Array(64).fill(0)
  let sum = 0
  for (let y = 0; y < height; y++) {
    const cy = Math.min(7, Math.floor((y * 8) / height))
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3
      const luma = 0.2126 * rgb[at] + 0.7152 * rgb[at + 1] + 0.0722 * rgb[at + 2]
      sum += luma
      const cell = cy * 8 + Math.min(7, Math.floor((x * 8) / width))
      cells[cell] += luma
      counts[cell] += 1
    }
  }
  return {
    meanLuma: Math.round((sum / (width * height)) * 10) / 10,
    signature: cells.map((total, index) => Math.round(total / counts[index] / 8)).join('.')
  }
}

function inside(frames, window) {
  return frames.filter((frame) => frame.atMs >= window.fromMs && frame.atMs < window.toMs)
}

/** The first frame time at or after `fromMs` from which every frame satisfies `ok`. */
export function settledAt(frames, fromMs, toMs, ok) {
  let candidate = null
  for (const frame of frames) {
    if (frame.atMs < fromMs || frame.atMs >= toMs) continue
    if (ok(frame)) candidate ??= frame.atMs
    else candidate = null
  }
  return candidate
}

/** Judge one acquisition's evidence. */
export function assessVirtualCameraCase(evidence, budget = VIRTUAL_CAMERA_CASE_BUDGET) {
  const failures = []
  const checks = {}
  const frames = Array.isArray(evidence.frames) ? evidence.frames : []
  const phase = (name) => evidence.phases?.find((entry) => entry.name === name) ?? null
  const black = (frame) => frame.meanLuma <= budget.blackLumaMax
  const require = (id, ok, detail) => {
    checks[id] = { ok, detail }
    if (!ok) failures.push(`${id}: ${detail}`)
  }

  for (const name of VIRTUAL_CAMERA_CASE.phases)
    if (!phase(name)) failures.push(`phase ${name} missing from the evidence`)

  const live = phase('live')
  if (live) {
    const stats = cadenceStats(
      inside(frames, live).map((frame) => frame.atMs),
      live
    )
    const span = live.toMs - live.fromMs
    const covered = stats.spanMs >= span * budget.coverageMin
    require('liveCadence', covered &&
      fpsWithin(
        stats.fps,
        budget
      ), `${stats.fps ?? 'no'} fps over ${stats.spanMs} ms of ${span} ms (want ${budget.fps} +- ${budget.fpsTolerance})`)
    const liveFrames = inside(frames, live)
    const distinct = new Set(liveFrames.map((frame) => frame.signature)).size
    const lit = liveFrames.filter((frame) => frame.meanLuma >= budget.liveLumaMin).length
    require('liveProgram', distinct >= budget.distinctMin &&
      lit >=
        liveFrames.length *
          0.9, `${distinct} distinct pictures, ${lit} of ${liveFrames.length} frames lit`)
    require('liveIdentity', live.status?.source === VIRTUAL_CAMERA_CASE.source &&
      live.inspect?.viewSource === VIRTUAL_CAMERA_CASE.viewSource &&
      live.inspect?.encodedOutput === false &&
      live.inspect?.owned ===
        true, `status source ${live.status?.source ?? 'none'}, view ${live.inspect?.viewSource ?? 'none'}, encodedOutput ${live.inspect?.encodedOutput}`)
  }

  const paused = phase('paused')
  if (paused) {
    const at = settledAt(frames, paused.fromMs, paused.toMs, black)
    const stats = cadenceStats(
      inside(frames, paused).map((frame) => frame.atMs),
      paused
    )
    require('pausePrivacy', at !== null &&
      at - paused.fromMs <= budget.pauseWithinMs &&
      paused.status?.source ===
        VIRTUAL_CAMERA_CASE.pausedSource, `black from ${at === null ? 'never' : `${at - paused.fromMs} ms`}, status ${paused.status?.source ?? 'none'}`)
    require('pauseCadence', Number.isFinite(stats.fps) &&
      stats.fps >= budget.pausedFpsMin, `${stats.fps ?? 'no'} fps while paused`)
  }

  const resumed = phase('resumed')
  if (resumed) {
    const at = settledAt(frames, resumed.fromMs, resumed.toMs, (frame) => !black(frame))
    require('resume', at !== null &&
      at - resumed.fromMs <= budget.resumeWithinMs &&
      resumed.status?.source ===
        VIRTUAL_CAMERA_CASE.source, `lit from ${at === null ? 'never' : `${at - resumed.fromMs} ms`}, status ${resumed.status?.source ?? 'none'}`)
  }

  const off = phase('off')
  if (off)
    require('offReturnsToStudio', off.status?.source === undefined &&
      off.inspect?.owned ===
        false, `status source ${off.status?.source ?? 'none'}, feed owned ${off.inspect?.owned}`)

  const reconnected = phase('reconnected')
  if (reconnected) {
    const before = live?.inspect?.generation ?? 0
    const after = reconnected.inspect?.generation ?? 0
    const at = settledAt(frames, reconnected.fromMs, reconnected.toMs, (frame) => !black(frame))
    require('reconnect', after > before &&
      at !== null &&
      at - reconnected.fromMs <= budget.resumeWithinMs &&
      reconnected.status?.source ===
        VIRTUAL_CAMERA_CASE.source, `generation ${before} -> ${after}, lit from ${at === null ? 'never' : `${at - reconnected.fromMs} ms`}`)
  }

  const feedback = evidence.feedback
  require('noFeedbackLoop', Boolean(feedback) &&
    feedback.videorcTracksPlaying === 0 &&
    feedback.roomCameraIsVideorc === false, feedback
    ? `${feedback.videorcTracksPlaying} Videorc Camera track(s) playing, room camera ${feedback.roomCameraLabel ?? 'none'}`
    : 'no feedback evidence')

  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    productionQualified: false,
    checks,
    failures,
    unavailable: evidence.unavailable ?? []
  }
}
