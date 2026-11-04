import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_GATES, evaluateGates } from './recording-analyzer.mjs'
import {
  hardContentContract,
  OPENH264_ENCODE_BACKEND,
  softwareSkipGates,
  softwareSkipWarning
} from './recording-matrix-software-skip.mjs'

// The matrix laws this helper must keep: the 2 s keyframe cadence and the
// A/V stop tail (smoke-recording-matrix-app.mjs MATRIX_GATES).
const MATRIX_LIKE_GATES = Object.freeze({
  ...DEFAULT_GATES,
  requireKeyframeEvidence: true,
  keyframeMaxIntervalSeconds: 2.5,
  maxTailMismatchMs: 100
})

// A 12 s 1080p60 noise take as OpenH264 writes it with -allow_skip_frames 1:
// 35 of 720 frames encoded, every forced 2 s keyframe present (measured on
// the Linux box, 2026-11-03).
const skippingTake = {
  hasVideo: true,
  hasAudio: true,
  expectAudio: true,
  longestFreezeMs: 0,
  freezeCount: 0,
  maxRepeatedFrameRun: 1,
  repeatedBurstCount: 0,
  expectedFrames: 720,
  observedFrames: 35,
  observedFrameHashes: 35,
  uniqueFrameCount: 35,
  uniqueFrameRatio: 1,
  maxAudioGapMs: 0,
  longestSilenceMs: 0,
  silenceCount: 0,
  digitalZeroRunCount: 0,
  longestDigitalZeroMs: 0,
  firstDigitalZeroSeconds: null,
  avSkewMs: 10,
  durationSeconds: 11.85,
  frameDerivedDurationSeconds: 35 / 60,
  durationStretchRatio: 11.85 / (35 / 60),
  intendedFps: 60,
  keyframeCount: 6,
  maxKeyframeIntervalSeconds: 2,
  tailMismatchMs: 20,
  colorSpace: 'bt709',
  colorPrimaries: 'bt709',
  colorTransfer: 'bt709',
  colorRange: 'tv'
}

test('a declared stress combo stays under the stress contract on any backend', () => {
  for (const encodeBackend of ['videotoolbox', OPENH264_ENCODE_BACKEND]) {
    assert.equal(hardContentContract({ stress: true, hardContent: true, encodeBackend }), 'stress')
  }
})

test('hard content on OpenH264 runs under the software-skip contract', () => {
  assert.equal(
    hardContentContract({
      stress: false,
      hardContent: true,
      encodeBackend: OPENH264_ENCODE_BACKEND
    }),
    'software-skip'
  )
})

test('easy content on OpenH264 and hard content on a hardware encoder keep full cadence', () => {
  assert.equal(
    hardContentContract({
      stress: false,
      hardContent: false,
      encodeBackend: OPENH264_ENCODE_BACKEND
    }),
    'full'
  )
  for (const encodeBackend of ['videotoolbox', 'vaapi', 'media-foundation', undefined]) {
    assert.equal(hardContentContract({ stress: false, hardContent: true, encodeBackend }), 'full')
  }
})

test('the software-skip gates relax only the frame-skipping laws', () => {
  const gates = softwareSkipGates(MATRIX_LIKE_GATES)
  assert.equal(gates.frameCountTolerance, Number.POSITIVE_INFINITY)
  assert.equal(gates.cadenceMismatchTolerancePct, Number.POSITIVE_INFINITY)
  assert.equal(gates.maxDurationStretchRatio, Number.POSITIVE_INFINITY)
  assert.equal(gates.keyframeMaxIntervalSeconds, 2.5)
  assert.equal(gates.requireKeyframeEvidence, true)
  assert.equal(gates.maxTailMismatchMs, 100)
  assert.ok(Object.isFrozen(gates))
})

test('a skipping OpenH264 take passes the software-skip gates and fails the full ones', () => {
  assert.deepEqual(evaluateGates(skippingTake, softwareSkipGates(MATRIX_LIKE_GATES)).failures, [])
  const full = evaluateGates(skippingTake, MATRIX_LIKE_GATES).failures
  assert.ok(full.some((failure) => /^frame count 35 vs expected ~720/.test(failure)))
  assert.ok(full.some((failure) => /^timestamp\/duration stretch/.test(failure)))
})

test('the software-skip gates still fail a lost keyframe or a long stop tail', () => {
  const gates = softwareSkipGates(MATRIX_LIKE_GATES)
  assert.match(
    evaluateGates({ ...skippingTake, maxKeyframeIntervalSeconds: 6 }, gates).failures.join('\n'),
    /keyframe interval 6\.00s exceeds 2\.5s/
  )
  assert.match(
    evaluateGates(
      { ...skippingTake, keyframeCount: 1, maxKeyframeIntervalSeconds: null },
      gates
    ).failures.join('\n'),
    /keyframe evidence requires at least two sampled keyframes/
  )
  assert.match(
    evaluateGates({ ...skippingTake, tailMismatchMs: 300 }, gates).failures.join('\n'),
    /A\/V tail mismatch 300ms exceeds 100ms/
  )
})

test('the warning names the observed and requested cadence', () => {
  assert.equal(
    softwareSkipWarning({ label: '1080p60:hard', requestedFps: 60, observedFps: 8.5 }),
    '1080p60:hard: OpenH264 held 8.50 fps of 60 under per-frame noise; frame skipping on overshoot is the software encoder posture, so cadence is not gated here'
  )
  assert.match(
    softwareSkipWarning({ label: 'x', requestedFps: 60, observedFps: null }),
    /unknown fps/
  )
})
