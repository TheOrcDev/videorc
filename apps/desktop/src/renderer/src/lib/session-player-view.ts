// Pure view logic for the session player (plan 119, S11): time labels, grant
// renewal timing, keyboard mapping and the copy for every refusal. No DOM and
// no React here, so the component never re-implements what the tests cover.

import type { SessionMediaGrantRefusal } from '@/lib/backend'

/** Renew a grant this long before it expires. */
export const SESSION_MEDIA_RENEW_LEAD_MS = 60_000
/** Never schedule a renewal sooner than this, even for a grant about to expire. */
export const SESSION_MEDIA_RENEW_MIN_DELAY_MS = 5_000
/** Arrow keys move the playhead by this much. */
export const PLAYER_SEEK_STEP_MS = 5_000
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

/** `mm:ss`, or `h:mm:ss` when `withHours`; negative, NaN and infinite times read as zero. */
export function formatMediaTime(ms: number, withHours: boolean): string {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % (withHours ? 60 : Number.POSITIVE_INFINITY)
  const hours = Math.floor(totalSeconds / 3600)
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return withHours ? `${hours}:${mmss}` : mmss
}

/** Keeps a seek inside the recording. Unknown durations clamp at zero only. */
export function clampSeekMs(ms: number, durationMs: number): number {
  if (!Number.isFinite(ms)) return 0
  const upper =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY
  return Math.min(Math.max(0, ms), upper)
}

export type PlayerKeyAction = 'toggle' | 'seek-back' | 'seek-forward'

export type PlayerKeyTarget = { tagName?: string; role?: string | null } | null

/**
 * Space toggles, the arrows seek. Space is left to a focused button (its own
 * click already toggles, so handling it twice would undo it), and the arrows
 * are left to the focused scrubber thumb, which steps itself.
 */
export function playerKeyAction(key: string, target: PlayerKeyTarget): PlayerKeyAction | null {
  const tag = target?.tagName?.toUpperCase()
  if (key === ' ' || key === 'Spacebar') {
    return tag === 'BUTTON' ? null : 'toggle'
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (target?.role === 'slider') return null
    return key === 'ArrowLeft' ? 'seek-back' : 'seek-forward'
  }
  return null
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
        description: 'The file for this recording is not where Videorc saved it.'
      }
    case 'not-mp4':
      return {
        title: 'Not playable here',
        description: 'Only MP4 recordings play in Videorc. Open this one in your video player.'
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
      return 'The recording could not be read.'
    case 3:
      return 'This recording could not be decoded.'
    case 4:
      return 'This recording cannot be played here.'
    default:
      return 'Playback failed.'
  }
}
