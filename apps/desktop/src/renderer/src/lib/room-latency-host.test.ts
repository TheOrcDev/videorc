import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { RoomLatencyHost, type RoomLatencySource } from './room-latency-host'
import {
  LATENCY_SAMPLE_MS,
  LATENCY_TTL_MS,
  type NetBlock,
  type NetStatsSource,
  type NetTrack,
  type RoomLatency
} from '../../../shared/room-latency'

// Plan 253 S4: the host's side, on a fake stats report and a fake clock. The
// numbers are the shared fixture's (protocol-fixtures/room-latency.json):
// its first room case is rebuilt here from live parts, the host's block
// sampled from stats and the others relayed, and must come out the same.

type Fixture = {
  samples: {
    windowMs: number
    before: NetStatsSource[]
    after: NetStatsSource[]
    block: NetBlock
  }[]
  room: {
    host: { identity: string; block: NetBlock }
    reports: { identity: string; block: NetBlock }[]
    expect: RoomLatency
  }[]
}
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../../../protocol-fixtures/room-latency.json', import.meta.url),
    'utf8'
  )
) as Fixture
const everyone = fixture.room[0]!
const HOST = everyone.host.identity
const [ADA, BO, PAGE] = everyone.reports.map((report) => report.identity) as [
  string,
  string,
  string
]

/**
 * A stats report whose deltas over 10 s give exactly `block`: the inverse
 * of the sampler's arithmetic, at 48 kHz and 30 fps.
 */
function statsFor(block: NetBlock, step: number): NetTrack[] {
  const samples = 480_000 * step
  const frames = 300 * step
  const report = (entries: Record<string, unknown>[]) => ({
    getRTCStatsReport: async () => new Map(entries.map((entry, index) => [String(index), entry]))
  })
  const pair = [
    { type: 'transport', selectedCandidatePairId: 'CP1' },
    {
      type: 'candidate-pair',
      id: 'CP1',
      nominated: true,
      state: 'succeeded',
      currentRoundTripTime: (block.rttMs ?? 0) / 1000
    },
    { type: 'local-candidate', id: 'L1', address: '203.0.113.7' }
  ]
  const tracks: NetTrack[] = []
  for (const sender of block.from ?? []) {
    if (sender.audioMs !== undefined)
      tracks.push({
        direction: 'in',
        identity: sender.identity,
        kind: 'audio',
        track: report([
          ...pair,
          {
            type: 'inbound-rtp',
            jitterBufferDelay: (sender.audioMs / 1000) * samples,
            jitterBufferEmittedCount: samples
          },
          ...(block.playoutMs === undefined
            ? []
            : [
                {
                  type: 'media-playout',
                  totalPlayoutDelay: (block.playoutMs / 1000) * samples,
                  totalSamplesCount: samples
                }
              ])
        ])
      })
    if (sender.videoMs !== undefined)
      tracks.push({
        direction: 'in',
        identity: sender.identity,
        kind: 'video',
        track: report([
          {
            type: 'inbound-rtp',
            totalProcessingDelay: (sender.videoMs / 1000) * frames,
            framesDecoded: frames
          }
        ])
      })
  }
  if (block.send?.videoMs !== undefined)
    tracks.push({
      direction: 'out',
      kind: 'video',
      track: report([
        {
          type: 'outbound-rtp',
          // Half a frame at 50 fps is 10 ms; the rest is encode time.
          totalEncodeTime: ((block.send.videoMs - 10) / 1000) * frames,
          framesEncoded: frames,
          totalPacketSendDelay: 0,
          packetsSent: frames,
          framesPerSecond: 50
        }
      ])
    })
  return tracks
}

function harness(options: { enabled?: boolean } = {}) {
  let now = 1_000
  let nextHandle = 1
  const timers = new Map<number, { at: number; every: number | null; run: () => void }>()
  let enabled = options.enabled ?? true
  let changes = 0
  let step = 1
  let hostBlock = everyone.host.block
  let hostIdentity: string | null = HOST
  const present = new Set([ADA, BO, PAGE])
  let trackReads = 0
  const source: RoomLatencySource = {
    hostIdentity: () => hostIdentity,
    present: (identity) => present.has(identity),
    tracks: () => {
      trackReads += 1
      return statsFor(hostBlock, step)
    }
  }
  const latency = new RoomLatencyHost({
    changed: () => {
      changes += 1
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
    enabled: () => enabled,
    now: () => now,
    setInterval: (run, every) => {
      timers.set(nextHandle, { at: now + every, every, run })
      return nextHandle++
    },
    setTimeout: (run, after) => {
      timers.set(nextHandle, { at: now + after, every: null, run })
      return nextHandle++
    }
  })
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
  }
  return {
    latency,
    present,
    source,
    timers,
    settle,
    get changes() {
      return changes
    },
    get trackReads() {
      return trackReads
    },
    setEnabled(next: boolean) {
      enabled = next
    },
    setHostBlock(block: NetBlock) {
      hostBlock = block
    },
    setHostIdentity(identity: string | null) {
      hostIdentity = identity
    },
    /** Moves the clock, firing each timer at its own time. */
    async advance(ms: number): Promise<void> {
      const end = now + ms
      for (;;) {
        await settle()
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [handle, timer] = due
        now = Math.max(now, timer.at)
        if (timer.every === null) timers.delete(handle)
        else timer.at += timer.every
        // The stats the next sample reads are one more window along.
        if (timer.every !== null) step += 1
        timer.run()
      }
      now = end
      await settle()
    },
    relay(identity: string, net: unknown, extra: Record<string, unknown> = {}) {
      latency.received(
        new TextEncoder().encode(
          JSON.stringify({ v: 1, identity, at: 1_794_000_000_123, net, ...extra })
        )
      )
    }
  }
}

const blockOf = (identity: string): NetBlock =>
  everyone.reports.find((report) => report.identity === identity)!.block

describe('the host measures (plan 253 S4)', () => {
  it('samples its own stats into the fixture block: the numbers match the fixture', async () => {
    const h = harness()
    h.latency.start(h.source)
    await h.settle()
    // One reading holds only session totals: no number yet.
    expect(h.latency.current).toEqual({ people: {} })
    h.relay(ADA, blockOf(ADA))
    h.relay(BO, blockOf(BO))
    h.relay(PAGE, blockOf(PAGE))
    expect(h.latency.current).toEqual({ people: {} })
    // The second reading, 10 s on: the host's block exists, and with it
    // every number of the fixture's "everyone reports" case.
    await h.advance(LATENCY_SAMPLE_MS)
    expect(h.latency.current).toEqual(everyone.expect)
    expect(h.latency.current.people[ADA]).toEqual({
      ms: 161,
      partial: false,
      toGuestMs: 160,
      fromGuestMs: 161,
      video: { toGuestMs: 150, fromGuestMs: 142 }
    })
    expect(h.latency.current.program).toEqual({ ms: 112, audioMs: 109 })
    expect(h.latency.current.hostRttMs).toBe(30)
  })

  it('one sample per 10 s, and no sooner whatever arrives', async () => {
    const h = harness()
    h.latency.start(h.source)
    await h.settle()
    expect(h.trackReads).toBe(1)
    for (let index = 0; index < 5; index += 1) h.relay(ADA, blockOf(ADA))
    await h.advance(LATENCY_SAMPLE_MS - 1)
    expect(h.trackReads).toBe(1)
    await h.advance(1)
    expect(h.trackReads).toBe(2)
    await h.advance(3 * LATENCY_SAMPLE_MS)
    expect(h.trackReads).toBe(5)
  })

  it('no report means no number', async () => {
    const h = harness()
    h.latency.start(h.source)
    await h.advance(LATENCY_SAMPLE_MS)
    // The host's own sample alone: its round trip, and nobody's delay.
    expect(h.latency.current).toEqual({ hostRttMs: 30, people: {} })
    h.relay(BO, blockOf(BO))
    expect(Object.keys(h.latency.current.people)).toEqual([BO])
    expect(h.latency.current.program).toBeUndefined()
  })

  it('a stale report disappears at 25 s, on its own, and comes back with the next one', async () => {
    const h = harness()
    h.latency.start(h.source)
    await h.advance(LATENCY_SAMPLE_MS)
    h.relay(ADA, blockOf(ADA))
    h.relay(PAGE, blockOf(PAGE))
    expect(h.latency.current.people[ADA]?.ms).toBe(161)
    expect(h.latency.current.program?.ms).toBe(112)
    const changes = h.changes
    // Still there at 25 s to the millisecond.
    await h.advance(LATENCY_TTL_MS)
    expect(h.latency.current.people[ADA]?.ms).toBe(161)
    // Gone just after, with no relay and no click to prompt it.
    await h.advance(2)
    expect(h.latency.current).toEqual({ hostRttMs: 30, people: {} })
    expect(h.changes).toBeGreaterThan(changes)
    h.relay(ADA, blockOf(ADA))
    expect(h.latency.current.people[ADA]?.ms).toBe(161)
  })

  it("the host's own sample going stale takes every number with it", async () => {
    const h = harness()
    h.latency.start(h.source)
    await h.advance(LATENCY_SAMPLE_MS)
    h.relay(ADA, blockOf(ADA))
    expect(h.latency.current.people[ADA]).toBeDefined()
    // The host's stats stop answering. Guests keep reporting.
    h.source.tracks = () => {
      throw new Error('the room is gone')
    }
    await h.advance(LATENCY_SAMPLE_MS)
    h.relay(ADA, blockOf(ADA))
    await h.advance(LATENCY_SAMPLE_MS)
    h.relay(ADA, blockOf(ADA))
    // 20 s on, the host's last block still stands.
    expect(h.latency.current.people[ADA]?.ms).toBe(161)
    await h.advance(LATENCY_SAMPLE_MS)
    h.relay(ADA, blockOf(ADA))
    // 30 s on it is too old, and a fresh guest report is not enough.
    expect(h.latency.current).toEqual({ people: {} })
  })

  it('ages a report from its arrival here, never from the time the web stamped', async () => {
    const h = harness()
    h.latency.start(h.source)
    await h.advance(LATENCY_SAMPLE_MS)
    // A stamp from years away in either direction changes nothing (D1).
    h.relay(ADA, blockOf(ADA), { at: 1 })
    expect(h.latency.current.people[ADA]?.ms).toBe(161)
    h.relay(ADA, blockOf(ADA), { at: 9_999_999_999_999 })
    expect(h.latency.current.people[ADA]?.ms).toBe(161)
  })

  it('drops what is malformed, too long, from the host itself or from someone not in the room', async () => {
    const h = harness()
    h.latency.start(h.source)
    await h.advance(LATENCY_SAMPLE_MS)
    h.relay(ADA, { v: 1, windowMs: 10_000, rttMs: -4 })
    h.relay(ADA, { v: 2, windowMs: 10_000 })
    h.latency.received(new TextEncoder().encode('not json'))
    h.latency.received(new Uint8Array(5000))
    h.relay(HOST, blockOf(ADA))
    h.relay('g_Stranger000000000000000', blockOf(ADA))
    expect(h.latency.current).toEqual({ hostRttMs: 30, people: {} })
    // Someone who leaves takes their number along, at once.
    h.relay(ADA, blockOf(ADA))
    expect(h.latency.current.people[ADA]).toBeDefined()
    h.present.delete(ADA)
    h.latency.left(ADA)
    expect(h.latency.current.people[ADA]).toBeUndefined()
  })

  it('a node show measures nothing: no timer, no sample, no number (D10)', async () => {
    const h = harness({ enabled: false })
    h.latency.start(h.source)
    await h.settle()
    expect(h.timers.size).toBe(0)
    h.relay(ADA, blockOf(ADA))
    await h.advance(3 * LATENCY_SAMPLE_MS)
    expect(h.trackReads).toBe(0)
    expect(h.timers.size).toBe(0)
    expect(h.latency.current).toEqual({ people: {} })
    expect(h.changes).toBe(0)
  })

  it("starts at the first relay when the show's status came after the room", async () => {
    const h = harness({ enabled: false })
    h.latency.start(h.source)
    await h.settle()
    h.setEnabled(true)
    h.relay(ADA, blockOf(ADA))
    await h.advance(LATENCY_SAMPLE_MS)
    expect(h.latency.current.people[ADA]?.ms).toBe(161)
  })

  it('a reconnect starts the sampler over and keeps the reports; stop forgets everything', async () => {
    const h = harness()
    h.latency.start(h.source)
    await h.advance(LATENCY_SAMPLE_MS)
    h.relay(ADA, blockOf(ADA))
    h.latency.reconnected()
    // The next reading has nothing to subtract from: the earlier block
    // stands until it ages out, and the one after measures again.
    await h.advance(LATENCY_SAMPLE_MS)
    expect(h.latency.current.people[ADA]?.ms).toBe(161)
    await h.advance(LATENCY_SAMPLE_MS)
    h.relay(ADA, blockOf(ADA))
    expect(h.latency.current.people[ADA]?.ms).toBe(161)
    h.latency.stop()
    expect(h.latency.current).toEqual({ people: {} })
    expect(h.timers.size).toBe(0)
    h.relay(ADA, blockOf(ADA))
    expect(h.latency.current).toEqual({ people: {} })
  })

  it('out of the room nothing is kept', async () => {
    const h = harness()
    h.latency.start(h.source)
    await h.advance(LATENCY_SAMPLE_MS)
    h.relay(ADA, blockOf(ADA))
    h.setHostIdentity(null)
    await h.advance(LATENCY_SAMPLE_MS)
    expect(h.latency.current).toEqual({ people: {} })
  })

  it('reads no candidate: no address reaches the numbers', async () => {
    const h = harness()
    h.latency.start(h.source)
    await h.advance(LATENCY_SAMPLE_MS)
    h.relay(ADA, blockOf(ADA))
    expect(JSON.stringify(h.latency.current)).not.toMatch(/203\.0\.113|address/)
  })
})
