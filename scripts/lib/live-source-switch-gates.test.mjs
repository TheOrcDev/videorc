import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluatePacketDts,
  evaluateSourceIdentity,
  measureSourceWindow
} from './live-source-switch-gates.mjs'

const tone = (frequency) =>
  Float32Array.from(
    { length: 48000 },
    (_, index) => 0.12 * Math.sin((index * frequency * 2 * Math.PI) / 48000)
  )

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
