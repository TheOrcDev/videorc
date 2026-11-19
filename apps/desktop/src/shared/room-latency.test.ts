import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  LATENCY_RELAY_MAX_BYTES,
  LATENCY_RELAY_MIN_INTERVAL_MS,
  LATENCY_SAMPLE_MS,
  LATENCY_TOPIC,
  LATENCY_TTL_MS,
  NET_BLOCK_VERSION,
  NET_IDENTITY_MAX_CHARS,
  NET_MAX_MS,
  NET_MAX_SENDERS,
  NET_MIN_WINDOW_MS,
  PAGE_DRAW_MS,
  PROGRAM_PAGE_IDENTITY_PREFIX,
  SEND_AUDIO_MS,
  NetSampler,
  SFU_MS,
  latencyFresh,
  netBlock,
  parseLatencyRelay,
  parseNetBlock,
  readNetStats,
  roomLatency,
  type HeldNetBlock,
  type NetStatsSource,
  type NetTrack,
  type RoomLatency
} from './room-latency'

// Plan 253 S1: the cases videorc-web checks too (its
// tests/room-latency.test.ts reads a byte copy of the same file), so the
// guest page, the program page and the host agree on every number.
type Fixture = {
  version: number
  topic: string
  constants: Record<string, number | string>
  blocks: { name: string; in: unknown; out: unknown }[]
  relays: { name: string; in: unknown; out: unknown }[]
  samples: {
    name: string
    windowMs: number
    before: NetStatsSource[] | null
    after: NetStatsSource[]
    block: unknown
  }[]
  room: {
    name: string
    nowMs: number
    host: HeldNetBlock | null
    reports: HeldNetBlock[]
    expect: RoomLatency
  }[]
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../../protocol-fixtures/room-latency.json', import.meta.url), 'utf8')
) as Fixture

describe('room latency (plan 253)', () => {
  it('holds the contract constants the fixture names', () => {
    expect(fixture.version).toBe(NET_BLOCK_VERSION)
    expect(fixture.topic).toBe(LATENCY_TOPIC)
    expect(fixture.constants).toEqual({
      sampleMs: LATENCY_SAMPLE_MS,
      relayMinIntervalMs: LATENCY_RELAY_MIN_INTERVAL_MS,
      ttlMs: LATENCY_TTL_MS,
      sendAudioMs: SEND_AUDIO_MS,
      sfuMs: SFU_MS,
      pageDrawMs: PAGE_DRAW_MS,
      maxMs: NET_MAX_MS,
      minWindowMs: NET_MIN_WINDOW_MS,
      maxSenders: NET_MAX_SENDERS,
      identityMaxChars: NET_IDENTITY_MAX_CHARS,
      relayMaxBytes: LATENCY_RELAY_MAX_BYTES,
      programPageIdentityPrefix: PROGRAM_PAGE_IDENTITY_PREFIX
    })
  })

  it('accepts and refuses every block case', () => {
    expect(fixture.blocks.length).toBeGreaterThanOrEqual(20)
    for (const { name, in: value, out } of fixture.blocks)
      expect(parseNetBlock(value), name).toEqual(out)
  })

  it('never hands back the object it was given', () => {
    const given = fixture.blocks[0]!.in as { from: unknown[] }
    const parsed = parseNetBlock(given)
    expect(parsed).not.toBe(given)
    expect(parsed?.from).not.toBe(given.from)
  })

  it('accepts and refuses every relay case', () => {
    for (const { name, in: value, out } of fixture.relays)
      expect(parseLatencyRelay(value), name).toEqual(out)
  })

  it('makes every sample case from deltas over the window', () => {
    for (const { name, windowMs, before, after, block } of fixture.samples)
      expect(
        netBlock(before ? readNetStats(before) : null, readNetStats(after), windowMs),
        name
      ).toEqual(block)
  })

  it('makes blocks its own parser accepts unchanged', () => {
    for (const { before, after, windowMs } of fixture.samples) {
      const block = netBlock(before ? readNetStats(before) : null, readNetStats(after), windowMs)
      if (block) expect(parseNetBlock(block)).toEqual(block)
    }
  })

  it('never reads a candidate: no address reaches a reading', () => {
    for (const { after } of fixture.samples)
      expect(JSON.stringify(readNetStats(after))).not.toMatch(/203\.0\.113|198\.51\.100/)
  })

  it('keeps the first eight senders', () => {
    const sources: NetStatsSource[] = Array.from({ length: 10 }, (_, index) => ({
      direction: 'in',
      identity: `g_${index}`,
      kind: 'audio',
      entries: [{ type: 'inbound-rtp', jitterBufferDelay: 1, jitterBufferEmittedCount: 48000 }]
    }))
    expect(Object.keys(readNetStats(sources).from)).toEqual(
      Array.from({ length: NET_MAX_SENDERS }, (_, index) => `g_${index}`)
    )
  })

  it('gives every room case its numbers: missing parts, partial and stale', () => {
    expect(fixture.room.length).toBeGreaterThanOrEqual(12)
    for (const { name, nowMs, host, reports, expect: expected } of fixture.room)
      expect(roomLatency({ nowMs, host, reports }), name).toEqual(expected)
  })

  it('holds a block for 25 s and not a millisecond more', () => {
    expect(latencyFresh(0, LATENCY_TTL_MS)).toBe(true)
    expect(latencyFresh(0, LATENCY_TTL_MS + 1)).toBe(false)
    expect(latencyFresh(1, 0)).toBe(false)
  })
})

/** Fixture sources as live tracks: each hands out its entries as a stats report. */
function tracksOf(sources: NetStatsSource[], calls?: { count: number }): NetTrack[] {
  return sources.map(({ entries, ...source }) => ({
    ...source,
    track: {
      getRTCStatsReport: async () => {
        if (calls) calls.count += 1
        return new Map(entries.map((entry, index) => [String(index), entry]))
      }
    }
  }))
}

describe('the sampler (plan 253)', () => {
  const chromium = fixture.samples[0]!

  it('makes no block first, then the fixture block from the time between two calls', async () => {
    let now = 5_000
    const sampler = new NetSampler(() => now)
    expect(await sampler.sample(tracksOf(chromium.before!))).toBeNull()
    now += chromium.windowMs
    expect(await sampler.sample(tracksOf(chromium.after))).toEqual(chromium.block)
  })

  it('reads each track once per sample', async () => {
    const calls = { count: 0 }
    const sampler = new NetSampler(() => 0)
    await sampler.sample(tracksOf(chromium.after, calls))
    expect(calls.count).toBe(chromium.after.length)
  })

  it('starts over after a reset', async () => {
    let now = 0
    const sampler = new NetSampler(() => now)
    await sampler.sample(tracksOf(chromium.before!))
    sampler.reset()
    now += chromium.windowMs
    expect(await sampler.sample(tracksOf(chromium.after))).toBeNull()
  })

  it('survives a track whose stats throw or are missing', async () => {
    let now = 0
    const sampler = new NetSampler(() => now)
    const broken: NetTrack[] = [
      { direction: 'in', identity: 'g_gone', kind: 'audio', track: {} },
      {
        direction: 'out',
        kind: 'video',
        track: { getRTCStatsReport: () => Promise.reject(new Error('closed')) }
      }
    ]
    await sampler.sample([...tracksOf(chromium.before!), ...broken])
    now += chromium.windowMs
    expect(await sampler.sample([...broken, ...tracksOf(chromium.after)])).toEqual(chromium.block)
  })

  it('gives no block for a window the page slept through, and measures the next one', async () => {
    let now = 0
    const sampler = new NetSampler(() => now)
    await sampler.sample(tracksOf(chromium.before!))
    now += 120_000
    expect(await sampler.sample(tracksOf(chromium.before!))).toBeNull()
    now += chromium.windowMs
    expect(await sampler.sample(tracksOf(chromium.after))).toEqual(chromium.block)
  })
})
