import type { AudioTrack, HealthEvent } from '@/lib/backend'

// System audio session facts (plan 069 S5) the Studio provider derives. The
// provider sits in the eager chunk, so this module stays tiny; the switch's
// view logic lives in lib/system-audio, which only lazy surfaces import.

export const SYSTEM_AUDIO_LOST_CODE = 'system-audio-lost'
export const SYSTEM_AUDIO_UNAVAILABLE_CODE = 'system-audio-unavailable'

export type SystemAudioIssue = 'lost' | 'unavailable' | 'bypassed' | 'echo'

/**
 * What the running session actually mixes, from `recording.status`:
 * `true`/`false` once a track reports its `mixSources`, `null` while no track
 * does (a backend that predates plan 069, or no session). Null means "not
 * reported", and callers fall back to the requested state.
 */
export function confirmedSystemAudioMix(tracks: AudioTrack[] | undefined): boolean | null {
  const reporting = (tracks ?? []).filter((track) => Array.isArray(track.mixSources))
  if (reporting.length === 0) return null
  return reporting.some((track) => track.mixSources?.includes('system-audio') === true)
}

/**
 * Whether a running session still brings up the System audio it started
 * with. A session opens its capture on its own thread after the bus starts
 * (about half a second on macOS), so its first statuses mix the microphone
 * only. That is the capture opening, not the switch turning Off: until the
 * session first mixes System audio, the switch keeps showing the request. A
 * toggle during the session (the request changes) or an issue ends it, and
 * the switch shows what the session confirms again (plan 069's live rule).
 */
export type SystemAudioJoin = Readonly<{
  sessionId: string
  /** The request when the session was first seen. */
  requested: boolean
  /** The session mixed System audio, the request changed, or an issue came. */
  settled: boolean
}>

/** The next join state; the same object while nothing changes. */
export function nextSystemAudioJoin(
  current: SystemAudioJoin | null,
  session: {
    /** The mixing session, or null while no bus runs. */
    sessionId: string | null
    requested: boolean
    confirmed: boolean | null
    issue: boolean
  }
): SystemAudioJoin | null {
  if (!session.sessionId) return null
  const settles = session.confirmed === true || session.issue
  if (current?.sessionId !== session.sessionId) {
    return { sessionId: session.sessionId, requested: session.requested, settled: settles }
  }
  return current.settled || (!settles && session.requested === current.requested)
    ? current
    : { ...current, settled: true }
}

/** True while the session has not yet mixed the System audio it was asked for. */
export function systemAudioJoining(
  join: SystemAudioJoin | null,
  requested: boolean,
  confirmed: boolean | null
): boolean {
  return join !== null && !join.settled && requested && confirmed === false
}

/**
 * A system-audio health event, reduced to the one fact the UI shows. The
 * Windows bypass (plan 069 S8: the mic fell back to a direct input, so the
 * session cannot mix system audio) is inlined to keep the eager chunk small.
 */
export function systemAudioIssueFromHealthEvent({
  code
}: Pick<HealthEvent, 'code'>): SystemAudioIssue | null {
  // Every code is `system-audio-<suffix>`; the suffix lookup keeps this small.
  const suffix = code.startsWith('system-audio-') ? code.slice(13) : ''
  return suffix === 'mic-fallback-bypass'
    ? 'bypassed'
    : suffix === 'echo-paused'
      ? 'echo'
      : suffix === 'lost' || suffix === 'unavailable'
        ? suffix
        : null
}
