// What the Studio's Session section says while on air (plan 174 S3.2, B-4):
// the destinations as one quiet fact when all is well and one row per
// problem when not, and one Stream health fact from the same classifier the
// Livestream page uses. Pure, so the derivations run under the node vitest
// runner; the words are the glossary's (destination, on air, Stopped).

import type { StreamTargetRuntime, WatchdogAlert } from '@/lib/backend'
import { formatCloudCountdown } from './cloud-toasts'
import { watchdogChipLabel } from './watchdog-rank'
import { cloudPhaseLabel, destinationStateLabel } from './state-labels'
import { liveProblemLabel, type StreamHealthAttribution } from './stream-health-attribution'

import type { LiveDashboardCloud } from '../../../shared/live-dashboard'

/** The upload legs to Videorc Cloud: recording.rs `CLOUD_FEED_TARGET_PREFIX`. */
export const CLOUD_FEED_TARGET_PREFIX = 'videorc-cloud-'

export function isCloudFeedTarget(target: Pick<StreamTargetRuntime, 'targetId'>): boolean {
  return target.targetId.startsWith(CLOUD_FEED_TARGET_PREFIX)
}

/**
 * The cloud show's own word while it carries the session (plan 184 C7):
 * "Be right back · 28 min left" while viewers see the hold card, "Cloud
 * resuming" while the feed comes back, else nothing and the stages speak.
 * It outranks the upload's own reconnecting row: the show is on air.
 */
export function cloudStreamReading(cloud: LiveDashboardCloud | null | undefined): string | null {
  if (cloud?.phase === 'hold') {
    const left = cloud.holdRemainingSeconds
    return typeof left === 'number'
      ? `Be right back · ${formatCloudCountdown(left)} left`
      : 'Be right back'
  }
  if (cloud?.phase === 'resuming') return 'Cloud resuming'
  return null
}

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
 * Through Videorc Cloud the upload legs are this computer's feed, not
 * destinations: one "Videorc Cloud" row stands for them, with the show's
 * state, and only while the show is not simply on air.
 */
export function cloudDestinationProblem(
  cloud: LiveDashboardCloud,
  feed: Pick<StreamTargetRuntime, 'targetId'> | undefined
): LiveDestinationProblem | null {
  const row = (word: string, tone: 'warn' | 'error'): LiveDestinationProblem => ({
    targetId: feed?.targetId ?? CLOUD_FEED_TARGET_PREFIX.replace(/-$/, ''),
    label: 'Videorc Cloud',
    word,
    tone
  })
  switch (cloud.phase) {
    case 'live':
      return null
    // The countdown is the Stream row's (streamHealthFact), right below:
    // said twice, the long value squeezed both labels to "Vi…" and "S…"
    // (plan 222 U6, by eye).
    case 'hold':
      return row('Be right back', 'warn')
    case 'failed':
      return row(cloudPhaseLabel(cloud.phase), 'error')
    default:
      return row(cloudPhaseLabel(cloud.phase), 'warn')
  }
}

/**
 * The Destinations group: "3 of 3 on air" when every leg is live, else the
 * same count with one row per problem. Null before the backend has reported
 * the session's destinations, and for a session that streams nowhere.
 * Through the cloud (plan 184 C7) the platforms are the runner's legs, so
 * the count is theirs; the feed legs fold into one Videorc Cloud row.
 */
export function liveDestinationsView(
  targets: readonly StreamTargetRuntime[],
  cloud: LiveDashboardCloud | null = null
): LiveDestinationsView | null {
  const destinations = cloud ? targets.filter((target) => !isCloudFeedTarget(target)) : targets
  const counted = destinations.filter((target) => target.state !== 'not-configured')
  if (counted.length === 0) {
    return null
  }
  const onAir = counted.filter((target) => target.state === 'live').length
  const summary = `${onAir} of ${counted.length} on air`
  const cloudProblem = cloud
    ? cloudDestinationProblem(cloud, targets.find(isCloudFeedTarget))
    : null
  const problems = [
    ...(cloudProblem ? [cloudProblem] : []),
    ...counted.flatMap((target) => {
      const problem = liveDestinationProblem(target)
      return problem ? [problem] : []
    })
  ]
  return problems.length > 0 ? { kind: 'problems', summary, problems } : { kind: 'quiet', summary }
}

export type StreamHealthFact = {
  label: string
  tone: 'good' | 'warn' | 'neutral'
}

/**
 * The one "Stream" fact: a quiet "Healthy" dot when the stages are fine, the
 * earliest failing stage in a few words when not, and "Checking…" before the
 * diagnostics have said anything (never an unmeasured verdict). While
 * Videorc Cloud holds or resumes the show, that is the fact (plan 184 C7).
 */
export function streamHealthFact(
  attribution: StreamHealthAttribution,
  cloud: LiveDashboardCloud | null = null,
  alert: Pick<WatchdogAlert, 'check' | 'title' | 'targetId'> | null = null
): StreamHealthFact {
  // Plan 223 A5: the top open watchdog alert outranks every stage; it is
  // what viewers see, in a few words.
  if (alert) {
    return { label: watchdogChipLabel(alert), tone: 'warn' }
  }
  const reading = cloudStreamReading(cloud)
  if (reading) {
    return { label: reading, tone: 'warn' }
  }
  if (attribution === 'healthy') {
    return { label: 'Healthy', tone: 'good' }
  }
  if (attribution === 'unknown') {
    return { label: liveProblemLabel(attribution), tone: 'neutral' }
  }
  return { label: liveProblemLabel(attribution), tone: 'warn' }
}
