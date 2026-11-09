import { describe, expect, it } from 'vitest'

import { HOST, ada, grace, openRoom, talkStatus } from '@/lib/guests-room-fixtures'
import {
  GUESTS_CLOUD_NOT_YET_REASON,
  GUESTS_NOT_YET_REASON,
  GUESTS_PREMIUM_REASON,
  GUESTS_PREMIUM_SEAT_LINE,
  bringOnBlockedReason,
  closeRoomAsksFirst,
  declinedLine,
  guestConsentLine,
  guestsAccess,
  guestsSessionValue,
  layoutOptions,
  layoutReasonsLine,
  newLinkAsksFirst,
  qualityStatus,
  renamedGuestName,
  roomIsFull,
  roomLimits,
  roomLimitsLine,
  roomPeople,
  shownLayout
} from '@/lib/guests-view'

// Plan 224 C-G2 and C-G3: what Livestream → Guests and the Show stage say,
// from the backend's room. Guests are never "participants", and the runner
// is never a person.

describe('guestsAccess (C-G2, D15)', () => {
  it('sells Premium to a Basic account', () => {
    expect(guestsAccess(talkStatus({ entitled: false, plan: undefined }))).toEqual({
      kind: 'locked',
      reason: GUESTS_PREMIUM_REASON,
      upsell: true
    })
  })

  it("says the cloud isn't on yet for a paid account outside the rollout", () => {
    expect(guestsAccess(talkStatus({ entitled: false, plan: 'premium' }))).toEqual({
      kind: 'locked',
      reason: GUESTS_CLOUD_NOT_YET_REASON,
      upsell: false
    })
  })

  it('says not yet to any paid plan whose allowance has no talk shows (D15 B)', () => {
    const noTalk = {
      enabled: true,
      secondsPerMonth: 1,
      secondsUsed: 0,
      overageSeconds: 0,
      talkShows: false
    }
    for (const plan of ['premium', 'max'] as const) {
      expect(guestsAccess(talkStatus({ plan, allowance: noTalk }))).toMatchObject({
        reason: GUESTS_NOT_YET_REASON,
        upsell: false
      })
    }
  })

  // Review L1: one lock sentence, D15 B's, in the renderer and the backend
  // (`cloud_talk.rs` TALK_SHOWS_LOCK_MESSAGE) alike.
  it("names Premium, the lowest plan with guests, and never Max's old lock", () => {
    expect(GUESTS_PREMIUM_REASON).toBe('Talk shows with guests come with Videorc Premium.')
    const reasons = [
      guestsAccess(talkStatus({ entitled: false, plan: undefined })),
      guestsAccess(talkStatus({ entitled: false, plan: 'premium' })),
      guestsAccess(
        talkStatus({
          plan: 'premium',
          allowance: {
            enabled: true,
            secondsPerMonth: 1,
            secondsUsed: 0,
            overageSeconds: 0,
            talkShows: false
          }
        })
      )
    ].map((access) => (access.kind === 'locked' ? access.reason : ''))
    expect(reasons.join(' ')).not.toContain('Videorc Max')
  })

  it('opens for an account with talk shows, and never locks a room this computer holds', () => {
    expect(guestsAccess(talkStatus())).toEqual({ kind: 'available' })
    expect(
      guestsAccess(talkStatus({ entitled: false, plan: undefined, room: openRoom() }))
    ).toEqual({ kind: 'available' })
  })
})

describe('limits (D15)', () => {
  it('reads the open room first, then the allowance', () => {
    expect(roomLimits(talkStatus())).toEqual({ guestsOnStage: 5, roomSize: 10 })
    expect(
      roomLimits(
        talkStatus({
          room: openRoom({ limits: { guestsOnStage: 1, roomSize: 2, recordingRetentionDays: 7 } })
        })
      )
    ).toEqual({ guestsOnStage: 1, roomSize: 2 })
  })

  it("says Max's room in numbers and Premium's one seat in its own line", () => {
    expect(roomLimitsLine({ guestsOnStage: 5, roomSize: 10 })).toBe(
      'Up to 5 guests on stage, 10 people in the room.'
    )
    expect(roomLimitsLine({ guestsOnStage: 1, roomSize: 2 })).toBe(GUESTS_PREMIUM_SEAT_LINE)
    expect(roomLimitsLine(null)).toBeNull()
  })
})

describe('the consent line (D13)', () => {
  it('names the platforms, or says the short form before any is known', () => {
    expect(guestConsentLine(['youtube', 'twitch', 'kick'])).toBe(
      'This show goes out live on YouTube, Twitch and Kick and may be recorded. Your camera and voice are part of it.'
    )
    expect(guestConsentLine(['youtube'])).toBe(
      'This show goes out live on YouTube and may be recorded. Your camera and voice are part of it.'
    )
    expect(guestConsentLine([])).toBe(
      'This show goes out live and may be recorded. Your camera and voice are part of it.'
    )
  })
})

describe('roomPeople', () => {
  it('lists the host first, then the stage in order, then backstage; never the runner', () => {
    const room = openRoom({
      guests: [ada, grace],
      participants: [
        ...(openRoom().participants ?? []),
        {
          identity: 'runner:sh_talk',
          name: 'runner',
          role: 'guest',
          onStage: false,
          video: true,
          audio: true,
          muted: false,
          screen: false,
          quality: 'excellent',
          sinceMs: 0,
          away: false
        },
        {
          identity: 'g_grace',
          name: 'Grace',
          role: 'guest',
          onStage: true,
          video: true,
          audio: true,
          muted: true,
          screen: false,
          quality: 'poor',
          sinceMs: 2000,
          away: false
        }
      ],
      stage: { layout: 'side-by-side', onStage: [HOST, 'g_grace'] }
    })
    const people = roomPeople(room, HOST)
    expect(people.map((person) => person.name)).toEqual(['You', 'Grace', 'Ada'])
    expect(people.map((person) => person.onStage)).toEqual([true, true, false])
    expect(people[1]).toMatchObject({ guestId: 'g_grace', quality: 'poor', muted: true })
    expect(people[2]).toMatchObject({ guestId: 'g_ada', quality: null })
    expect(people.some((person) => person.identity.startsWith('runner:'))).toBe(false)
  })

  it('is empty while the room is closed', () => {
    expect(roomPeople(openRoom({ phase: 'closed' }), HOST)).toEqual([])
    expect(roomPeople(undefined, null)).toEqual([])
  })

  it('counts the room against its size and the stage against its seats', () => {
    const people = roomPeople(
      openRoom({ guests: [ada], stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada'] } }),
      HOST
    )
    expect(roomIsFull(people, { guestsOnStage: 1, roomSize: 2 })).toBe(true)
    expect(roomIsFull(people, { guestsOnStage: 5, roomSize: 10 })).toBe(false)
    expect(bringOnBlockedReason(people, { guestsOnStage: 1, roomSize: 2 })).toBe(
      GUESTS_PREMIUM_SEAT_LINE
    )
    expect(bringOnBlockedReason(people, { guestsOnStage: 5, roomSize: 10 })).toBeNull()
  })
})

describe('words', () => {
  it('names a connection by its dot and a word, quiet when fine', () => {
    expect(qualityStatus('excellent')).toEqual({ tone: 'good', label: 'Good connection' })
    expect(qualityStatus('poor')).toEqual({ tone: 'warn', label: 'Weak connection' })
    expect(qualityStatus('lost')).toEqual({ tone: 'error', label: 'Connection lost' })
    expect(qualityStatus(null)).toEqual({ tone: 'neutral', label: 'Joining' })
  })

  it("sums the room on the Studio's row (D16)", () => {
    const room = openRoom({
      guests: [ada, grace],
      stage: { layout: 'side-by-side', onStage: [HOST, 'g_grace'] },
      requests: [
        { requestId: 'r1', name: 'Linus', askedAt: '2026-11-09T10:02:00Z', device: 'phone' }
      ]
    })
    expect(guestsSessionValue(room, roomPeople(room, HOST))).toBe(
      'Room open · 1 on stage · 1 backstage · 1 wants to join'
    )
  })

  it('counts the declined requests that came back (D5)', () => {
    expect(declinedLine(0)).toBeNull()
    expect(declinedLine(3)).toBe('3 more asked')
  })

  it('asks before closing a room with anyone in it, and before a new link with guests', () => {
    expect(closeRoomAsksFirst(talkStatus({ room: openRoom() }))).toBe(false)
    expect(closeRoomAsksFirst(talkStatus({ room: openRoom({ guests: [ada] }) }))).toBe(true)
    expect(closeRoomAsksFirst(talkStatus({ room: openRoom({ live: true }) }))).toBe(true)
    expect(newLinkAsksFirst(openRoom())).toBe(false)
    expect(newLinkAsksFirst(openRoom({ guests: [ada] }))).toBe(true)
  })

  it('renames to a trimmed 1 to 32 characters, and never to the same name', () => {
    expect(renamedGuestName('Ada', '  Ada L. ')).toBe('Ada L.')
    expect(renamedGuestName('Ada', 'Ada')).toBeNull()
    expect(renamedGuestName('Ada', '   ')).toBeNull()
    expect(renamedGuestName('Ada', 'x'.repeat(33))).toBeNull()
  })
})

describe('layout chips (C-G3)', () => {
  it('waits on a shared screen for Screen + people, and on one person for Solo', () => {
    const one = layoutOptions(openRoom())
    expect(one.find((option) => option.value === 'screen-people')?.disabledReason).toBe(
      'Share a screen first'
    )
    expect(one.find((option) => option.value === 'solo')?.disabledReason).toBeNull()
    const two = layoutOptions(
      openRoom({ stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada'], screen: HOST } })
    )
    expect(two.find((option) => option.value === 'screen-people')?.disabledReason).toBeNull()
    expect(two.find((option) => option.value === 'solo')?.disabledReason).toMatch(/^Solo shows/)
  })

  it('says why in one line, naming the layout a screen waits for', () => {
    expect(
      layoutReasonsLine(
        layoutOptions(openRoom({ stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada'] } }))
      )
    ).toBe(
      'Solo shows one person. Send the others backstage first. Share a screen first for Screen + people.'
    )
  })

  it("shows the runner's fallback, never a layout it won't draw", () => {
    expect(shownLayout(openRoom({ stage: { layout: 'solo', onStage: [HOST, 'g_ada'] } }))).toBe(
      'side-by-side'
    )
  })
})
