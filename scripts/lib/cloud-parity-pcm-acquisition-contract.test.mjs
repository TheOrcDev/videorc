import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pcmAcquisitionConfig,
  drivePcmCapture,
  pcmWithDeadline,
  pcmRemaining,
  pcmMicrophonePublication,
  clockBracket,
  mapClock,
  derivePcmClocks
} from './cloud-parity-pcm-acquisition-contract.mjs'
import {
  fixtureSample,
  decodeMarker,
  PcmMarkerDecoder,
  PCM_MARKER
} from './cloud-parity-pcm-marker.mjs'

test('configuration bounds duration, cycles and explicit acquisition modes', () => {
  assert.equal(pcmAcquisitionConfig().durationMs, 1805000)
  assert.equal(pcmAcquisitionConfig().cycles, 25)
  for (const env of [
    { VIDEORC_PCM_SECONDS: 'Infinity' },
    { VIDEORC_PCM_SECONDS: '3501' },
    { VIDEORC_PCM_CYCLES: '0' },
    { VIDEORC_PCM_MODE: 'pretend' }
  ])
    assert.throws(() => pcmAcquisitionConfig(env))
  assert.equal(
    pcmAcquisitionConfig({ VIDEORC_PCM_MODE: 'acquire', VIDEORC_PCM_SECONDS: '5' }).mode,
    'acquire'
  )
})
test('capture loop uses measured duration and always finalizes after a polling error', async () => {
  let now = 0
  const calls = []
  const io = {
    now: () => now,
    wait: async (ms) => {
      now += ms
    },
    start: async () => 'active',
    poll: async () => now,
    stop: async () => {
      calls.push('closed')
      return 'inactive'
    },
    record: async (kind, value) => calls.push([kind, value])
  }
  await drivePcmCapture({ durationMs: 1000, pollMs: 400 }, io)
  assert.deepEqual(
    calls.filter((c) => c[0] === 'sample').map((c) => c[1]),
    [0, 400, 800, 1000]
  )
  assert.equal(calls.at(-1)[0], 'stop')
  await assert.rejects(
    drivePcmCapture(
      { durationMs: 1000, pollMs: 400 },
      {
        ...io,
        poll: async () => {
          throw new Error('observation failed')
        }
      }
    ),
    /observation failed/
  )
  assert.equal(calls.at(-1)[0], 'stop')
})
test('cleanup derives counts from all owners and refuses missing or failed observations', () => {
  const main = { nativeSources: 0, sockets: 0, ipcRequests: 0, timers: 0 }
  assert.equal(pcmRemaining(null, { owners: [] }, []).status, 'unavailable')
  assert.equal(pcmRemaining(main, null, []).status, 'unavailable')
  const owner = { worklets: 0, contexts: 0, tracks: 1, timers: 0, ipcRequests: 0, closeError: null }
  assert.equal(pcmRemaining(main, { owners: [owner] }, []).remaining.tracks, 1)
  assert.equal(pcmRemaining(main, { owners: [owner] }, []).status, 'live')
  assert.equal(
    pcmRemaining(main, { owners: [{ ...owner, closeError: 'unacknowledged' }] }, []).status,
    'unavailable'
  )
  assert.equal(pcmRemaining(main, { owners: [] }, [{ sid: 'TR_real' }]).status, 'live')
  assert.equal(pcmRemaining(main, { owners: [] }, []).status, 'closed')
})
test('clock mapping preserves measured round-trip uncertainty and refuses extrapolation', () => {
  const anchors = [clockBracket(100, 120, 0), clockBracket(1100, 1140, 1000)]
  assert.deepEqual(mapClock(500, anchors), { lowUs: 600, highUs: 630 })
  assert.equal(mapClock(-1, anchors), null)
  assert.equal(mapClock(1001, anchors), null)
  assert.equal(mapClock(500, [anchors[0], clockBracket(3e6, 3e6 + 1, 3e6)]), null)
  assert.throws(() => clockBracket(2, 1, 0))
  const empty = derivePcmClocks([])
  assert.deepEqual(empty.samples, [])
  assert.equal(empty.generation, null)
})
test('native marker identities survive chunk boundaries and modest deterministic noise', () => {
  for (const second of [0, 1, 15, 253, 1799, 3599]) {
    const samples = Float32Array.from(
      { length: 48000 },
      (_, i) => fixtureSample(second * 48000 + i) + Math.sin(i * 1.913) * 0.002
    )
    assert.equal(decodeMarker(samples), second)
    const decoder = new PcmMarkerDecoder(),
      found = []
    for (let i = 0; i < samples.length; i += 127)
      decoder.push(samples.subarray(i, i + 127), i, (marker) => found.push(marker))
    assert.equal(found.length, 1)
    assert.equal(found[0].second, second)
    assert.equal(found[0].audioFrame, 0)
    assert.equal(found[0].uncertaintyFrames, PCM_MARKER.uncertaintyFrames)
  }
  assert.equal(decodeMarker(new Float32Array(PCM_MARKER.markerFrames)), null)
})

test('derives native/worklet/program intervals only from matching measured marker and clock events', () => {
  const records = []
  for (const t of [0, 1000, 2000]) {
    records.push({
      kind: 'renderer',
      beforeUs: 1e9 + t * 1000,
      afterUs: 1e9 + t * 1000 + 2000,
      reply: {
        performanceMs: t,
        dropped: 0,
        events: [
          {
            phase: 'native-frame',
            generation: 7,
            pullRequestedAtMs: t,
            pullReceivedAtMs: t + 1,
            observedAtUs: t * 1000
          },
          {
            phase: 'worklet',
            clock: { requestedAtMs: t + 20, frame: t * 48 },
            receivedAtMs: t + 21,
            lostMarkers: 0,
            ...(t === 1000
              ? { marker: { second: 1, workletFrame: 48000, captureSample: 48000 } }
              : {})
          }
        ]
      }
    })
    records.push({
      kind: 'program',
      beforeUs: 1e9 + t * 1000,
      afterUs: 1e9 + t * 1000 + 2000,
      reply: {
        performanceMs: t,
        dropped: 0,
        events: [
          {
            clock: { requestedAtMs: t + 100, frame: t * 48 },
            receivedAtMs: t + 101,
            dropped: 0,
            events: t === 1000 ? [{ second: 1, audioFrame: 48000, uncertaintyFrames: 480 }] : []
          }
        ]
      }
    })
  }
  const result = derivePcmClocks(records)
  assert.equal(result.samples.length, 1)
  const sample = result.samples[0]
  assert.equal(sample.generation, 7)
  assert.ok(sample.capture.highUs >= sample.capture.lowUs)
  assert.ok(sample.program.highUs - sample.capture.lowUs > 100000)
  assert.ok(sample.program.highUs - sample.capture.lowUs < 130000)
  // Removing the real source marker is unavailable, not a fabricated timestamp.
  for (const r of records.filter((r) => r.kind === 'renderer'))
    for (const e of r.reply.events) delete e.marker
  const missing = derivePcmClocks(records)
  assert.equal(missing.samples.length, 0)
  assert.equal(missing.unavailable.filter((u) => u.second === 1).length, 1)
})

/** One marker at second 1 with three native-frame observations carrying `clock`. */
function clockRecords(clockAt = () => ({})) {
  const records = []
  for (const t of [0, 1000, 2000]) {
    const bracket = { beforeUs: 1e9 + t * 1000, afterUs: 1e9 + t * 1000 + 2000 }
    records.push({
      kind: 'renderer',
      ...bracket,
      reply: {
        performanceMs: t,
        dropped: 0,
        events: [
          {
            phase: 'native-frame',
            generation: 7,
            pullRequestedAtMs: t,
            pullReceivedAtMs: t + 1,
            observedAtUs: t * 1000,
            ...clockAt(t)
          },
          {
            phase: 'worklet',
            clock: { requestedAtMs: t + 20, frame: t * 48 },
            receivedAtMs: t + 21,
            ...(t === 1000 ? { marker: { second: 1, workletFrame: 48000 } } : {})
          }
        ]
      }
    })
    records.push({
      kind: 'program',
      ...bracket,
      reply: {
        performanceMs: t,
        dropped: 0,
        events: [
          {
            clock: { requestedAtMs: t + 100, frame: t * 48 },
            receivedAtMs: t + 101,
            events: t === 1000 ? [{ second: 1, audioFrame: 48000, uncertaintyFrames: 480 }] : []
          }
        ]
      }
    })
  }
  return records
}

test('a null native origin stays unavailable and is never manufactured as zero', () => {
  for (const clock of [
    {},
    { originUs: null, incarnation: null },
    { originUs: null, incarnation: 3 }
  ]) {
    const result = derivePcmClocks(clockRecords(() => clock))
    assert.equal(result.origin, null)
    assert.equal(result.samples.length, 1)
    assert.equal(result.samples[0].nativeUs, null)
    assert.equal(result.samples[0].incarnation, null)
    assert.deepEqual(
      result.unavailable.filter((u) => u.measurement === 'commonClockOrigin').length,
      1
    )
  }
})

test('a present native origin maps each sample to origin + native position', () => {
  const result = derivePcmClocks(
    clockRecords(() => ({ originUs: 5_000_000, incarnation: 42, timeline: 'synthetic' }))
  )
  assert.deepEqual(result.origin, { originUs: 5_000_000, incarnation: 42, timeline: 'synthetic' })
  assert.equal(result.samples[0].nativeUs, 6_000_000)
  assert.equal(result.samples[0].incarnation, 42)
  assert.equal(result.unavailable.length, 0)
})

test('mixed incarnations, moving origins and invalid origins within one capture are refused', () => {
  assert.throws(
    () =>
      derivePcmClocks(
        clockRecords((t) => ({ originUs: 5_000_000, incarnation: t === 2000 ? 43 : 42 }))
      ),
    /multiple native clock incarnations/
  )
  assert.throws(
    () => derivePcmClocks(clockRecords((t) => ({ originUs: 5_000_000 + t, incarnation: 42 }))),
    /multiple native clock origins/
  )
  assert.throws(
    () =>
      derivePcmClocks(
        clockRecords((t) => (t === 2000 ? { originUs: 5_000_000, incarnation: 42 } : {}))
      ),
    /multiple native clock incarnations/
  )
  for (const clock of [
    { originUs: 5, incarnation: null },
    { originUs: 5, incarnation: 0 },
    { originUs: -1, incarnation: 42 },
    { originUs: 1.5, incarnation: 42 }
  ])
    assert.throws(() => derivePcmClocks(clockRecords(() => clock)))
})

test('an origin whose sum with native time is unsafe is refused, never wrapped', () => {
  // The last observation is at 2 s: origin + observedAtUs crosses MAX_SAFE_INTEGER.
  assert.throws(
    () =>
      derivePcmClocks(
        clockRecords(() => ({ originUs: Number.MAX_SAFE_INTEGER - 1_500_000, incarnation: 42 }))
      ),
    /safe integer range/
  )
  // A sum that lands exactly on MAX_SAFE_INTEGER is still exact and accepted.
  const result = derivePcmClocks(
    clockRecords(() => ({ originUs: Number.MAX_SAFE_INTEGER - 2_000_000, incarnation: 42 }))
  )
  assert.equal(result.samples.length, 1)
  assert.equal(result.samples[0].nativeUs, Number.MAX_SAFE_INTEGER - 1_000_000)
})

test('publication readiness uses actual microphone SID and protobuf default mute semantics', () => {
  const track = { sid: 'TR_actual', source: 'MICROPHONE' }
  assert.equal(pcmMicrophonePublication({ tracks: [track] }), track)
  assert.equal(pcmMicrophonePublication({ tracks: [{ ...track, muted: true }] }), null)
  assert.equal(pcmMicrophonePublication({}), null)
  assert.equal(pcmMicrophonePublication({ tracks: [{ ...track, source: 'CAMERA' }] }), null)
  assert.throws(() => pcmMicrophonePublication({ tracks: [track, track] }), /Duplicate/)
  assert.throws(() => pcmMicrophonePublication(null), /Missing/)
  assert.throws(() => pcmMicrophonePublication({ tracks: [{ source: 2 }] }))
})

test('external observation deadlines fail unavailable and clear owned timers deterministically', async () => {
  let expire,
    cleared = 0
  const timers = {
    setTimeout(callback, ms) {
      assert.equal(ms, 1000)
      expire = callback
      return 7
    },
    clearTimeout(id) {
      assert.equal(id, 7)
      cleared++
    }
  }
  assert.equal(await pcmWithDeadline('Probe', 1000, () => 42, timers), 42)
  const pending = pcmWithDeadline('Probe', 1000, () => new Promise(() => {}), timers)
  expire()
  await assert.rejects(pending, /Probe unavailable: deadline exceeded/)
  assert.equal(cleared, 2)
})
