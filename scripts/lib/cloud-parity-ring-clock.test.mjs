import test from 'node:test'
import assert from 'node:assert/strict'
import { assertRingPacketClock } from './cloud-parity-ring-clock.mjs'

const segments = [0, 1].map((sequence) => ({
  sequence,
  startMs: sequence * 2000,
  durationMs: 2000
}))
const probes = () =>
  segments.map((s) => ({
    packets: Array.from({ length: 50 }, (_, i) =>
      ['video', 'audio'].map((codec_type) => ({
        codec_type,
        pts_time: String(1.4 + s.startMs / 1000 + i * 0.04),
        duration_time: '0.04',
        flags: i === 0 ? 'K_' : '__'
      }))
    ).flat()
  }))
test('packet clock maps real-probe shape to manifest without claiming correlated p95', () => {
  const result = assertRingPacketClock(segments, probes())
  assert.ok(result.driftMs.every((v) => Math.abs(v) < 0.001))
  assert.equal(result.correlatedAvSyncP95Ms, null)
})
test('missing keyframe, audio gap, wrong manifest and reset timestamps fail', () => {
  const noKey = probes()
  noKey[1].packets[0].flags = '__'
  assert.throws(() => assertRingPacketClock(segments, noKey), /keyframe/)
  const gap = probes()
  gap[0].packets.splice(3, 1)
  assert.throws(() => assertRingPacketClock(segments, gap), /continuity/)
  assert.throws(
    () => assertRingPacketClock([{ ...segments[0], durationMs: 1800 }, segments[1]], probes()),
    /duration/
  )
  const reset = probes()
  reset[1] = reset[0]
  assert.throws(() => assertRingPacketClock(segments, reset), /drift/)
})
