import type {
  CloudRoomQuality,
  CloudRoomRequest,
  CloudRoomStatus,
  CloudStageLayout,
  CloudStatus,
  StreamPlatform
} from '@/lib/backend'
import { plural } from '@/lib/format'
import { platformLabel } from '@/lib/platform-copy'
import type { StatusTone } from '@/lib/status-word'
import { effectiveStageLayout, showStageInput } from '@/lib/talk-show-layout'

// What Livestream → Guests and the Show stage say about the room (plan 224
// C-G2, C-G3), derived from the backend's `CloudStatus.room`. Pure, so every
// line of copy is a test. Copy rules (plan 224 "Words we use"): guest, never
// participant; Let in and Decline; Bring on and Send backstage; the runner is
// never a person. Loaded with the Guests tab and the Show stage, never eager.

// --- Locks (C-G2, D15) -------------------------------------------------------

/** Basic: guests come with a paid plan (D15 B: Premium seats one). */
export const GUESTS_PREMIUM_REASON = 'Talk shows with guests come with Videorc Premium.'
/** A plan without talk shows (D15 A, kept for an allowance that says so). */
export const GUESTS_MAX_REASON = 'Talk shows with guests come with Videorc Max.'
/** A paid plan whose cloud isn't on yet (the rollout switch, the cohort). */
export const GUESTS_CLOUD_NOT_YET_REASON = "Videorc Cloud isn't on for your account yet."
/** Max with talk shows switched off for the account (the rollout). */
export const GUESTS_NOT_YET_REASON = "Talk shows aren't on for your account yet."
/** The backend never answered with the cloud's state (an older backend). */
export const GUESTS_CLOUD_UNKNOWN_REASON = "Videorc can't check Videorc Cloud right now."
/** D15 B: Premium's extra lock, the stage's one seat. */
export const GUESTS_PREMIUM_SEAT_LINE = 'Up to 1 guest on stage with Premium. Videorc Max seats 5.'

export type GuestsAccess =
  | { kind: 'available' }
  | { kind: 'locked'; reason: string; upsell: boolean }

/** Whether this account can open a room, and the one reason when it can't. */
export function guestsAccess(status: CloudStatus | null): GuestsAccess {
  if (!status) return { kind: 'locked', reason: GUESTS_CLOUD_UNKNOWN_REASON, upsell: false }
  // A room this computer holds stays operable whatever the account says now.
  if (status.room && status.room.phase !== 'closed') return { kind: 'available' }
  if (!status.entitled) {
    return status.plan
      ? { kind: 'locked', reason: GUESTS_CLOUD_NOT_YET_REASON, upsell: false }
      : { kind: 'locked', reason: GUESTS_PREMIUM_REASON, upsell: true }
  }
  if (status.allowance && !status.allowance.talkShows) {
    return status.plan === 'max'
      ? { kind: 'locked', reason: GUESTS_NOT_YET_REASON, upsell: false }
      : { kind: 'locked', reason: GUESTS_MAX_REASON, upsell: true }
  }
  return { kind: 'available' }
}

// --- Limits (D15) ------------------------------------------------------------

export type RoomLimits = { guestsOnStage: number; roomSize: number }

/** The room's limits while it is open, else the account's allowance. */
export function roomLimits(status: CloudStatus | null): RoomLimits | null {
  const limits = status?.room?.limits
  if (limits) return { guestsOnStage: limits.guestsOnStage, roomSize: limits.roomSize }
  const allowance = status?.allowance
  if (allowance?.guestsOnStage !== undefined && allowance.roomSize !== undefined) {
    return { guestsOnStage: allowance.guestsOnStage, roomSize: allowance.roomSize }
  }
  return null
}

/** "Up to 5 guests on stage, 10 people in the room.", or Premium's one seat. */
export function roomLimitsLine(limits: RoomLimits | null): string | null {
  if (!limits || limits.guestsOnStage <= 0) return null
  if (limits.guestsOnStage === 1) return GUESTS_PREMIUM_SEAT_LINE
  return `Up to ${plural(limits.guestsOnStage, 'guest')} on stage, ${plural(limits.roomSize, 'person', 'people')} in the room.`
}

// --- The room (C-G2, D17) ------------------------------------------------------

export const OPEN_THE_ROOM_LABEL = 'Open the room'
export const CLOSE_THE_ROOM_LABEL = 'Close the room'
export const ROOM_BACKSTAGE_TIME_LINE = 'Backstage time counts after 30 min'
export const DOOR_SWITCH_LABEL = 'Let anyone with the link in backstage'
export const DOOR_SWITCH_DESCRIPTION = 'Nobody reaches the stage without Bring on.'
export const OPEN_THE_ROOM_FIRST = 'Open the room first.'
/** The camera is the session's while it records or streams (D6). */
export const ROOM_WAITS_FOR_SESSION = 'The room opens once your recording or livestream ends.'
export const CLOSE_ROOM_CONFIRM_DESCRIPTION = 'Your guests leave and the recording finalizes.'
export const NEW_LINK_CONFIRM_DESCRIPTION =
  'Everyone keeps their place. The old link stops working.'
export const NEW_LINK_AFTER_BAN = 'New link. Share it again with your guests.'
export const NOBODY_YET = 'Nobody has joined yet. Share the link.'
export const ROOM_FULL_LINE = 'The room is full. New guests read “This show is full.”'

/** The room's state in a word, for the Room row and the Studio's Session row. */
export function roomPhaseLabel(room: CloudRoomStatus | undefined): string {
  switch (room?.phase) {
    case 'open':
      return 'Room open'
    case 'opening':
      return 'Opening the room…'
    case 'closing':
      return 'Closing the room…'
    default:
      return 'Room closed'
  }
}

/** Close the room asks first while anyone is in it, or the show runs (D17). */
export function closeRoomAsksFirst(status: CloudStatus | null): boolean {
  const room = status?.room
  if (!room || room.phase !== 'open') return false
  return (
    room.live ||
    Boolean(status?.recording?.active) ||
    (room.guests?.length ?? 0) > 0 ||
    (room.requests?.length ?? 0) > 0
  )
}

/** New link asks first while any guest is in the room (C-G2). */
export function newLinkAsksFirst(room: CloudRoomStatus | undefined): boolean {
  return (room?.guests?.length ?? 0) > 0
}

const joinWords = (words: readonly string[]): string =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`

/**
 * D13: the line a guest reads before "Ask to join", from the show's saved
 * destinations; before any is known, the short form.
 */
export function guestConsentLine(platforms: readonly string[] | undefined): string {
  const names = [...new Set((platforms ?? []).filter(Boolean))].map((platform) =>
    platformLabel(platform as StreamPlatform)
  )
  return names.length > 0
    ? `This show goes out live on ${joinWords(names)} and may be recorded. Your camera and voice are part of it.`
    : 'This show goes out live and may be recorded. Your camera and voice are part of it.'
}

// --- Requests (D4, D5) --------------------------------------------------------

/** "Ada wants to join". */
export function requestTitle(request: CloudRoomRequest): string {
  return `${request.name} wants to join`
}

export function requestDevice(request: CloudRoomRequest): string {
  return request.device === 'phone' ? 'On a phone' : 'On a computer'
}

/** D5: declined requests from the same browser come back as a count. */
export function declinedLine(count: number): string | null {
  return count > 0 ? `${count} more asked` : null
}

// --- People (C-G2, C-G3) ------------------------------------------------------

export type RoomPerson = {
  /** The LiveKit identity: `host:<showId>` or the guest id. */
  identity: string
  /** The guest id for `cloud.guest.act`; null for the host. */
  guestId: string | null
  /** As typed on the guest page (D5); "You" for the host. */
  name: string
  host: boolean
  onStage: boolean
  /** Null until the runner sees them in the room. */
  quality: CloudRoomQuality | null
  /** The host's hold on a guest's mic (D14); the host's own mute for the host. */
  muted: boolean
  screenShareAllowed: boolean
  sharingScreen: boolean
  /** On stage with no camera frame for 5 s (D12). */
  away: boolean
}

const RUNNER_PREFIX = 'runner:'

/**
 * Everyone in the room, the host first, then the stage in its order, then
 * backstage in the order they came in. The runner is never a person.
 */
export function roomPeople(
  room: CloudRoomStatus | undefined,
  hostIdentity: string | null
): RoomPerson[] {
  if (!room || room.phase === 'closed') return []
  const participants = (room.participants ?? []).filter(
    (participant) => !participant.identity.startsWith(RUNNER_PREFIX)
  )
  const onStage = room.stage.onStage
  const people: RoomPerson[] = []
  const hostParticipant =
    participants.find((participant) => participant.identity === hostIdentity) ??
    participants.find((participant) => participant.role === 'host')
  const host = hostIdentity ?? hostParticipant?.identity ?? null
  if (host) {
    people.push({
      identity: host,
      guestId: null,
      name: 'You',
      host: true,
      onStage: onStage.includes(host),
      quality: hostParticipant?.quality ?? null,
      muted: hostParticipant?.muted ?? false,
      screenShareAllowed: true,
      sharingScreen: hostParticipant?.screen ?? false,
      away: hostParticipant?.away ?? room.hostAway
    })
  }
  const seen = new Set(people.map((person) => person.identity))
  for (const guest of room.guests ?? []) {
    if (seen.has(guest.guestId)) continue
    seen.add(guest.guestId)
    const participant = participants.find((entry) => entry.identity === guest.guestId)
    people.push({
      identity: guest.guestId,
      guestId: guest.guestId,
      name: participant?.name || guest.name,
      host: false,
      onStage: onStage.includes(guest.guestId),
      quality: participant?.quality ?? null,
      muted: guest.muted,
      screenShareAllowed: guest.screenShareAllowed,
      sharingScreen: participant?.screen ?? false,
      away: participant?.away ?? false
    })
  }
  // A guest the runner sees before videorc.com lists them (a race).
  for (const participant of participants) {
    if (seen.has(participant.identity) || participant.role !== 'guest') continue
    seen.add(participant.identity)
    people.push({
      identity: participant.identity,
      guestId: participant.identity,
      name: participant.name,
      host: false,
      onStage: onStage.includes(participant.identity),
      quality: participant.quality,
      muted: participant.muted,
      screenShareAllowed: false,
      sharingScreen: participant.screen,
      away: participant.away
    })
  }
  const stageIndex = (person: RoomPerson): number => {
    const index = onStage.indexOf(person.identity)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  const hostRow = host ? people[0] : null
  const guests = host ? people.slice(1) : people
  const ordered = [
    ...guests.filter((person) => person.onStage).sort((a, b) => stageIndex(a) - stageIndex(b)),
    ...guests.filter((person) => !person.onStage)
  ]
  return hostRow ? [hostRow, ...ordered] : ordered
}

/** The connection as a dot and a word (quiet when fine on the strip). */
export function qualityStatus(quality: CloudRoomQuality | null): {
  tone: StatusTone
  label: string
} {
  switch (quality) {
    case 'excellent':
    case 'good':
      return { tone: 'good', label: 'Good connection' }
    case 'poor':
      return { tone: 'warn', label: 'Weak connection' }
    case 'lost':
      return { tone: 'error', label: 'Connection lost' }
    default:
      return { tone: 'neutral', label: 'Joining' }
  }
}

export function stageChipLabel(person: RoomPerson): string {
  return person.onStage ? 'On stage' : 'Backstage'
}

/** The room counts against its size: the host and every guest let in. */
export function roomIsFull(people: readonly RoomPerson[], limits: RoomLimits | null): boolean {
  return Boolean(limits && limits.roomSize > 0 && people.length >= limits.roomSize)
}

/** Why Bring on is off for a guest: the stage's seats are taken (D15). */
export function bringOnBlockedReason(
  people: readonly RoomPerson[],
  limits: RoomLimits | null
): string | null {
  if (!limits) return null
  const guestsOnStage = people.filter((person) => !person.host && person.onStage).length
  if (guestsOnStage < limits.guestsOnStage) return null
  return limits.guestsOnStage === 1
    ? GUESTS_PREMIUM_SEAT_LINE
    : `The stage is full: up to ${plural(limits.guestsOnStage, 'guest')} on stage.`
}

/** The Studio's Session row (D16): "Room open · 2 backstage". */
export function guestsSessionValue(
  room: CloudRoomStatus | undefined,
  people: readonly RoomPerson[]
): string {
  const parts = [roomPhaseLabel(room)]
  const guests = people.filter((person) => !person.host)
  const onStage = guests.filter((person) => person.onStage).length
  const backstage = guests.length - onStage
  if (onStage > 0) parts.push(`${onStage} on stage`)
  if (backstage > 0) parts.push(`${backstage} backstage`)
  const asking = room?.requests?.length ?? 0
  if (asking > 0) parts.push(asking === 1 ? '1 wants to join' : `${asking} want to join`)
  return parts.join(' · ')
}

// --- Stage controls (C-G3, D8) ------------------------------------------------

export const LAYOUT_LABELS: Record<CloudStageLayout, string> = {
  solo: 'Solo',
  'side-by-side': 'Side by side',
  'screen-people': 'Screen + people',
  spotlight: 'Spotlight'
}

export const SHARE_A_SCREEN_FIRST = 'Share a screen first'
export const SOLO_NEEDS_ONE = 'Solo shows one person. Send the others backstage first.'

export type LayoutOption = {
  value: CloudStageLayout
  label: string
  disabledReason: string | null
}

/** The four layout chips, each with its reason when it can't apply. */
export function layoutOptions(room: CloudRoomStatus | undefined): LayoutOption[] {
  const onStage = room?.stage.onStage.length ?? 0
  const screen = room?.stage.screen
  return (Object.keys(LAYOUT_LABELS) as CloudStageLayout[]).map((value) => ({
    value,
    label: LAYOUT_LABELS[value],
    disabledReason:
      value === 'screen-people' && !screen
        ? SHARE_A_SCREEN_FIRST
        : value === 'solo' && onStage > 1
          ? SOLO_NEEDS_ONE
          : null
  }))
}

/** One line under the chips: why each blocked layout waits. */
export function layoutReasonsLine(options: readonly LayoutOption[]): string | null {
  const reasons = options.flatMap((option) =>
    option.disabledReason === null
      ? []
      : option.value === 'screen-people'
        ? [`${option.disabledReason} for ${option.label}.`]
        : [option.disabledReason]
  )
  return reasons.length > 0 ? reasons.join(' ') : null
}

/**
 * The layout the stage shows: the runner's own fallbacks applied (D8), on the
 * stage as the program draws it (review M2: a stale screen is Side by side).
 */
export function shownLayout(room: CloudRoomStatus | undefined): CloudStageLayout {
  if (!room) return 'solo'
  return effectiveStageLayout(showStageInput(room))
}

// --- Moderation (D5, D14) ------------------------------------------------------

export const GUEST_NAME_MAX_CHARS = 32

/** A rename's new name: trimmed, 1 to 32 characters, and changed; else null. */
export function renamedGuestName(current: string, next: string): string | null {
  const trimmed = next.trim()
  if (trimmed.length === 0 || trimmed.length > GUEST_NAME_MAX_CHARS) return null
  return trimmed === current ? null : trimmed
}

export function removeGuestCopy(name: string): {
  title: string
  description: string
  confirm: string
} {
  return {
    title: `Remove ${name}?`,
    description: `${name} leaves the show. The link still works for everyone else.`,
    confirm: `Remove ${name}`
  }
}

export function banGuestCopy(name: string): {
  title: string
  description: string
  confirm: string
} {
  return {
    title: `Ban ${name}?`,
    description: `${name} leaves the show and can't ask to join again. The link changes, so share the new one with your guests.`,
    confirm: `Ban ${name}`
  }
}
