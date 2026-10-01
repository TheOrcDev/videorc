import { describe, expect, it } from 'vitest'

import type { MeterFrame } from './audio/types'
import { createMicMeterSource, writeMicMeterLevel, type MicFrameFeed } from './mic-frame-sources'
import { createMicVisualFrameBuffer, type MicVisualFrameBuffer } from './mic-visual-frame'

type FakeFeed = MicFrameFeed & {
  retains: number
  releases: number
  publish: () => void
  frame: Partial<MicVisualFrameBuffer>
}

/** A stand-in for the visual mic pipeline: frames are pushed by hand. */
function fakeFeed(frame: Partial<MicVisualFrameBuffer> = {}): FakeFeed {
  const listeners = new Set<() => void>()
  const feed: FakeFeed = {
    retains: 0,
    releases: 0,
    frame,
    retain: () => {
      feed.retains += 1
      return () => {
        feed.releases += 1
      }
    },
    subscribeFrame: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    readFrame: (target) => Object.assign(target, feed.frame),
    publish: () => {
      for (const listener of listeners) listener()
    }
  }
  return feed
}

const speech = { peakDb: -12, peakDbfs: -12, rmsDbfs: -20 }

describe('writeMicMeterLevel (plan 092)', () => {
  it('adds the configured gain to the analyser peak and RMS', () => {
    const frame = { ...createMicVisualFrameBuffer(), ...speech }
    expect(writeMicMeterLevel(frame, { gainDb: 6, muted: false }, { peakDb: 0 })).toEqual({
      peakDb: -6,
      rmsDb: -14
    })
  })

  it('reads silence while muted, and with no analyser data, instead of freezing', () => {
    const live = { ...createMicVisualFrameBuffer(), ...speech }
    expect(writeMicMeterLevel(live, { gainDb: 0, muted: true }, { peakDb: 0 })).toEqual({
      peakDb: Number.NEGATIVE_INFINITY,
      rmsDb: Number.NEGATIVE_INFINITY
    })
    expect(
      writeMicMeterLevel(createMicVisualFrameBuffer(), { gainDb: 0, muted: false }, { peakDb: 0 })
    ).toEqual({ peakDb: Number.NEGATIVE_INFINITY, rmsDb: Number.NEGATIVE_INFINITY })
  })

  it('keeps digital silence silent whatever the gain', () => {
    const silent = {
      ...createMicVisualFrameBuffer(),
      peakDb: -60,
      peakDbfs: Number.NEGATIVE_INFINITY,
      rmsDbfs: Number.NEGATIVE_INFINITY
    }
    expect(writeMicMeterLevel(silent, { gainDb: 24, muted: false }, { peakDb: 0 }).peakDb).toBe(
      Number.NEGATIVE_INFINITY
    )
  })
})

describe('createMicMeterSource (plan 092)', () => {
  it('shares one retain and one subscription across every consumer', () => {
    const feed = fakeFeed(speech)
    const source = createMicMeterSource(feed, () => ({ gainDb: 0, muted: false }))
    const seen: number[][] = [[], [], []]
    const stops = seen.map((values) =>
      source.subscribe((frame) => values.push(frame.channels[0].peakDb))
    )
    expect(feed.retains).toBe(1)

    feed.publish()
    feed.publish()
    expect(seen).toEqual([
      [-12, -12],
      [-12, -12],
      [-12, -12]
    ])

    stops[0]()
    stops[1]()
    expect(feed.releases).toBe(0)
    stops[2]()
    expect(feed.releases).toBe(1)
  })

  it('leaves exactly one retain through a StrictMode unmount and remount', () => {
    const feed = fakeFeed(speech)
    const source = createMicMeterSource(feed, () => ({ gainDb: 0, muted: false }))
    source.subscribe(() => undefined)()
    source.subscribe(() => undefined)
    expect(feed.retains - feed.releases).toBe(1)
  })

  it('reads gain and mute on every frame, so a Gain drag never re-subscribes', () => {
    const feed = fakeFeed(speech)
    let settings = { gainDb: 0, muted: false }
    const source = createMicMeterSource(feed, () => settings)
    const peaks: number[] = []
    source.subscribe((frame) => peaks.push(frame.channels[0].peakDb))

    feed.publish()
    settings = { gainDb: 6, muted: false }
    feed.publish()
    settings = { gainDb: 6, muted: true }
    feed.publish()
    expect(peaks).toEqual([-12, -6, Number.NEGATIVE_INFINITY])
    expect(feed.retains).toBe(1)
  })

  it('emits one reused frame object, allocating nothing per frame', () => {
    const feed = fakeFeed(speech)
    const source = createMicMeterSource(feed, () => ({ gainDb: 0, muted: false }))
    const frames: MeterFrame[] = []
    source.subscribe((frame) => frames.push(frame))
    feed.publish()
    feed.publish()
    expect(frames[0]).toBe(frames[1])
  })
})
