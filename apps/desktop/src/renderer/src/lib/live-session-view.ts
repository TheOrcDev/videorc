// What the Studio's Session section says while on air (plan 174 S3.2, B-4):
// the destinations as one quiet fact when all is well and one row per
// problem when not, and one Stream health fact from the same classifier the
// Livestream page uses. Pure, so the derivations run under the node vitest
// runner; the words are the glossary's (destination, on air, Stopped).

import type { StreamTargetRuntime } from '@/lib/backend'
import { destinationStateLabel } from './state-labels'
import { liveProblemLabel, type StreamHealthAttribution } from './stream-health-attribution'

export type LiveDestinationProblem = {
  targetId: string
  /** The destination's own label ("Twitch"). */
  label: string
  /** The one status word, in sentence case. */
  word: string
  tone: 'warn' | 'error'
}

export type LiveDestinationsView =
  | { kind: 'quiet'; summary: string }
  | { kind: 'problems'; summary: string; problems: LiveDestinationProblem[] }

/**
 * The destination that needs the streamer, or null while it is fine, in the
 * one word every surface uses for that state (plan 174 S2.3a): "Failed",
 * "Ended", "Reconnecting…", "Not receiving".
 */
export function liveDestinationProblem(target: StreamTargetRuntime): LiveDestinationProblem | null {
  const word = destinationStateLabel(target.state)
  switch (target.state) {
    case 'failed':
    case 'stopped':
      return { targetId: target.targetId, label: target.label, word, tone: 'error' }
    case 'reconnecting':
    case 'warning':
      return { targetId: target.targetId, label: target.label, word, tone: 'warn' }
    default:
      return null
  }
}

/**
 * The Destinations group: "3 of 3 on air" when every leg is live, else the
 * same count with one row per problem. Null before the backend has reported
 * the session's destinations, and for a session that streams nowhere.
 */
export function liveDestinationsView(
  targets: readonly StreamTargetRuntime[]
): LiveDestinationsView | null {
  const counted = targets.filter((target) => target.state !== 'not-configured')
  if (counted.length === 0) {
    return null
  }
  const onAir = counted.filter((target) => target.state === 'live').length
  const summary = `${onAir} of ${counted.length} on air`
  const problems = counted.flatMap((target) => {
    const problem = liveDestinationProblem(target)
    return problem ? [problem] : []
  })
  return problems.length > 0 ? { kind: 'problems', summary, problems } : { kind: 'quiet', summary }
}

export type StreamHealthFact = {
  label: string
  tone: 'good' | 'warn' | 'neutral'
}

/**
 * The one "Stream" fact: a quiet "Healthy" dot when the stages are fine, the
 * earliest failing stage in a few words when not, and "Checking…" before the
 * diagnostics have said anything (never an unmeasured verdict).
 */
export function streamHealthFact(attribution: StreamHealthAttribution): StreamHealthFact {
  if (attribution === 'healthy') {
    return { label: 'Healthy', tone: 'good' }
  }
  if (attribution === 'unknown') {
    return { label: liveProblemLabel(attribution), tone: 'neutral' }
  }
  return { label: liveProblemLabel(attribution), tone: 'warn' }
}
