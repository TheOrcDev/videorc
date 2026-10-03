import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluatePacketDts,
  evaluateSourceIdentity,
  measureSourceWindow,
  resolveSourceOutputAudioTiming,
  sourceSampleWindowStart
} from './live-source-switch-gates.mjs'

const tone = (frequency) =>
  Float32Array.from(
    { length: 48000 },
    (_, index) => 0.12 * Math.sin((index * frequency * 2 * Math.PI) / 48000)
  )

const owner = { sessionId: 'source-switch-session', outputProcessId: 42 }
const leg = (role, outputIndex, filterShiftMs) => ({
  role,
  outputIndex,
  inputOffsetMs: 0,
  filterShiftMs
})
const resolveTiming = (legs, role) =>
  resolveSourceOutputAudioTiming({ ...owner, legs }, { ...owner, role })

test('neutral copy fanout and advanced split map each leg from applied timing, not mode', () => {
  const sample = 119520
  assert.equal(
    sourceSampleWindowStart(sample, resolveTiming([leg('stream', 0, 0)], 'stream')),
    2.74
  )
  // The same combined mode can be neutral copy fanout or advanced split.
  for (const shift of [0, -130]) {
    const combined = [leg('local', 0, 0), leg('stream', 1, shift)]
    assert.equal(sourceSampleWindowStart(sample, resolveTiming(combined, 'local')), 2.74)
    assert.equal(
      sourceSampleWindowStart(sample, resolveTiming(combined, 'stream')),
      sample / 48000 + shift / 1000 + 0.25
    )
  }
})

test('neutral mapping excludes the transition tail without relaxing the silence gate', () => {
  const samples = Float32Array.from({ length: 4 * 48000 }, (_, index) =>
    index / 48000 < 2.66 ? 0.12 * Math.sin((index * 440 * 2 * Math.PI) / 48000) : 0
  )
  const sample = 119520
  const blindStreamAdvance = measureSourceWindow(samples, {
    startSeconds: sample / 48000 - 0.13 + 0.25
  })
  assert.deepEqual(evaluateSourceIdentity(blindStreamAdvance, null), [
    'Intentional silence contains audible source PCM.'
  ])
  const timing = resolveTiming([leg('stream', 0, 0)], 'stream')
  const corrected = measureSourceWindow(samples, {
    startSeconds: sourceSampleWindowStart(sample, timing)
  })
  assert.equal(corrected.durationSeconds, 0.5)
  assert.equal(corrected.rms, 0)
  assert.deepEqual(evaluateSourceIdentity(corrected, null), [])
  assert.deepEqual(
    evaluateSourceIdentity({ rms: 0.00501, amplitude440: 0, amplitude880: 0 }, null),
    ['Intentional silence contains audible source PCM.']
  )
})

test('applied offsets include clamped trims and delays, with no speculative input-offset sum', () => {
  for (const shift of [-1000, -950, 200, 1000]) {
    const timing = resolveTiming([leg('local', 0, shift)], 'local')
    assert.equal(sourceSampleWindowStart(96000, timing), 2 + shift / 1000 + 0.25)
  }
  assert.throws(() => resolveTiming([{ ...leg('local', 0, 0), inputOffsetMs: 80 }], 'local'))
  assert.throws(() => sourceSampleWindowStart(96000, { inputOffsetMs: 80, filterShiftMs: -130 }))
})

test('missing, ambiguous, oversized, or malformed timing is unavailable evidence', () => {
  const valid = { ...owner, legs: [leg('stream', 0, 0)] }
  for (const evidence of [
    undefined,
    { ...valid, legs: [] },
    { ...valid, legs: [leg('local', 0, 0)] },
    { ...valid, legs: [leg('stream', 0, 0), leg('stream', 1, -130)] },
    { ...valid, legs: [leg('local', 0, 0), leg('stream', 0, 0)] },
    { ...valid, legs: Array.from({ length: 9 }, (_, index) => leg('stream', index, 0)) },
    { ...valid, legs: [{ ...leg('stream', 0, 0), filterShiftMs: NaN }] },
    { ...valid, legs: [{ ...leg('stream', 0, 0), filterShiftMs: -1001 }] },
    { ...valid, legs: [{ ...leg('stream', 0, 0), outputIndex: 1 }] },
    { ...valid, legs: [{ ...leg('stream', 0, 0), role: 'received' }] },
    { ...valid, args: ['arbitrary payload'] }
  ]) {
    assert.throws(
      () => resolveSourceOutputAudioTiming(evidence, { ...owner, role: 'stream' }),
      /owned output audio timing/
    )
  }
  for (const sample of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => sourceSampleWindowStart(sample, leg('stream', 0, 0)), /sample boundary/)
})

test('timing cannot be adopted from another session or output process', () => {
  const evidence = { ...owner, legs: [leg('stream', 0, 0)] }
  for (const expected of [
    { ...owner, sessionId: 'replacement' },
    { ...owner, outputProcessId: 43 },
    { ...owner, outputProcessId: 0 },
    { ...owner, outputProcessId: 0x100000000 }
  ])
    assert.throws(() => resolveSourceOutputAudioTiming(evidence, { ...expected, role: 'stream' }))
})

test('decoded windows distinguish two actual source markers and intentional silence', () => {
  for (const frequency of [440, 880]) {
    const measurement = measureSourceWindow(tone(frequency), { startSeconds: 0.2 })
    assert.deepEqual(evaluateSourceIdentity(measurement, frequency), [])
    assert.ok(evaluateSourceIdentity(measurement, frequency === 440 ? 880 : 440).length > 0)
    assert.ok(evaluateSourceIdentity(measurement, null).length > 0)
  }
  assert.deepEqual(
    evaluateSourceIdentity(
      measureSourceWindow(new Float32Array(48000), { startSeconds: 0.2 }),
      null
    ),
    []
  )
})

test('missing, truncated, and malformed source measurements fail closed', () => {
  assert.ok(evaluateSourceIdentity(undefined, 440).length > 0)
  assert.throws(() => measureSourceWindow(tone(440), { startSeconds: 0.8 }), /missing/)
  const samples = tone(440)
  samples[100] = NaN
  assert.throws(() => measureSourceWindow(samples, { startSeconds: 0 }), /non-finite/)
})

test('packet DTS is monotonic per stream while legal B-frame PTS reorder is accepted', () => {
  const packets = [
    { stream_index: 0, dts_time: '-0.03', pts_time: '0.03' },
    { stream_index: 1, dts_time: '0' },
    { stream_index: 0, dts_time: '0', pts_time: '0' }
  ]
  assert.deepEqual(evaluatePacketDts(packets), [])
  assert.ok(evaluatePacketDts([...packets, { stream_index: 0, dts_time: '-0.1' }]).length > 0)
  assert.ok(evaluatePacketDts([{ stream_index: 0 }]).length > 0)
  assert.ok(evaluatePacketDts([]).length > 0)
})
