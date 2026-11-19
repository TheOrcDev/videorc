import type { ReactElement } from 'react'

import { NotificationBell } from '@/components/notifications/notification-bell'
import { useNotificationAnnouncement, useNotificationCount } from '@/lib/notification-count'
import { shortcutAccelerator } from '@/lib/shortcuts'

const loadList = () => import('@/components/notifications/main-notification-center')

/** The main window's bell, at the right end of its status bar (plan 250, D1). */
export function MainNotificationBell({ platform }: { platform?: string }): ReactElement {
  return (
    <NotificationBell
      accelerator={shortcutAccelerator('notifications')}
      announcement={useNotificationAnnouncement()}
      count={useNotificationCount()}
      load={loadList}
      platform={platform}
    />
  )
}
