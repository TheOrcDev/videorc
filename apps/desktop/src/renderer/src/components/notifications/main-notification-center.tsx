import type { ReactElement } from 'react'

import type { NotificationBellListProps } from '@/components/notifications/notification-bell'
import { NotificationCenter } from '@/components/notifications/notification-center'
import { notifications } from '@/lib/notifications'

/** The main window's list: the store itself, in the list's own chunk. */
export default function MainNotificationCenter({
  onClose
}: NotificationBellListProps): ReactElement {
  return <NotificationCenter source={notifications} onClose={onClose} />
}
