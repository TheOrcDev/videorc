import { describe, expect, it } from 'vitest'

import type { CommunitySummary, ViewerArrival } from '@/lib/backend'
import {
  arrivalChip,
  awayLabel,
  backfillLine,
  communityHeaderLine,
  forgetCopy,
  lastChatLabel,
  milestoneLabel,
  ordinal,
  personStatsLine,
  sinceLabel,
  supportLine
} from '@/lib/community-view'

const regular: ViewerArrival = {
  streams: 14,
  regular: true,
  inARow: 5,
  platforms: ['twitch', 'youtube'],
  since: '2026-03'
}

describe('community copy (plan 225)', () => {
  it('writes ordinals, away times and months', () => {
    expect([1, 2, 3, 4, 10, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '10th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '101st',
      '111th'
    ])
    // Weeks under 8, then months (D7).
    expect(awayLabel(30, 'short')).toBe('4 wk')
    expect(awayLabel(21, 'long')).toBe('3 weeks')
    expect(awayLabel(7, 'long')).toBe('1 week')
    expect(awayLabel(55, 'short')).toBe('7 wk')
    expect(awayLabel(56, 'short')).toBe('2 mo')
    expect(awayLabel(95, 'long')).toBe('3 months')
    expect(sinceLabel('2026-03')).toBe('March 2026')
    expect(sinceLabel('2026-11-08T18:00:00Z')).toBe('November 2026')
    expect(sinceLabel('nope')).toBeNull()
    expect(sinceLabel(undefined)).toBeNull()
    expect(milestoneLabel({ kind: 'streams', value: 10 })).toBe('10th stream')
    expect(milestoneLabel({ kind: 'row', value: 5 })).toBe('5 in a row')
    expect(milestoneLabel({ kind: 'anniversary', value: 2027 })).toBe('1 year')
  })

  it('picks one chip per arrival: milestone, then Back, then Regular (D11)', () => {
    expect(arrivalChip(regular)).toEqual({
      kind: 'regular',
      label: 'Regular · 14',
      hint: '14 streams · since March 2026 · Twitch · YouTube'
    })
    expect(arrivalChip({ ...regular, awayDays: 21 })?.label).toBe('Back · 3 wk')
    expect(
      arrivalChip({ ...regular, awayDays: 21, milestone: { kind: 'streams', value: 10 } })?.label
    ).toBe('10th stream')
    // A returning person who is none of the three: no chip, the row stays quiet.
    expect(arrivalChip({ streams: 2, regular: false, inARow: 1 })).toBeNull()
    expect(arrivalChip(undefined)).toBeNull()
    // One account, no since: the hover line is the count alone.
    expect(arrivalChip({ streams: 3, regular: true, inARow: 1 })?.hint).toBe('3 streams')
  })

  it('writes the card lines and the forget question', () => {
    expect(
      personStatsLine({
        streams: 14,
        firstSeenAt: '2026-03-02T18:00:00Z',
        inARow: 5,
        messages: 812
      })
    ).toBe('14 streams · since March 2026 · 5 in a row · 812 messages')
    expect(personStatsLine({ streams: 1, inARow: 1, messages: 1 })).toBe('1 stream · 1 message')
    expect(supportLine({ bits: 4500, giftedSubs: 3 })).toBe('4,500 bits · 3 gifted subs')
    expect(supportLine({})).toBeNull()
    expect(supportLine(undefined)).toBeNull()
    expect(supportLine({ tips: { USD: 20_000_000 } })).toMatch(/20/)
    expect(forgetCopy('Ada')).toEqual({
      title: 'Forget Ada?',
      description:
        'Videorc deletes what it remembers about Ada on this computer and never learns it again, unless Ada types !rememberme.',
      confirm: 'Forget Ada'
    })
  })

  it('writes the Community header and the backfill line (D12)', () => {
    const summary: CommunitySummary = {
      people: 312,
      regulars: 18,
      streams: 41,
      newRegularsThisWeek: 2,
      linksPending: 1,
      backfill: { state: 'running', done: 12, total: 41 }
    }
    expect(communityHeaderLine(summary)).toBe(
      'Videorc knows 312 people from your 41 streams on this computer. 18 are regulars.'
    )
    expect(communityHeaderLine(null)).toBe(
      'Videorc starts remembering your chat from your next stream.'
    )
    expect(communityHeaderLine({ ...summary, people: 0 })).toBe(
      'Videorc starts remembering your chat from your next stream.'
    )
    expect(backfillLine(summary)).toBe('Reading your past streams… 12 of 41')
    expect(
      backfillLine({ ...summary, backfill: { state: 'done', done: 41, total: 41 } })
    ).toBeNull()
  })

  it('says when someone last chatted', () => {
    const now = Date.parse('2026-11-08T12:00:00Z')
    expect(lastChatLabel('2026-11-08T08:00:00Z', now)).toBe('today')
    expect(lastChatLabel('2026-11-07T08:00:00Z', now)).toBe('yesterday')
    expect(lastChatLabel('2026-11-03T08:00:00Z', now)).toBe('5 days ago')
    expect(lastChatLabel('2026-10-18T08:00:00Z', now)).toBe('3 weeks ago')
    expect(lastChatLabel('2026-03-18T08:00:00Z', now)).toBe('March 2026')
    expect(lastChatLabel('nope', now)).toBeNull()
  })
})
