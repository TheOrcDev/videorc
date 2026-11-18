import test from 'node:test'
import assert from 'node:assert/strict'
import { assessClipPackets } from './cloud-parity-clips-contract.mjs'
const probe = () => ({
  packets: ['video', 'audio'].flatMap((codec_type) =>
    Array.from({ length: 30 }, (_, i) => ({
      codec_type,
      pts_time: String(i / 30),
      dts_time: String(i / 30),
      duration_time: String(1 / 30),
      flags: i === 0 ? 'K_' : '__'
    }))
  )
})
test('bounded packet fixture keeps independent head and AV duration; never managed proof', () => {
  assert.equal(assessClipPackets(probe(), 1000).productionQualified, false)
})
test('rejects missing audio, nonkeyframe, late trim and backwards DTS', () => {
  for (const mutate of [
    (p) => {
      p.packets = p.packets.filter((s) => s.codec_type === 'video')
    },
    (p) => {
      p.packets[0].flags = '__'
    },
    (p) => {
      p.packets[0].pts_time = '-1'
    },
    (p) => {
      p.packets[1].dts_time = '-1'
    }
  ]) {
    const p = probe()
    mutate(p)
    assert.throws(() => assessClipPackets(p, 1000))
  }
})
