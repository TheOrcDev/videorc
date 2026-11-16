import assert from 'node:assert/strict'

/** Validates ffprobe packets from the actual retained TS files against the
 * manifest's media clock. This is not a measured flash/tone A/V p95 estimate. */
export function assertRingPacketClock(segments, probes) {
  assert.ok(segments.length > 0 && segments.length === probes.length)
  const lanes = { video: [], audio: [] }
  let videoOrigin
  const driftMs = []
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    for (const kind of ['video', 'audio']) {
      const packets = probes[i].packets.filter((p) => p.codec_type === kind)
      assert.ok(packets.length, `Segment ${segment.sequence}: missing ${kind}`)
      const times = packets.map((p) => ({
        start: Number(p.pts_time) * 1000,
        duration: Number(p.duration_time) * 1000
      }))
      for (const time of times)
        assert.ok(
          Number.isFinite(time.start) && Number.isFinite(time.duration) && time.duration > 0
        )
      if (kind === 'video') {
        assert.ok(packets[0].flags?.includes('K'), 'Segment must begin with keyframe')
        videoOrigin ??= times[0].start - segment.startMs
        const drift = times[0].start - (videoOrigin + segment.startMs)
        driftMs.push(drift)
        assert.ok(Math.abs(drift) <= 80, 'HLS manifest/program timestamp drift exceeds 80 ms')
        const duration = times.at(-1).start + times.at(-1).duration - times[0].start
        assert.ok(
          Math.abs(duration - segment.durationMs) <= 80,
          'Decoded segment duration disagrees with manifest'
        )
      }
      lanes[kind].push(...times)
    }
  }
  const gaps = {}
  for (const [kind, times] of Object.entries(lanes)) {
    gaps[kind] = 0
    for (let i = 1; i < times.length; i++) {
      const gap = times[i].start - (times[i - 1].start + times[i - 1].duration)
      assert.ok(gap >= -2, `${kind} packet clock moves backwards`)
      gaps[kind] = Math.max(gaps[kind], gap)
    }
    assert.ok(gaps[kind] <= (kind === 'audio' ? 20 : 100), `${kind} packet continuity gap`)
  }
  const edgeSkewMs = [
    lanes.video[0].start - lanes.audio[0].start,
    lanes.video.at(-1).start +
      lanes.video.at(-1).duration -
      (lanes.audio.at(-1).start + lanes.audio.at(-1).duration)
  ]
  assert.ok(
    edgeSkewMs.every((skew) => Math.abs(skew) <= 80),
    'A/V edge skew exceeds 80 ms'
  )
  return { driftMs, maxGapMs: gaps, edgeSkewMs, correlatedAvSyncP95Ms: null }
}
