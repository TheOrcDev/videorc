import type { StreamTargetRuntime, StreamTargetState } from '@/lib/backend'
import type { NotifyOnceKind } from '@/lib/notify-once'
import { destinationLabel } from '@/lib/platform-copy'

export type StreamTargetNotice = {
  key: string
  kind: NotifyOnceKind
  title: string
  description: string
}

/**
 * What still reaches viewers while one destination is down (plan 174 J2-19):
 * the other destinations on air, counted. Null when there is no other one,
 * so "The other destinations keep streaming." is never said to a streamer
 * with one destination.
 */
export function otherDestinationsLine(othersOnAir: number): string | null {
  if (othersOnAir <= 0) return null
  return othersOnAir === 1
    ? 'The other destination keeps streaming.'
    : `The other ${othersOnAir} destinations keep streaming.`
}

/** How many destinations besides `targetId` are on air in this snapshot. */
export function otherDestinationsOnAir(
  targets: readonly Pick<StreamTargetRuntime, 'targetId' | 'state'>[],
  targetId: string
): number {
  return targets.filter((target) => target.targetId !== targetId && target.state === 'live').length
}

/** A destination going on air after one of these states is "{X} is back". */
const BACK_AFTER: ReadonlySet<StreamTargetState> = new Set(['reconnecting', 'warning', 'failed'])

/**
 * The toasts one `stream.targets` snapshot deserves, given each destination's
 * previous state (plan 161). A destination is news when it stops, starts
 * reconnecting, its platform stops receiving it, or it comes back. Every
 * notice for one destination shares one key, so "{X} is back" replaces
 * "Streaming to {X} stopped", "is reconnecting" or "isn't receiving" in place
 * instead of stacking (plan 174 S2.3a, after S2.4's one toast id).
 */
export function streamTargetNotices(
  previous: ReadonlyMap<string, StreamTargetState>,
  targets: readonly StreamTargetRuntime[]
): StreamTargetNotice[] {
  const notices: StreamTargetNotice[] = []
  for (const target of targets) {
    const before = previous.get(target.targetId)
    if (before === target.state) continue
    const leg = `stream-target:${target.targetId}`
    const label = destinationLabel(target.label)
    const others = otherDestinationsLine(otherDestinationsOnAir(targets, target.targetId))
    switch (target.state) {
      case 'failed':
        notices.push({
          key: leg,
          kind: 'error',
          title: `Streaming to ${label} stopped`,
          description:
            target.message ?? others ?? 'No other destination is streaming, so viewers see nothing.'
        })
        break
      case 'reconnecting':
        notices.push({
          key: leg,
          kind: 'warning',
          title: `${label} is reconnecting`,
          description: others
            ? `Viewers there see nothing until it's back. ${others}`
            : "Viewers see nothing until it's back."
        })
        break
      case 'warning':
        notices.push({
          key: leg,
          kind: 'warning',
          title: `${label} isn't receiving your stream`,
          description: 'Videorc is still sending it. Check the platform’s live dashboard.'
        })
        break
      case 'live':
        if (before !== undefined && BACK_AFTER.has(before)) {
          notices.push({
            key: leg,
            kind: 'success',
            title: `${label} is back`,
            description: `Streaming to ${label} resumed.`
          })
        }
        break
      default:
        break
    }
  }
  return notices
}
