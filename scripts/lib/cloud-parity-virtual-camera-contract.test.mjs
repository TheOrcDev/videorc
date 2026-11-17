import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  VIRTUAL_CAMERA_CASE,
  assessVirtualCameraCase,
  frameSummary,
  settledAt,
  virtualCameraCaseConfig
} from './cloud-parity-virtual-camera-contract.mjs'

// Plan 249 S23: the `virtual-camera` case's rules, on synthetic evidence.

const PHASE_MS = 5000

/** A 30 fps reader over [fromMs, toMs) with each frame's luma and picture. */
function read(fromMs, toMs, frame) {
  const frames = []
  for (let atMs = fromMs; atMs < toMs; atMs += 1000 / 30) frames.push({ atMs, ...frame(atMs) })
  return frames
}

const lit = (atMs) => ({ meanLuma: 90, signature: `p${Math.floor(atMs / 100)}` })
const black = () => ({ meanLuma: 16, signature: 'black' })
const status = (source) => (source ? { on: true, state: 'streaming', source } : { on: true })
const inspect = (owned, generation) => ({
  owned,
  generation,
  viewSource: 'program-page-report',
  encodedOutput: false
})

function passingEvidence() {
  const at = (index) => index * PHASE_MS
  const phases = [
    { name: 'live', status: status('room-program-preview'), inspect: inspect(true, 100) },
    { name: 'paused', status: status('room-program-paused'), inspect: inspect(true, 100) },
    { name: 'resumed', status: status('room-program-preview'), inspect: inspect(true, 100) },
    { name: 'off', status: status(null), inspect: inspect(false, undefined) },
    { name: 'reconnected', status: status('room-program-preview'), inspect: inspect(true, 101) }
  ].map((entry, index) => ({ ...entry, fromMs: at(index), toMs: at(index + 1) }))
  const frames = [
    ...read(at(0), at(1), lit),
    // 600 ms of the last live picture, then black.
    ...read(at(1), at(2), (atMs) => (atMs < at(1) + 600 ? lit(atMs) : black())),
    ...read(at(2), at(3), (atMs) => (atMs < at(2) + 400 ? black() : lit(atMs))),
    ...read(at(3), at(4), black),
    ...read(at(4), at(5), (atMs) => (atMs < at(4) + 800 ? black() : lit(atMs)))
  ]
  return {
    phases,
    frames,
    feedback: { videorcTracksPlaying: 0, roomCameraIsVideorc: false, roomCameraLabel: 'FaceTime' }
  }
}

test('config: modes and bounded durations', () => {
  assert.deepEqual(virtualCameraCaseConfig({}), {
    mode: 'acquire-analyze',
    liveMs: 12_000,
    phaseMs: 5000,
    readinessMs: 30_000
  })
  assert.throws(() => virtualCameraCaseConfig({ VIDEORC_VIRTUAL_CAMERA_MODE: 'live' }))
  assert.throws(() => virtualCameraCaseConfig({ VIDEORC_VIRTUAL_CAMERA_SECONDS: '2' }))
  assert.throws(() => virtualCameraCaseConfig({ VIDEORC_VIRTUAL_CAMERA_PHASE_SECONDS: '1' }))
  assert.equal(VIRTUAL_CAMERA_CASE.phases.length, 5)
})

test('frame summary: luma and a coarse signature', () => {
  const width = 16
  const height = 8
  const rgb = new Uint8Array(width * height * 3).fill(255)
  const white = frameSummary(rgb, width, height)
  assert.equal(white.meanLuma, 255)
  rgb.fill(0, 0, (width * height * 3) / 2)
  const half = frameSummary(rgb, width, height)
  assert.ok(half.meanLuma > 120 && half.meanLuma < 135)
  assert.notEqual(half.signature, white.signature)
  assert.throws(() => frameSummary(new Uint8Array(3), width, height))
})

test('settledAt: the first frame after which every frame qualifies', () => {
  const frames = [0, 10, 20, 30, 40].map((atMs, index) => ({ atMs, ok: index !== 1 }))
  assert.equal(
    settledAt(frames, 0, 50, (frame) => frame.ok),
    20
  )
  assert.equal(
    settledAt(frames, 0, 15, (frame) => frame.ok),
    null
  )
})

test('a full, honest run passes and never qualifies production', () => {
  const result = assessVirtualCameraCase(passingEvidence())
  assert.deepEqual(result.failures, [])
  assert.equal(result.status, 'passed')
  assert.equal(result.productionQualified, false)
})

test('a still (no motion) or the wrong cadence fails the live read', () => {
  const still = passingEvidence()
  still.frames = still.frames.map((frame) =>
    frame.atMs < PHASE_MS ? { ...frame, signature: 'still' } : frame
  )
  assert.match(assessVirtualCameraCase(still).failures.join('\n'), /liveProgram/)
  const slow = passingEvidence()
  slow.frames = slow.frames.filter((frame, index) => frame.atMs >= PHASE_MS || index % 2 === 0)
  assert.match(assessVirtualCameraCase(slow).failures.join('\n'), /liveCadence/)
})

test('a pause that freezes the last picture or names the wrong source fails privacy', () => {
  const frozen = passingEvidence()
  frozen.frames = frozen.frames.map((frame) =>
    frame.atMs >= PHASE_MS && frame.atMs < 2 * PHASE_MS
      ? { ...frame, meanLuma: 90, signature: 'frozen' }
      : frame
  )
  assert.match(assessVirtualCameraCase(frozen).failures.join('\n'), /pausePrivacy/)
  const studio = passingEvidence()
  studio.phases[1].status = status(null)
  assert.match(assessVirtualCameraCase(studio).failures.join('\n'), /pausePrivacy/)
})

test('the encoded-stream claim, a kept upload after off, a reused generation and a loop fail', () => {
  const encoded = passingEvidence()
  encoded.phases[0].inspect = { ...encoded.phases[0].inspect, encodedOutput: true }
  assert.match(assessVirtualCameraCase(encoded).failures.join('\n'), /liveIdentity/)
  const kept = passingEvidence()
  kept.phases[3].inspect = inspect(true, 100)
  assert.match(assessVirtualCameraCase(kept).failures.join('\n'), /offReturnsToStudio/)
  const reused = passingEvidence()
  reused.phases[4].inspect = inspect(true, 100)
  assert.match(assessVirtualCameraCase(reused).failures.join('\n'), /reconnect/)
  const loop = passingEvidence()
  loop.feedback = { videorcTracksPlaying: 1, roomCameraIsVideorc: true }
  assert.match(assessVirtualCameraCase(loop).failures.join('\n'), /noFeedbackLoop/)
  const missing = passingEvidence()
  missing.phases = missing.phases.slice(0, 2)
  assert.match(assessVirtualCameraCase(missing).failures.join('\n'), /phase resumed missing/)
})
