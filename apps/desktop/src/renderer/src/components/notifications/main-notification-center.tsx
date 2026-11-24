import type { ReactElement } from 'react'

import type { NotificationBellListProps } from '@/components/notifications/notification-bell'
import { NotificationCenter } from '@/components/notifications/notification-center'
import { NotificationPopover } from '@/components/notifications/notification-popover'
import { notifications } from '@/lib/notifications'

/** The main window's list: the store itself, in the list's own chunk. */
export default function MainNotificationCenter({
  open,
  onOpenChange,
  trigger,
  anchor
}: NotificationBellListProps): ReactElement {
  const onClose = (): void => onOpenChange(false)
  return (
    <NotificationPopover anchor={anchor} open={open} trigger={trigger} onOpenChange={onOpenChange}>
      <NotificationCenter source={notifications} onClose={onClose} />
    </NotificationPopover>
  )
}
