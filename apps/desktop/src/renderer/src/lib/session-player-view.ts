// Pure view logic for the session player (plan 119, S11; plan 174 S3.12):
// time labels, grant renewal timing, keyboard mapping, where marker pins sit
// over the scrubber, and the copy for every refusal. No DOM and no React
// here, so the component never re-implements what the tests cover.

import type { SessionMarker, SessionMediaGrantRefusal } from '@/lib/backend'
import { formatTimecode } from '@/lib/format-time'

/** Renew a grant this long before it expires. */
export const SESSION_MEDIA_RENEW_LEAD_MS = 60_000
/** Never schedule a renewal sooner than this, even for a grant about to expire. */
export const SESSION_MEDIA_RENEW_MIN_DELAY_MS = 5_000
/** Arrow keys move the playhead by this much. */
export const PLAYER_SEEK_STEP_MS = 5_000
/** J and L jump by this much (the video players' convention). */
export const PLAYER_JUMP_STEP_MS = 10_000
/** The scrubber's resolution. */
export const PLAYER_SCRUB_STEP_MS = 100

const HOUR_MS = 3_600_000

/** When to renew a grant that expires at `expiresAt`, relative to now. */
export function grantRenewalDelayMs(expiresAt: number, nowMs: number): number {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs)) {
    return SESSION_MEDIA_RENEW_LEAD_MS
  }
  return Math.max(SESSION_MEDIA_RENEW_MIN_DELAY_MS, expiresAt - nowMs - SESSION_MEDIA_RENEW_LEAD_MS)
}

/** Recordings of an hour or more show hours on both the playhead and the duration. */
export function mediaTimeHasHours(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= HOUR_MS
}

/**
 * The one timecode (plan 174 S1.4, E-20): `m:ss`, or `h:mm:ss` from an hour
 * and whenever `withHours`; negative, NaN and infinite times read as zero.
 */
export function formatMediaTime(ms: number, withHours: boolean): string {
  return formatTimecode(ms, { withHours })
}

/**
 * The scrubber's spoken value (plan 174 S0.5, E-3): "2:05 of 41:10", the
 * screen's times without the leading zero, never raw milliseconds.
 */
export function playheadValueText(positionMs: number, durationMs: number): string {
  const withHours = mediaTimeHasHours(durationMs)
  return `${formatMediaTime(positionMs, withHours)} of ${formatMediaTime(durationMs, withHours)}`
}

/** Keeps a seek inside the recording. Unknown durations clamp at zero only. */
export function clampSeekMs(ms: number, durationMs: number): number {
  if (!Number.isFinite(ms)) return 0
  const upper =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY
  return Math.min(Math.max(0, ms), upper)
}

export type PlayerKeyAction =
  | 'toggle'
  | 'seek-back'
  | 'seek-forward'
  | 'jump-back'
  | 'jump-forward'
  | 'start'
  | 'end'
  | 'mute'

export type PlayerKeyTarget = { tagName?: string; role?: string | null } | null

export type PlayerKeyModifiers = { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }

const PLAYER_LETTER_KEYS: Readonly<Record<string, PlayerKeyAction>> = {
  k: 'toggle',
  j: 'jump-back',
  l: 'jump-forward',
  m: 'mute'
}

/**
 * The player's keys, only while it has focus (plan 174 S3.12, E-30): Space
 * and K toggle, the arrows seek 5 s, J and L jump 10 s, Home and End go to
 * the start and the end, M mutes. A key with ⌘, Ctrl or ⌥ is never the
 * player's (⌘K is Search). Space is left to a focused button (its own click
 * already toggles, so handling it twice would undo it), and the arrows, Home
 * and End to the focused scrubber thumb, which steps itself.
 */
export function playerKeyAction(
  key: string,
  target: PlayerKeyTarget,
  modifiers: PlayerKeyModifiers = {}
): PlayerKeyAction | null {
  if (modifiers.metaKey || modifiers.ctrlKey || modifiers.altKey) return null
  const tag = target?.tagName?.toUpperCase()
  const onSlider = target?.role === 'slider'
  if (key === ' ' || key === 'Spacebar') {
    return tag === 'BUTTON' ? null : 'toggle'
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (onSlider) return null
    return key === 'ArrowLeft' ? 'seek-back' : 'seek-forward'
  }
  if (key === 'Home' || key === 'End') {
    if (onSlider) return null
    return key === 'Home' ? 'start' : 'end'
  }
  return PLAYER_LETTER_KEYS[key.toLowerCase()] ?? null
}

/** Where a key sends the playhead, or null for a key that doesn't seek. */
export function playerKeyTargetMs(
  action: PlayerKeyAction,
  currentMs: number,
  durationMs: number
): number | null {
  switch (action) {
    case 'seek-back':
      return currentMs - PLAYER_SEEK_STEP_MS
    case 'seek-forward':
      return currentMs + PLAYER_SEEK_STEP_MS
    case 'jump-back':
      return currentMs - PLAYER_JUMP_STEP_MS
    case 'jump-forward':
      return currentMs + PLAYER_JUMP_STEP_MS
    case 'start':
      return 0
    case 'end':
      return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null
    default:
      return null
  }
}

// --- Marker pins (plan 174 S3.12, E-7) -----------------------------------------

/** The scrubber thumb's width: its centre runs from half of it to the track's width less half. */
export const PLAYHEAD_THUMB_PX = 16
/** A pin's hit area; pins closer than this share one chooser. */
export const MARKER_PIN_HIT_PX = 24

function fractionOf(atSeconds: number, durationMs: number): number {
  const fraction = (atSeconds * 1000) / durationMs
  return Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
}

/**
 * A pin's `left` over the scrubber: exactly under the thumb's centre at that
 * time, so a pin and the playhead line up (the thumb stays inside the track,
 * so its centre runs from 8 px to the width less 8 px).
 */
export function markerPinLeft(fraction: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  const percent = Math.round(clamped * 100_000) / 1000
  const offset = Math.round((PLAYHEAD_THUMB_PX / 2 - PLAYHEAD_THUMB_PX * clamped) * 1000) / 1000
  return `calc(${percent}% + ${offset}px)`
}

export interface MarkerPinGroup<T> {
  /** The first marker's id: stable while the markers don't move. */
  key: string
  markers: T[]
  /** Where the pin sits, 0..1 of the recording: the group's middle. */
  fraction: number
}

/**
 * Pins in time order, with pins closer than one hit area merged into one
 * group (a chooser). Nothing until the duration is known, so pins never pile
 * up at the end while the recording loads.
 */
export function groupMarkerPins<T extends Pick<SessionMarker, 'id' | 'atSeconds'>>(
  markers: readonly T[],
  durationMs: number,
  trackWidthPx: number
): MarkerPinGroup<T>[] {
  if (!(durationMs > 0) || markers.length === 0) return []
  const usablePx = Math.max(1, trackWidthPx - PLAYHEAD_THUMB_PX)
  const sorted = [...markers].sort((left, right) => left.atSeconds - right.atSeconds)
  const groups: { markers: T[]; startPx: number; first: number; last: number }[] = []
  for (const marker of sorted) {
    const fraction = fractionOf(marker.atSeconds, durationMs)
    const px = fraction * usablePx
    const open = groups.at(-1)
    if (open && px - open.startPx < MARKER_PIN_HIT_PX) {
      open.markers.push(marker)
      open.last = fraction
    } else {
      groups.push({ markers: [marker], startPx: px, first: fraction, last: fraction })
    }
  }
  return groups.map((group) => ({
    key: group.markers[0].id,
    markers: group.markers,
    fraction: (group.first + group.last) / 2
  }))
}

/** How a marker was made, in a word: said to Buddy, or typed. */
export function markerSourceLabel(source: SessionMarker['source']): string {
  return source === 'voice' ? 'Voice' : 'Typed'
}

/** Why a grant was refused, in the player's own words. */
export function sessionMediaRefusalCopy(error: SessionMediaGrantRefusal): {
  title: string
  description: string
} {
  switch (error) {
    case 'not-found':
      return {
        title: 'Recording file missing',
        description: "The file for this recording isn't where Videorc saved it."
      }
    case 'not-mp4':
      return {
        title: 'Not playable here',
        description: 'Only MP4 recordings play in Videorc.'
      }
    case 'not-ready':
      return {
        title: 'Still finalizing',
        description: 'Playback opens as soon as the recording is finished.'
      }
  }
}

/** What a `<video>` error means to the person watching. */
export function mediaErrorCopy(code: number | null | undefined): string {
  switch (code) {
    case 1:
      return 'Playback was interrupted.'
    case 2:
      return "The recording couldn't be read."
    case 3:
      return "This recording couldn't be decoded."
    case 4:
      return "This recording can't play here."
    default:
      return 'Playback failed.'
  }
}
