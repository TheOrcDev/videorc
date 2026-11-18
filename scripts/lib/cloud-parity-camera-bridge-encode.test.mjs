import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENCODE_ASSOCIATION_RULES,
  ENCODE_OBSERVATION_BUDGET,
  OBSERVED,
  PUBLISH_LIMITATION,
  associateEncodedFrames,
  encodeObservationGate,
  encodedRecordsFromObservations,
  unwrapRtp
} from './cloud-parity-camera-bridge-encode.mjs'

const FRAME_US = 33_333
// Native frames written at 30 fps; ptsUs and writtenAtMs both observed. Real
// capture pts carry jitter (up to ~1 ms here); `uniform` mirrors the S13a
// fixture's `pts_us(sequence) = sequence * 1e6 / 30`.
function jitterUs(i) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) % 1000
}
function written(count, { startPts = 1_000_000, startMs = 5_000, uniform = false } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    sequence: i + 1,
    ptsUs: uniform ? Math.floor(((i + 1) * 1_000_000) / 30) : startPts + i * FRAME_US + jitterUs(i),
    writtenAtMs: startMs + i * (FRAME_US / 1000)
  }))
}
// Encoded output that follows the hypothesis: rtp = offset + round(ptsUs * 0.09) mod 2^32.
function encodedFor(native, { offset = 12_345, delayMs = 8, bracket = [-0.5, 0.5] } = {}) {
  return native.map((w) => ({
    rtpTimestamp: (offset + Math.round(w.ptsUs * 0.09)) % 2 ** 32,
    atMs: w.writtenAtMs + delayMs,
    offsetLowMs: bracket?.[0] ?? null,
    offsetHighMs: bracket?.[1] ?? null
  }))
}

test('unwrapRtp follows 32-bit wrap in both directions', () => {
  assert.deepEqual(unwrapRtp([2 ** 32 - 10, 5, 2 ** 32 - 3]), [
    2 ** 32 - 10,
    2 ** 32 + 5,
    2 ** 32 - 3
  ])
})

test('a consistent mapping across an RTP wrap is accepted with interval delays', () => {
  const native = written(90)
  const start = Math.round(native[0].ptsUs * 0.09)
  const offset = 2 ** 32 - start - 30 * 3000 // wraps about one second in
  const encoded = encodedFor(native, { offset })
  const result = associateEncodedFrames(native, encoded)
  assert.equal(result.status, 'mapped')
  assert.equal(result.observed, OBSERVED)
  assert.equal(result.limitation, PUBLISH_LIMITATION)
  assert.equal(result.wrapped, true)
  assert.equal(result.matched, 90)
  assert.equal(result.matchFraction, 1)
  assert.equal(result.offsetTicks, offset)
  assert.equal(result.encodeDelayMs.point.p50, 8)
  // The measured bracket widens the interval: [atMs - high, atMs - low] - writtenAtMs.
  assert.equal(result.encodeDelayMs.lower.p95, 7.5)
  assert.equal(result.encodeDelayMs.upper.p95, 8.5)
  assert.deepEqual(result.unmatched, {
    droppedByEncoder: 0,
    notObserved: 0,
    encodedWithoutNative: 0
  })
  const gate = encodeObservationGate(result)
  assert.equal(gate.status, 'passed')
  assert.equal(gate.budget.kind, 'declared budget, not a measurement')
  assert.equal(gate.packetizedSentTiming, 'unavailable')
})

test('encoder drops are counted separately from frames the observer could not see', () => {
  const native = written(80)
  const encoded = encodedFor(native).filter((_, i) => i % 20 !== 7) // 4 never encoded
  const lossless = associateEncodedFrames(native, encoded)
  assert.equal(lossless.status, 'mapped')
  assert.equal(lossless.unmatched.droppedByEncoder, 4)
  const lossy = associateEncodedFrames(native, encoded, { observerDropped: 3 })
  assert.equal(lossy.unmatched.droppedByEncoder, null)
  assert.equal(lossy.unmatched.notObserved, 4)
})

test('inconsistent RTP is refused and nothing is synthesized', () => {
  const native = written(60)
  // RTP from a 90 kHz clock that is NOT the VideoFrame timestamp (ms quantized + jitter).
  const encoded = native.map((w, i) => ({
    rtpTimestamp: 7_000 + Math.round(w.writtenAtMs) * 90 + ((i * 37) % 11) * 9,
    atMs: w.writtenAtMs + 5,
    offsetLowMs: -1,
    offsetHighMs: 1
  }))
  const result = associateEncodedFrames(native, encoded)
  assert.equal(result.status, 'unavailable')
  assert.equal(
    result.reason,
    'RTP timestamps are not derived from native VideoFrame timestamps in this run'
  )
  assert.ok(result.evidence.bestMatchFraction < 0.95)
  assert.equal(result.encodeDelayMs, undefined)
  assert.equal(result.samples, undefined)
  assert.equal(encodeObservationGate(result).status, 'unavailable')
})

test('evenly spaced native pts leave the pairing ambiguous, so nothing is mapped', () => {
  const native = written(120, { uniform: true })
  const result = associateEncodedFrames(native, encodedFor(native))
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /^Ambiguous: \d+ distinct RTP offsets/)
  assert.ok(result.evidence.passingOffsets.length > 1)
  assert.equal(result.encodeDelayMs, undefined)
  assert.equal(encodeObservationGate(result).status, 'unavailable')
})

test('too few encoded frames are unavailable', () => {
  const native = written(29)
  const result = associateEncodedFrames(native, encodedFor(native))
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /Too few encoded frames/)
  assert.equal(result.evidence.encodedFrames, 29)
})

test('a native write after the encode time is refused, not matched', () => {
  const native = written(60)
  const result = associateEncodedFrames(native, encodedFor(native, { delayMs: -3 }))
  assert.equal(result.status, 'unavailable')
  assert.ok(result.evidence.bestMatchFraction < 0.95)
  // The RTP-consistent pairing exists; only the order check rejects it.
  assert.equal(result.evidence.passingOffsets.length, 0)
  assert.equal(result.evidence.orderViolationsMax, 60)
})

test('frames without a measured bracket keep a point value but no interval', () => {
  const native = written(40)
  const result = associateEncodedFrames(native, encodedFor(native, { bracket: null }))
  assert.equal(result.status, 'mapped')
  assert.equal(result.encodeDelayMs.unbracketedFrames, 40)
  assert.equal(result.encodeDelayMs.upper, null)
  assert.equal(encodeObservationGate(result).status, 'unavailable')
})

test('the declared budget fails a slow encoder', () => {
  const native = written(40)
  const result = associateEncodedFrames(native, encodedFor(native, { delayMs: 150 }))
  const gate = encodeObservationGate(result)
  assert.equal(gate.status, 'failed')
  assert.ok(gate.measured.encodeDelayUpperP95Ms > ENCODE_OBSERVATION_BUDGET.encodeDelayUpperP95Ms)
})

test('output is bounded on a long run', () => {
  const native = written(5_000)
  const result = associateEncodedFrames(native, encodedFor(native))
  assert.equal(result.status, 'mapped')
  assert.equal(result.matched, 5_000)
  assert.equal(result.samples.length, ENCODE_ASSOCIATION_RULES.sampleLimit)
  assert.equal(result.samplesTruncated, true)
})

test('renderer observations flatten with their drain brackets and cumulative drops', () => {
  const observations = [
    {
      phase: 'encoded',
      generation: 4,
      dropped: 0,
      records: [{ rtpTimestamp: 10, atMs: 1, type: 'key' }],
      bracket: { timeOriginBracketMs: { lowMs: -0.2, highMs: 0.3 } }
    },
    { phase: 'encoded', generation: 5, dropped: 9, records: [{ rtpTimestamp: 1, atMs: 2 }] },
    {
      phase: 'encoded',
      generation: 4,
      dropped: 2,
      records: [{ rtpTimestamp: 3010, atMs: 34 }],
      bracket: {}
    },
    { phase: 'native-frame', generation: 4 }
  ]
  const { encoded, observerDropped } = encodedRecordsFromObservations(observations, 4)
  assert.equal(observerDropped, 2)
  assert.deepEqual(encoded, [
    { rtpTimestamp: 10, atMs: 1, type: 'key', offsetLowMs: -0.2, offsetHighMs: 0.3 },
    { rtpTimestamp: 3010, atMs: 34, type: null, offsetLowMs: null, offsetHighMs: null }
  ])
})
