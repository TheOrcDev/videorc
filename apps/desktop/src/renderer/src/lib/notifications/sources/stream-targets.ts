// Plan 250 S6: a destination is one notification. `streamTargetNotices`
// (pure, `lib/stream-target-notices.ts`) still decides what is news; this
// publishes it on the destination's subject, where the watchdog's
// `destination-down` alert also lands, and "{X} is back" resolves it.

import { notifications } from '@/lib/notifications'
import { CURRENT_SESSION } from '@/lib/notifications/sources/health'
import type { NotificationStore } from '@/lib/notifications/store'
import { openDestinations } from '@/lib/section-doors'
import type { StreamTargetNotice } from '@/lib/stream-target-notices'

export const STREAM_TARGETS_SOURCE = 'stream-targets'

export function publishStreamTargetNotice(
  store: NotificationStore,
  notice: StreamTargetNotice
): void {
  if (notice.kind === 'success') {
    store.resolve(notice.key, {
      source: STREAM_TARGETS_SOURCE,
      title: notice.title,
      was: 'It was down'
    })
    return
  }
  store.publish({
    key: notice.key,
    kind: 'stream-target',
    source: STREAM_TARGETS_SOURCE,
    // Nobody else is on air: viewers see nothing right now.
    ...(notice.urgent ? { tone: 'urgent' as const } : {}),
    title: notice.title,
    detail: notice.description,
    actions: [
      {
        id: 'open-destinations',
        label: 'Open Destinations',
        kind: 'door',
        run: () => openDestinations(notice.targetId)
      }
    ],
    sessionId: CURRENT_SESSION
  })
}

/** The Studio hands every notice of one `stream.targets` snapshot here. */
export function publishStreamTargetNotices(notices: readonly StreamTargetNotice[]): void {
  for (const notice of notices) publishStreamTargetNotice(notifications, notice)
}
