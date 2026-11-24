import type { ReactElement } from 'react'

import type { NotificationBellListProps } from '@/components/notifications/notification-bell'
import { NotificationCenter } from '@/components/notifications/notification-center'
import { NotificationPopover } from '@/components/notifications/notification-popover'
import { streamManagerNotificationSource } from '@/lib/stream-manager-notifications'

/**
 * The Stream Manager's list (plan 250 S8): the same list, read from the
 * main window's copy. A door pressed here brings the main window forward on
 * the page it opens.
 */
export default function StreamManagerNotificationCenter({
  open,
  onOpenChange,
  trigger,
  anchor
}: NotificationBellListProps): ReactElement {
  const onClose = (): void => onOpenChange(false)
  return (
    <NotificationPopover anchor={anchor} open={open} trigger={trigger} onOpenChange={onOpenChange}>
      <NotificationCenter source={streamManagerNotificationSource} onClose={onClose} />
    </NotificationPopover>
  )
}
