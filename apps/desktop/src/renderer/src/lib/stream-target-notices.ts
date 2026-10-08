import type { StreamTargetRuntime, StreamTargetState } from '@/lib/backend'
import type { NotifyOnceKind } from '@/lib/notify-once'

export type StreamTargetNotice = {
  key: string
  kind: NotifyOnceKind
  title: string
  description: string
}

/**
 * The toasts one `stream.targets` snapshot deserves, given each destination's
 * previous state (plan 161). A destination is news when it stops, starts
 * reconnecting, its platform stops receiving it, or it comes back. The
 * reconnect, not-receiving and back notices share one key per destination,
 * so "is back" replaces "is reconnecting" in place instead of stacking.
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
    switch (target.state) {
      case 'failed':
        notices.push({
          key: `stream-target-failed:${target.targetId}`,
          kind: 'error',
          title: `Streaming to ${target.label} stopped`,
          description: target.message ?? 'The other destinations keep streaming.'
        })
        break
      case 'reconnecting':
        notices.push({
          key: leg,
          kind: 'warning',
          title: `${target.label} is reconnecting`,
          description:
            'Viewers there see nothing until it is back. The other destinations keep streaming.'
        })
        break
      case 'warning':
        notices.push({
          key: leg,
          kind: 'warning',
          title: `${target.label} isn't receiving your stream`,
          description: 'Videorc is still sending it. Check the platform’s live dashboard.'
        })
        break
      case 'live':
        if (before === 'reconnecting' || before === 'warning') {
          notices.push({
            key: leg,
            kind: 'success',
            title: `${target.label} is back`,
            description: `Streaming to ${target.label} resumed.`
          })
        }
        break
      default:
        break
    }
  }
  return notices
}
