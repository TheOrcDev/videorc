import assert from 'node:assert/strict'
/** Packet checks for the marked artifact, separate from provider qualification. */
export function assessClipPackets(probe, expectedMs) {
  const video = probe.packets.filter((p) => p.codec_type === 'video'),
    audio = probe.packets.filter((p) => p.codec_type === 'audio')
  assert.ok(video.length && audio.length, 'Program clip needs video and mixed audio')
  assert.ok(video[0].flags.includes('K'), 'First video packet must be independently decodable')
  const spans = {}
  for (const [kind, packets] of Object.entries({ video, audio })) {
    const times = packets.map((p) => ({
      pts: Number(p.pts_time),
      dts: Number(p.dts_time),
      duration: Number(p.duration_time)
    }))
    assert.ok(
      times.every((p) => Number.isFinite(p.pts) && Number.isFinite(p.dts) && p.duration > 0)
    )
    for (let i = 1; i < times.length; i++)
      assert.ok(times[i].dts >= times[i - 1].dts, `${kind}: backwards DTS`)
    const start = Math.min(...times.map((t) => t.pts)),
      end = Math.max(...times.map((t) => t.pts + t.duration))
    assert.ok(Math.abs(start) <= 0.05, `${kind}: trim did not reset timestamp`)
    assert.ok(Math.abs(end * 1000 - expectedMs) <= 100, `${kind}: incorrect trim duration`)
    spans[kind] = { start, end }
  }
  assert.ok(Math.abs(spans.video.end - spans.audio.end) <= 0.08, 'Clip A/V tail skew')
  return { spans, productionQualified: false, managedAcceptance: 'not-run' }
}
