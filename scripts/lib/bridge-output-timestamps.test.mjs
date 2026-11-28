import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { DEFAULT_GATES, evaluateGates } from './recording-analyzer.mjs'
import {
  arrivalStampedNote,
  bridgeOutputStampsByArrival,
  duplicatePtsGatesForBridgeOutput
} from './bridge-output-timestamps.mjs'

test('only the Annex-B aliases stamp by arrival; the default and MPEG-TS carry their own PTS', () => {
  for (const setting of ['videotoolbox-h264', 'h264', 'annex-b', 'annexb', ' Annex-B ']) {
    assert.equal(bridgeOutputStampsByArrival(setting), true, setting)
  }
  for (const setting of [
    undefined,
    '',
    'videotoolbox-h264-mpegts',
    'h264-mpegts',
    'mpegts',
    'mpeg-ts',
    'windows-media-foundation-h264-mpegts',
    'raw-yuv420p'
  ]) {
    assert.equal(bridgeOutputStampsByArrival(setting), false, String(setting))
  }
})

test('the alias list matches parse_encoder_bridge_video_output in recording.rs', () => {
  // The Rust parser is the source of truth: the Annex-B arm is exactly these aliases.
  const source = readFileSync(
    new URL('../../crates/videorc-backend/src/recording.rs', import.meta.url),
    'utf8'
  )
  const arm = source.match(
    /"videotoolbox-h264" \| "h264" \| "annex-b" \| "annexb" => \{\s*EncoderBridgeVideoOutput::VideoToolboxH264AnnexB/
  )
  assert.ok(arm, 'recording.rs no longer maps these four aliases to the Annex-B output')
})

test('a take with its own PTS must have exactly zero duplicates; an arrival-stamped one is not gated', () => {
  assert.deepEqual(duplicatePtsGatesForBridgeOutput(undefined), {
    maxDuplicatePtsCount: 0,
    maxDuplicatePtsRun: 1
  })
  assert.deepEqual(duplicatePtsGatesForBridgeOutput('videotoolbox-h264-mpegts'), {
    maxDuplicatePtsCount: 0,
    maxDuplicatePtsRun: 1
  })
  const annexB = duplicatePtsGatesForBridgeOutput('videotoolbox-h264')
  assert.equal(annexB.maxDuplicatePtsCount, Number.POSITIVE_INFINITY)
  assert.equal(annexB.maxDuplicatePtsRun, Number.POSITIVE_INFINITY)
})

// A clean MPEG-TS-shaped take (copied from the analyzer's own tests), so a
// failure below is the duplicate-PTS gate and nothing else.
const CLEAN = {
  hasVideo: true,
  hasAudio: true,
  expectAudio: false,
  longestFreezeMs: 0,
  freezeCount: 0,
  maxRepeatedFrameRun: 1,
  repeatedBurstCount: 0,
  expectedFrames: 90,
  observedFrames: 90,
  observedFrameHashes: 90,
  uniqueFrameCount: 90,
  uniqueFrameRatio: 1,
  maxAudioGapMs: 0,
  longestSilenceMs: 0,
  silenceCount: 0,
  digitalZeroRunCount: 0,
  longestDigitalZeroMs: 0,
  firstDigitalZeroSeconds: null,
  avSkewMs: 10,
  durationSeconds: 3,
  frameDerivedDurationSeconds: 3,
  durationStretchRatio: 1,
  colorSpace: 'bt709',
  colorPrimaries: 'bt709',
  colorTransfer: 'bt709',
  colorRange: 'tv'
}

function verdict(duplicates, setting) {
  return evaluateGates(
    { ...CLEAN, ...duplicates },
    { ...DEFAULT_GATES, requireMotion: false, ...duplicatePtsGatesForBridgeOutput(setting) }
  )
}

test('the gate fails one duplicate on the default output and passes 124 on Annex-B', () => {
  // The measured Annex-B take (2026-11-28, current main): 124 near-zero deltas, run of 18.
  const measured = { duplicatePtsCount: 124, maxDuplicatePtsRun: 18 }
  const isDuplicateFailure = (failure) => failure.startsWith('duplicate video PTS')

  assert.ok(
    verdict(measured, undefined).failures.some(isDuplicateFailure),
    'an MPEG-TS take with duplicate PTS must fail'
  )
  assert.ok(
    !verdict(measured, 'videotoolbox-h264').failures.some(isDuplicateFailure),
    'an arrival-stamped take reports its duplicates instead of failing on them'
  )
  // One stray duplicate on the default output is already a failure (the analyzer's own default allows 2).
  assert.ok(
    verdict({ duplicatePtsCount: 1, maxDuplicatePtsRun: 2 }, undefined).failures.some(
      isDuplicateFailure
    )
  )
  const clean = verdict({ duplicatePtsCount: 0, maxDuplicatePtsRun: 1 }, undefined)
  assert.deepEqual(clean.failures, [])
})

test('the note names the counts and says which output must have none', () => {
  const note = arrivalStampedNote(124, 18)
  assert.match(note, /124 near-zero/)
  assert.match(note, /run 18/)
  assert.match(note, /MPEG-TS/)
})
