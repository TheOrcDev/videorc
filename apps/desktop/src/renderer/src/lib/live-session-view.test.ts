import { describe, expect, it } from 'vitest'

import type { StreamTargetRuntime } from '@/lib/backend'
import {
  cloudHealthySummary,
  cloudStreamReading,
  liveDestinationProblem,
  liveDestinationsView,
  streamHealthFact
} from './live-session-view'

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
    expect(cloudHealthySummary({ phase: 'live' }, ['6 Mbps', '60 fps'])).toBe(
      'Cloud · 6 Mbps · 60 fps'
    )
    expect(cloudHealthySummary({ phase: 'live' }, [undefined, null])).toBe('Cloud')
    expect(cloudHealthySummary(null, ['6 Mbps'])).toBe('6 Mbps')
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
