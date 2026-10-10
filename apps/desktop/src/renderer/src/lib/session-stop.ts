// Ending a session takes intent (plan 174 S0.1, owner decisions D1, D2, D19).
// Pure: no React, no DOM, so it runs under the node vitest runner. The studio
// provider asks `stopDecision` before every stop; the answer says whether the
// stop runs now, waits for the End livestream dialog, or arms a global hotkey
// for a second press.

/** Where a stop request came from. */
export type SessionStopOrigin =
  | 'button'
  | 'space'
  | 'palette'
  | 'global-hotkey'
  | 'remote-control'
  | 'phone-remote'
  | 'failure-banner'

export type SessionStopDecision = 'stop' | 'confirm' | 'arm'

/** What the studio provider holds while the End livestream dialog waits. */
export interface SessionStopConfirmation {
  origin: SessionStopOrigin
  /** The session the question is about; a later session never inherits it. */
  sessionId: string | null
  /** The destinations the session streams to, by label. */
  platforms: readonly string[]
  /** Whether a local recording stops with the livestream (D19). */
  alsoRecords: boolean
}

/** A second global-hotkey press inside this window ends the livestream. */
export const END_LIVESTREAM_ARM_WINDOW_MS = 2000

/** The one keyed toast for an armed hotkey (plain: no success icon). */
export const END_LIVESTREAM_ARMED_TOAST = 'Press again to end the livestream'
export const END_LIVESTREAM_ARMED_TOAST_ID = 'end-livestream-armed'

/** The End livestream dialog's copy. */
export const END_LIVESTREAM_TITLE = 'End livestream?'
export const KEEP_STREAMING_LABEL = 'Keep streaming'
export const END_LIVESTREAM_LABEL = 'End livestream'
/** D19: Go Live and Stop are one session, said where the control is. */
export const RECORDING_STOPS_TOO = 'Your recording stops too.'

/**
 * What a stop request does.
 *
 * - A recording that is not live stops at once from every origin.
 * - While live, an in-app stop (the button, Space, the palette, the failure
 *   banner) asks first.
 * - A global hotkey arms on the first press and stops on a second press
 *   within `END_LIVESTREAM_ARM_WINDOW_MS`; an expired arm starts over.
 * - Stream Deck and phone intents are deliberate device actions (the phone
 *   already holds to stop), so they keep their contract and stop at once.
 */
export function stopDecision({
  origin,
  live,
  armedAt,
  now
}: {
  origin: SessionStopOrigin
  live: boolean
  /** When the hotkey was last armed, or null. */
  armedAt: number | null
  now: number
}): SessionStopDecision {
  if (!live) {
    return 'stop'
  }
  switch (origin) {
    case 'remote-control':
    case 'phone-remote':
      return 'stop'
    case 'global-hotkey':
      return armedAt !== null && now >= armedAt && now - armedAt <= END_LIVESTREAM_ARM_WINDOW_MS
        ? 'stop'
        : 'arm'
    default:
      return 'confirm'
  }
}

/** "Twitch", "Twitch and YouTube", "Twitch, YouTube and Kick". */
export function listNames(names: readonly string[]): string {
  const cleaned = names.map((name) => name.trim()).filter((name) => name.length > 0)
  if (cleaned.length <= 1) {
    return cleaned[0] ?? ''
  }
  if (cleaned.length === 2) {
    return `${cleaned[0]} and ${cleaned[1]}`
  }
  return `${cleaned.slice(0, -1).join(', ')} and ${cleaned.at(-1)}`
}

/** The dialog body: who is disconnected, and what happens to the recording. */
export function endLivestreamBody({
  platforms,
  alsoRecords
}: {
  /** The destinations the session streams to, by their labels. */
  platforms: readonly string[]
  /** Whether the session also writes a local recording (Go Live's default). */
  alsoRecords: boolean
}): string {
  const names = listNames(platforms)
  const audience = names
    ? `Viewers on ${names} are disconnected.`
    : 'Your viewers are disconnected.'
  return alsoRecords
    ? `${audience} Your recording stops too and is saved to the Library.`
    : audience
}
