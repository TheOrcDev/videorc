import { describe, expect, it } from 'vitest'

import type { DiagnosticStats, StreamTargetRuntime } from '@/lib/backend'
import {
  cloudStreamReading,
  liveDestinationProblem,
  liveDestinationsView,
  streamHealthFact
} from './live-session-view'
import { cloudDestinationCount, cloudHealthySummary } from './cloud-show-view'
import { classifyStreamHealthAttribution, NO_RECENT_DROPS } from './stream-health-attribution'

const target = (
  state: StreamTargetRuntime['state'],
  label = 'Twitch',
  targetId = label.toLowerCase()
): StreamTargetRuntime => ({ targetId, platform: 'twitch', label, state })

// Plan 174 S3.2 (B-4): the Session section tells the truth about every
// destination while on air, quietly when fine and one row per problem when not.
describe('liveDestinationsView', () => {
  it('is nothing before the backend reports destinations, or for a record-only session', () => {
    expect(liveDestinationsView([])).toBeNull()
    expect(liveDestinationsView([target('not-configured')])).toBeNull()
  })

  it('reads "n of n on air" quietly when every leg is live', () => {
    expect(liveDestinationsView([target('live'), target('live', 'YouTube')])).toEqual({
      kind: 'quiet',
      summary: '2 of 2 on air'
    })
  })

  it('counts a leg still connecting as not on air, without calling it a problem', () => {
    expect(liveDestinationsView([target('live'), target('connecting', 'Kick')])).toEqual({
      kind: 'quiet',
      summary: '1 of 2 on air'
    })
  })

  it('lists one row per problem, with the count still honest', () => {
    expect(
      liveDestinationsView([
        target('live'),
        target('failed', 'YouTube'),
        target('reconnecting', 'Kick'),
        target('warning', 'X')
      ])
    ).toEqual({
      kind: 'problems',
      summary: '1 of 4 on air',
      problems: [
        { targetId: 'youtube', label: 'YouTube', word: 'Failed', tone: 'error' },
        { targetId: 'kick', label: 'Kick', word: 'Reconnecting…', tone: 'warn' },
        { targetId: 'x', label: 'X', word: 'Not receiving', tone: 'warn' }
      ]
    })
  })

  it('reads a leg that ended as Ended, and a fine one as no problem', () => {
    expect(liveDestinationProblem(target('stopped'))).toMatchObject({
      word: 'Ended',
      tone: 'error'
    })
    for (const state of ['live', 'ready', 'connecting', 'not-configured'] as const) {
      expect(liveDestinationProblem(target(state))).toBeNull()
    }
  })
})

describe('streamHealthFact', () => {
  it('is a quiet Healthy, a measured problem, or Checking… before any verdict', () => {
    expect(streamHealthFact('healthy')).toEqual({ label: 'Healthy', tone: 'good' })
    expect(streamHealthFact('unknown')).toEqual({ label: 'Checking…', tone: 'neutral' })
    expect(streamHealthFact('network')).toEqual({ label: 'Delivery degraded', tone: 'warn' })
    expect(streamHealthFact('encoder')).toEqual({ label: 'Encoder dropping frames', tone: 'warn' })
  })

  // Plan 184 C7: while Videorc Cloud holds the show, that is the fact; it
  // outranks the upload's own reconnecting row, because viewers see the card
  // and the show is still on air.
  it('says Be right back with the time left while the cloud holds, and Cloud resuming after', () => {
    expect(streamHealthFact('network', { phase: 'hold', holdRemainingSeconds: 1_650 })).toEqual({
      label: 'Be right back · 28 min left',
      tone: 'warn'
    })
    expect(streamHealthFact('healthy', { phase: 'hold' })).toEqual({
      label: 'Be right back',
      tone: 'warn'
    })
    expect(streamHealthFact('healthy', { phase: 'resuming' })).toEqual({
      label: 'Cloud resuming',
      tone: 'warn'
    })
    // On air through the cloud, the stages speak as they always did.
    expect(streamHealthFact('healthy', { phase: 'live', feedKbps: 6_000 })).toEqual({
      label: 'Healthy',
      tone: 'good'
    })
    expect(streamHealthFact('uplink', { phase: 'live' })).toEqual({
      label: 'Connection too slow',
      tone: 'warn'
    })
    expect(cloudStreamReading(null)).toBeNull()
    expect(cloudStreamReading({ phase: 'connecting' })).toBeNull()
  })

  it('names the way out in the healthy summary: "Cloud · 6 Mbps"', () => {
    // Plan 222 U2: the upload and where the cloud sends it.
    expect(cloudHealthySummary({ phase: 'live' }, ['6 Mbps', '60 fps'], 3)).toBe(
      'Cloud · 6 Mbps up · 3 destinations'
    )
    expect(cloudHealthySummary({ phase: 'live' }, ['6 Mbps', '60 fps'], 1)).toBe(
      'Cloud · 6 Mbps up · 1 destination'
    )
    expect(cloudHealthySummary({ phase: 'live' }, [undefined, null])).toBe('Cloud')
    expect(cloudHealthySummary(null, ['6 Mbps', '60 fps'], 3)).toBe('6 Mbps · 60 fps')
    expect(
      cloudDestinationCount([
        target('live', 'YouTube'),
        target('live', 'Twitch'),
        { ...target('live', 'Videorc Cloud'), targetId: 'videorc-cloud-horizontal' },
        target('not-configured', 'Kick')
      ])
    ).toBe(2)
  })
})

// Plan 184 C7: through the cloud the upload legs are not destinations. One
// Videorc Cloud row stands for them, only while the show is not simply on
// air, and the count is the runner's platforms.
describe('liveDestinationsView through Videorc Cloud', () => {
  const feed = (state: StreamTargetRuntime['state']): StreamTargetRuntime => ({
    targetId: 'videorc-cloud-horizontal',
    platform: 'custom',
    label: 'Videorc Cloud',
    state
  })

  it('counts the platforms, never the feed, and stays quiet on air', () => {
    expect(
      liveDestinationsView([feed('live'), target('live'), target('live', 'YouTube')], {
        phase: 'live',
        feedKbps: 6_000
      })
    ).toEqual({ kind: 'quiet', summary: '2 of 2 on air' })
  })

  it('leads with the hold and its time left, then the platforms with problems', () => {
    expect(
      liveDestinationsView([feed('reconnecting'), target('live'), target('failed', 'YouTube')], {
        phase: 'hold',
        holdRemainingSeconds: 1_650
      })
    ).toEqual({
      kind: 'problems',
      summary: '1 of 2 on air',
      problems: [
        {
          targetId: 'videorc-cloud-horizontal',
          label: 'Videorc Cloud',
          word: 'Be right back · 28 min left',
          tone: 'warn'
        },
        { targetId: 'youtube', label: 'YouTube', word: 'Failed', tone: 'error' }
      ]
    })
    expect(liveDestinationsView([feed('live'), target('live')], { phase: 'resuming' })).toEqual({
      kind: 'problems',
      summary: '1 of 1 on air',
      problems: [
        {
          targetId: 'videorc-cloud-horizontal',
          label: 'Videorc Cloud',
          word: 'Resuming…',
          tone: 'warn'
        }
      ]
    })
    expect(liveDestinationsView([feed('live'), target('live')], { phase: 'failed' })?.kind).toBe(
      'problems'
    )
  })

  it('is nothing until the runner has listed a platform', () => {
    expect(liveDestinationsView([feed('live')], { phase: 'live' })).toBeNull()
  })
})

// Plan 222 L2: the one feed leg under plan 218. When this computer's upload
// cannot carry the feed, Stream health names the connection and the
// destinations stay quiet: the platforms are the runner's and keep
// receiving, so no platform row and no "Videorc Cloud could not receive".
// When the feed is gone the show holds, and the one Cloud row stands for
// the hold; still never a platform row.
describe('the cloud feed under a thin uplink (plan 222 L2)', () => {
  const feed = (
    state: StreamTargetRuntime['state'],
    extra: Partial<StreamTargetRuntime> = {}
  ): StreamTargetRuntime => ({
    targetId: 'videorc-cloud-horizontal',
    platform: 'custom',
    label: 'Videorc Cloud',
    state,
    ...extra
  })
  const nowMs = Date.parse('2026-11-08T10:00:30.000Z')
  const stats = (streamDelivery: DiagnosticStats['streamDelivery']): DiagnosticStats =>
    ({
      sessionId: 'session-a',
      targetFps: 30,
      captureFps: 30,
      renderFps: 30,
      encoderSpeed: 1,
      skippedFrames: 0,
      droppedFrames: 0,
      micDroppedFrames: 0,
      micCaptureCoverage: 1,
      deviceDisconnected: false,
      bottleneck: 'none',
      previewDroppedFrames: 0,
      streamOutputBitrateKbps: 6_000,
      streamMeasuredBitrateKbps: 4_800,
      streamDelivery
    }) as DiagnosticStats

  it('reads "Connection too slow" with the platforms quiet while the feed overflows', () => {
    const overflowing = feed('live', {
      uplinkOverflows: 3,
      uplinkOverflowAt: new Date(nowMs - 5_000).toISOString()
    })
    const targets = [overflowing, target('live'), target('live', 'YouTube')]
    const lowered = stats({
      targetFps: 30,
      deliveredFps: 30,
      dropPercent: 0,
      windowSeconds: 30,
      degraded: false,
      atFloor: false,
      uplinkOverflows: 3,
      bitrateKbps: 4_800,
      chosenBitrateKbps: 6_000
    })
    const attribution = classifyStreamHealthAttribution(
      lowered,
      null,
      targets,
      NO_RECENT_DROPS,
      nowMs
    )
    expect(attribution).toBe('uplink')
    const fact = streamHealthFact(attribution, { phase: 'live', feedKbps: 4_800 })
    expect(fact).toEqual({ label: 'Connection too slow', tone: 'warn' })
    expect(fact.label).not.toMatch(/Videorc Cloud|receive/)
    // The platforms are the runner's legs and keep receiving: no row at all.
    expect(liveDestinationsView(targets, { phase: 'live', feedKbps: 4_800 })).toEqual({
      kind: 'quiet',
      summary: '2 of 2 on air'
    })
  })

  it('shows the one Cloud row, never a platform row, while the feed is gone and the show holds', () => {
    const targets = [feed('reconnecting'), target('live'), target('live', 'YouTube')]
    const view = liveDestinationsView(targets, { phase: 'hold', holdRemainingSeconds: 1_500 })
    expect(view).toEqual({
      kind: 'problems',
      summary: '2 of 2 on air',
      problems: [
        {
          targetId: 'videorc-cloud-horizontal',
          label: 'Videorc Cloud',
          word: 'Be right back · 25 min left',
          tone: 'warn'
        }
      ]
    })
    // The hold outranks the upload's own reading: viewers see the card.
    expect(streamHealthFact('uplink', { phase: 'hold', holdRemainingSeconds: 1_500 })).toEqual({
      label: 'Be right back · 25 min left',
      tone: 'warn'
    })
  })
})
