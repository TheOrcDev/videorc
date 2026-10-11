import { describe, expect, it } from 'vitest'

import type { StreamTargetRuntime } from '@/lib/backend'
import { liveDestinationProblem, liveDestinationsView, streamHealthFact } from './live-session-view'

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
        { targetId: 'youtube', label: 'YouTube', word: 'Stopped', tone: 'error' },
        { targetId: 'kick', label: 'Kick', word: 'Reconnecting', tone: 'warn' },
        { targetId: 'x', label: 'X', word: 'Not receiving', tone: 'warn' }
      ]
    })
  })

  it('reads a stopped leg as Stopped, and a fine one as no problem', () => {
    expect(liveDestinationProblem(target('stopped'))).toMatchObject({
      word: 'Stopped',
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
})
