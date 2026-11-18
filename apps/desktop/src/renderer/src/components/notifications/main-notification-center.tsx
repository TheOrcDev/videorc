import type { ReactElement } from 'react'

import type { NotificationBellListProps } from '@/components/notifications/notification-bell'
import { NotificationCenter } from '@/components/notifications/notification-center'
import { Button } from '@/components/ui/button'
import { useStudioCore } from '@/hooks/use-studio'
import { notifications } from '@/lib/notifications'
import { quietFooterLine } from '@/lib/quiet-while-live'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

/**
 * The main window's list: the store itself, in the list's own chunk. Its
 * footer says what the quiet rule is doing and opens the switch's one home.
 */
export default function MainNotificationCenter({
  onClose
}: NotificationBellListProps): ReactElement {
  const { settings } = useStudioCore()
  return (
    <NotificationCenter
      footer={
        <>
          <span className="min-w-0 flex-1 truncate" data-notification-quiet-line="">
            {quietFooterLine(settings)}
          </span>
          <Button
            size="xs"
            type="button"
            variant="link"
            onClick={() => {
              onClose()
              openWorkspaceTab('settings', 'general')
            }}
          >
            Settings
          </Button>
        </>
      }
      source={notifications}
      onClose={onClose}
    />
  )
}
