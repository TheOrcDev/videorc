import { describe, expect, it } from 'vitest'

import {
  HOST,
  ada,
  grace,
  guestParticipant,
  openRoom,
  talkStatus
} from '@/lib/guests-room-fixtures'
import {
  guestScreenShare,
  micToggleLabel,
  outputProfileChips,
  personMicView,
  roomCounts,
  roomPeople,
  roomScreens,
  stageWithScreen
} from '@/lib/guests-view'
import { roomOptInTone, roomProgramChips } from '@/lib/room-program-opt-ins'

// Plan 252: what the room's rows, cards and chips draw. Each state is a
// picture or an icon on screen, so the words here are what a screen reader
// hears and what a tooltip says.

const heard = { localMicMuted: false, roomMicMuted: false, speaking: false }

describe('personMicView (plan 252, D14)', () => {
  const guest = { host: false, name: 'Ada' }

  it("keeps the three states of a guest's mic apart, and talking from quiet", () => {
    expect(personMicView({ ...guest, mic: 'held' }, heard)).toEqual({
      state: 'held',
      label: 'Muted by you',
      hint: "Ada can't unmute until you let them."
    })
    expect(personMicView({ ...guest, mic: 'off' }, heard)).toEqual({
      state: 'off',
      label: 'Mic off',
      hint: 'Only Ada can turn their mic on.'
    })
    expect(personMicView({ ...guest, mic: 'on' }, { ...heard, speaking: true }).state).toBe(
      'talking'
    )
    expect(personMicView({ ...guest, mic: 'on' }, heard)).toEqual({
      state: 'quiet',
      label: 'Quiet',
      hint: null
    })
  })

  it("trusts the host's own room for a mic it sees muted, but never over the hold", () => {
    expect(personMicView({ ...guest, mic: 'on' }, { ...heard, roomMicMuted: true }).state).toBe(
      'off'
    )
    expect(personMicView({ ...guest, mic: 'held' }, { ...heard, roomMicMuted: true }).state).toBe(
      'held'
    )
    // A guest the runner doesn't see yet says nothing about their mic.
    expect(personMicView({ ...guest, mic: 'unknown' }, heard).state).toBe('quiet')
  })

  it("reads the host's own mute for the host", () => {
    const host = { host: true, name: 'You', mic: 'on' as const }
    expect(personMicView(host, heard).state).toBe('quiet')
    expect(personMicView(host, { ...heard, localMicMuted: true })).toEqual({
      state: 'muted',
      label: 'Muted',
      hint: null
    })
  })

  it('names the control by what a press does', () => {
    expect(micToggleLabel({ host: false, muted: false, name: 'Ada' }, false)).toBe('Mute Ada')
    expect(micToggleLabel({ host: false, muted: true, name: 'Ada' }, false)).toBe('Let Ada unmute')
    expect(micToggleLabel({ host: true, muted: false, name: 'You' }, false)).toBe(
      'Mute your microphone'
    )
    expect(micToggleLabel({ host: true, muted: false, name: 'You' }, true)).toBe(
      'Unmute your microphone'
    )
  })
})

describe('guestScreenShare (plan 252)', () => {
  const person = { name: 'Ada', screenShareAllowed: false, sharingScreen: false }

  it('is off, allowed or sharing, and a press allows it or takes it back', () => {
    expect(guestScreenShare(person)).toMatchObject({
      state: 'off',
      action: 'allow-screen-share',
      actionLabel: 'Let Ada share their screen'
    })
    expect(guestScreenShare({ ...person, screenShareAllowed: true })).toMatchObject({
      state: 'allowed',
      action: 'disallow-screen-share',
      actionLabel: 'Stop letting Ada share their screen'
    })
    expect(
      guestScreenShare({ ...person, screenShareAllowed: true, sharingScreen: true })
    ).toMatchObject({
      state: 'sharing',
      action: 'disallow-screen-share',
      actionLabel: "Stop Ada's screen share"
    })
  })

  it('says sharing when the room sees a screen before the permission is listed', () => {
    expect(guestScreenShare({ ...person, sharingScreen: true }).state).toBe('sharing')
  })
})

describe('roomScreens and stageWithScreen (plan 252)', () => {
  const room = openRoom({
    guests: [ada, grace],
    participants: [
      ...(openRoom().participants ?? []),
      guestParticipant(ada, { onStage: true, screen: true }),
      guestParticipant(grace, { screen: true })
    ],
    stage: { layout: 'screen-people', onStage: [HOST, 'g_ada'], screen: 'g_ada' }
  })
  const people = roomPeople(room, HOST)

  it("lists every shared screen, the host's first, and which one is on stage", () => {
    expect(roomScreens(room, people, true)).toEqual([
      { identity: HOST, name: 'Your screen', host: true, onProgram: false, blockedReason: null },
      {
        identity: 'g_ada',
        name: "Ada's screen",
        host: false,
        onProgram: true,
        blockedReason: null
      },
      {
        identity: 'g_grace',
        name: "Grace's screen",
        host: false,
        onProgram: false,
        blockedReason: 'Bring Grace on first.'
      }
    ])
    // The host's screen is listed only while they share.
    expect(roomScreens(room, people, false).map((screen) => screen.identity)).toEqual([
      'g_ada',
      'g_grace'
    ])
    expect(roomScreens(openRoom(), roomPeople(openRoom(), HOST), false)).toEqual([])
  })

  it('puts a screen on with Screen + people, and takes it off for Side by side', () => {
    const stage = { layout: 'spotlight' as const, onStage: [HOST, 'g_ada'], spotlight: 'g_ada' }
    expect(stageWithScreen(stage, 'g_ada')).toEqual({
      ...stage,
      layout: 'screen-people',
      screen: 'g_ada'
    })
    expect(stageWithScreen({ ...stage, layout: 'screen-people', screen: 'g_ada' }, null)).toEqual({
      ...stage,
      layout: 'side-by-side',
      screen: undefined
    })
    // Another layout stays as it is when the screen goes.
    expect(stageWithScreen({ ...stage, screen: 'g_ada' }, null).layout).toBe('spotlight')
  })
})

describe('the room in numbers and chips (plan 252)', () => {
  it('counts guests on stage, backstage and asking, never the host', () => {
    const room = openRoom({
      guests: [ada, grace],
      requests: [{ requestId: 'r1', name: 'Bo', askedAt: '2026-11-19T10:00:00Z', device: 'phone' }],
      stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada'] }
    })
    expect(roomCounts(room, roomPeople(room, HOST))).toEqual({
      onStage: 1,
      backstage: 1,
      asking: 1
    })
    expect(roomCounts(undefined, [])).toEqual({ onStage: 0, backstage: 0, asking: 0 })
  })

  it('writes the output profile as short facts, and marks one that differs', () => {
    const output = {
      orientation: 'horizontal' as const,
      width: 1920,
      height: 1080,
      fps: 30,
      videoKbps: 6000,
      audioKbps: 160,
      pictureFps: 30,
      differences: [] as ('resolution' | 'fps' | 'bitrate')[]
    }
    const profile = {
      version: 1 as const,
      requested: [output],
      effective: [
        output,
        {
          ...output,
          orientation: 'vertical' as const,
          width: 1080,
          height: 1920,
          differences: ['resolution' as const]
        }
      ],
      qualification: 'phase0-1080p30-picture' as const,
      higherProfilesQualified: false as const,
      pricePerHour: null,
      maxProgramEgresses: 4
    }
    expect(outputProfileChips(profile)).toEqual([
      { orientation: 'horizontal', facts: ['1920×1080', '30 fps', '6 Mbps'], differs: false },
      { orientation: 'vertical', facts: ['1080×1920', '30 fps', '6 Mbps'], differs: true }
    ])
    expect(outputProfileChips(undefined)).toEqual([])
    expect(talkStatus().show).toBeUndefined()
  })

  it('draws each opt-in as a chip and a tone', () => {
    expect(roomProgramChips({ enabled: true }, null)).toEqual([
      { id: 'avatar', label: 'Avatar on', on: true },
      { id: 'graphics', label: 'Graphics off', on: false }
    ])
    expect(roomOptInTone(null)).toBe('neutral')
    expect(roomOptInTone({ enabled: true })).toBe('warn')
    expect(roomOptInTone({ enabled: true, state: 'applied' })).toBe('good')
    expect(roomOptInTone({ enabled: true, reason: 'Refused.' })).toBe('error')
  })
})
