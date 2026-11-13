import type { CloudRoomGuest, CloudRoomStatus, CloudStatus } from '@/lib/backend'

// Plan 224 C-G2, C-G3: a talk show's cloud status for the Guests tab, the
// Show stage and their view tests. Test data only: nothing in the app
// imports it.

export const HOST = 'host:sh_talk'

export function talkStatus(overrides: Partial<CloudStatus> = {}): CloudStatus {
  return {
    phase: 'off',
    entitled: true,
    plan: 'max',
    settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [300, 1800] },
    allowance: {
      enabled: true,
      secondsPerMonth: 36_000,
      secondsUsed: 0,
      overageSeconds: 0,
      talkShows: true,
      guestsOnStage: 5,
      roomSize: 10,
      recordingRetentionDays: 30
    },
    connected: true,
    directFallbackAvailable: false,
    ...overrides
  }
}

export function openRoom(overrides: Partial<CloudRoomStatus> = {}): CloudRoomStatus {
  return {
    phase: 'open',
    inviteUrl: 'https://videorc.com/guest/k7m2Ab9xQp3rT5vW',
    doorOpen: false,
    platforms: ['youtube', 'twitch'],
    declinedCount: 0,
    participants: [
      {
        identity: HOST,
        name: 'OrcDev',
        role: 'host',
        onStage: true,
        video: true,
        audio: true,
        muted: false,
        screen: false,
        quality: 'excellent',
        sinceMs: 1000,
        away: false
      }
    ],
    stage: { layout: 'solo', onStage: [HOST] },
    hostAway: false,
    connected: true,
    limits: { guestsOnStage: 5, roomSize: 10, recordingRetentionDays: 30 },
    client: 'connected',
    returnEnabled: false,
    stageSet: true,
    live: false,
    ...overrides
  }
}

export const ada: CloudRoomGuest = {
  guestId: 'g_ada',
  name: 'Ada',
  joinedAt: '2026-11-09T10:00:00Z',
  muted: false,
  screenShareAllowed: false
}
export const grace: CloudRoomGuest = {
  guestId: 'g_grace',
  name: 'Grace',
  joinedAt: '2026-11-09T10:01:00Z',
  muted: true,
  screenShareAllowed: true
}
