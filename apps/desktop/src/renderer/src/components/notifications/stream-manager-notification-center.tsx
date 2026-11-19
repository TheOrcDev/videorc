import type { ReactElement } from 'react'

import type { NotificationBellListProps } from '@/components/notifications/notification-bell'
import { NotificationCenter } from '@/components/notifications/notification-center'
import { NotificationPopover } from '@/components/notifications/notification-popover'
import { Button } from '@/components/ui/button'
import { quietFooterLine } from '@/lib/quiet-while-live'
import {
  actOnNotification,
  streamManagerNotificationSource,
  useStreamManagerQuiet
} from '@/lib/stream-manager-notifications'

/**
 * The Stream Manager's list (plan 250 S8): the same list, read from the
 * main window's copy. A door pressed here brings the main window forward on
 * the page it opens; the footer's link opens the quiet switch there.
 */
export default function StreamManagerNotificationCenter({
  open,
  onOpenChange,
  trigger,
  anchor
}: NotificationBellListProps): ReactElement {
  const onClose = (): void => onOpenChange(false)
  const quiet = useStreamManagerQuiet()
  return (
    <NotificationPopover anchor={anchor} open={open} trigger={trigger} onOpenChange={onOpenChange}>
      <NotificationCenter
        footer={
          <>
            <span className="min-w-0 flex-1 truncate" data-notification-quiet-line="">
              {quietFooterLine({ quietWhileLive: quiet })}
            </span>
            <Button
              size="xs"
              type="button"
              variant="link"
              onClick={() => {
                onClose()
                void actOnNotification({ type: 'open-settings' })
              }}
            >
              Settings
            </Button>
          </>
        }
        source={streamManagerNotificationSource}
        onClose={onClose}
      />
    </NotificationPopover>
  )
}
