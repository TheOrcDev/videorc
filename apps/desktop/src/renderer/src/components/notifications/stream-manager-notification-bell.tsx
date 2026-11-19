import { useEffect, type ReactElement } from 'react'

import { NotificationBell } from '@/components/notifications/notification-bell'
import { toggleNotifications } from '@/lib/notification-count'
import { isCommandKey } from '@/lib/platform'
import { shortcutAccelerator } from '@/lib/shortcuts'
import {
  startStreamManagerNotifications,
  useStreamManagerNotificationCount
} from '@/lib/stream-manager-notifications'

const loadList = () => import('@/components/notifications/stream-manager-notification-center')

/**
 * The Stream Manager's bell (plan 250 S8): the last control of its status
 * bar, with the same list as the main window's. While live this is the
 * window in front, so the bell matters most here. ⇧⌘B opens it.
 */
export function StreamManagerNotificationBell({
  anchor,
  className,
  platform
}: {
  /** The bar's controls: below 640 px the bell is in the ⋯ menu and the list opens from here. */
  anchor?: Element | null
  className?: string
  platform?: string
}): ReactElement {
  const count = useStreamManagerNotificationCount()
  useEffect(() => startStreamManagerNotifications(), [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isCommandKey(event, platform) || !event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'b') return
      event.preventDefault()
      toggleNotifications()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [platform])
  return (
    <NotificationBell
      accelerator={shortcutAccelerator('notifications')}
      anchor={anchor}
      announcement={null}
      className={className}
      count={count}
      load={loadList}
      platform={platform}
    />
  )
}
