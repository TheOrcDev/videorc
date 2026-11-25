/**
 * Plan 260 C4: synthetic talk-show room for the screen gallery and the
 * Electron baseline shooter. Mirrors
 * `videorc_app_core::studio::gallery_show_stage` — no LiveKit, X or YouTube.
 */

export const SHOW_ID = 'sh_gallery_show_stage'
export const HOST = `host:${SHOW_ID}`

const guests = [
  {
    guestId: 'g_ada',
    name: 'Ada',
    joinedAt: '2026-11-25T12:00:00Z',
    muted: false,
    screenShareAllowed: false
  },
  {
    guestId: 'g_grace',
    name: 'Grace',
    joinedAt: '2026-11-25T12:01:00Z',
    muted: true,
    screenShareAllowed: true
  }
]

const openParticipants = [
  {
    identity: HOST,
    name: 'You',
    role: 'host',
    onStage: true,
    video: true,
    audio: true,
    muted: false,
    screen: false,
    quality: 'excellent',
    sinceMs: 1000,
    away: false
  },
  {
    identity: 'g_ada',
    name: 'Ada',
    role: 'guest',
    onStage: true,
    video: true,
    audio: true,
    muted: false,
    screen: false,
    quality: 'good',
    sinceMs: 2000,
    away: false
  },
  {
    identity: 'g_grace',
    name: 'Grace',
    role: 'guest',
    onStage: false,
    video: false,
    audio: true,
    muted: true,
    screen: false,
    quality: 'good',
    sinceMs: 3000,
    away: false
  }
]

function talkStatus(room) {
  return {
    phase: 'live',
    entitled: true,
    plan: 'max',
    settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [300, 1800] },
    connected: true,
    directFallbackAvailable: false,
    show: {
      id: SHOW_ID,
      nodeId: 'node_gallery',
      kind: 'talk'
    },
    room
  }
}

function roomClosed() {
  return {
    phase: 'closed',
    doorOpen: false,
    platforms: ['youtube'],
    guests: [],
    participants: [],
    stage: { layout: 'solo', onStage: [] },
    connected: false,
    stageSet: false,
    live: false
  }
}

function roomOpen() {
  return {
    phase: 'open',
    doorOpen: true,
    inviteUrl: 'https://videorc.com/guest/galleryShowStage',
    platforms: ['youtube', 'twitch'],
    guests,
    participants: openParticipants,
    stage: {
      layout: 'side-by-side',
      onStage: [HOST, 'g_ada'],
      hostShape: 'rounded'
    },
    connected: true,
    client: 'connected',
    limits: {
      guestsOnStage: 5,
      roomSize: 10,
      recordingRetentionDays: 30
    },
    stageSet: true,
    live: false
  }
}

function roomScreens() {
  const room = roomOpen()
  room.stage = {
    layout: 'screen-people',
    onStage: [HOST, 'g_ada'],
    screen: HOST,
    hostShape: 'rounded'
  }
  room.participants = openParticipants.map((person) => {
    if (person.identity === HOST || person.identity === 'g_ada') {
      return { ...person, screen: true, onStage: true }
    }
    return person
  })
  room.guests = guests.map((guest) =>
    guest.guestId === 'g_ada' ? { ...guest, screenShareAllowed: true } : guest
  )
  return room
}

/** CloudStatus for a gallery kind: closed | open | screens | host-camera-off. */
export function galleryCloudStatus(kind) {
  switch (kind) {
    case 'closed':
      return talkStatus(roomClosed())
    case 'open':
    case 'host-camera-off':
      return talkStatus(roomOpen())
    case 'screens':
      return talkStatus(roomScreens())
    default:
      throw new Error(
        `gallery show-stage kind must be closed, open, screens or host-camera-off (got ${kind})`
      )
  }
}

/** Host camera-off flag the Electron Show stage reads from room media / local. */
export function galleryHostCameraOff(kind) {
  return kind === 'host-camera-off'
}
