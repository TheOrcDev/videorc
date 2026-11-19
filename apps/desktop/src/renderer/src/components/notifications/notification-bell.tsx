import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement
} from 'react'

import { NotificationsIcon } from '@/components/icons'
import { StatusBarAction } from '@/components/status-bar-action'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  notificationBellName,
  notificationCountLabel,
  NOTIFICATIONS_TOGGLE_EVENT,
  setNotificationsOpen,
  type NotificationAnnouncement,
  type NotificationBellCount,
  type NotificationsToggle
} from '@/lib/notification-count'
import { cn } from '@/lib/utils'
import { WORKSPACE_NAVIGATE_EVENT } from '@/lib/workspace-navigation'

// The bell (plan 250, D1): the last control of a status bar. It is in every
// window's first paint, so it is only an icon, a number and the popover's
// trigger; the list behind it loads on the first hover, focus or open.
//
// The tone is on the icon alone and stays while a problem is open, even with
// nothing unread: a glance says "something is still wrong". The number is
// never coloured.

export interface NotificationBellListProps {
  onClose: () => void
}

export interface NotificationBellProps {
  count: NotificationBellCount
  announcement: NotificationAnnouncement | null
  /** The shortcut as an Electron accelerator, shown in the tooltip. */
  accelerator?: string
  platform?: string
  /** The list, in its own chunk. */
  load: () => Promise<{ default: ComponentType<NotificationBellListProps> }>
  /**
   * What the list lines up with, when that is not the bell: the Stream
   * Manager folds the bell into its ⋯ menu below 640 px, and the list then
   * opens from the bar's end.
   */
  anchor?: Element | null
  className?: string
}

const ICON_TONE_CLASS = { urgent: 'text-live', warning: 'text-warning' } as const

export function NotificationBell({
  count,
  announcement,
  accelerator,
  platform,
  load,
  anchor,
  className
}: NotificationBellProps): ReactElement {
  const [open, setOpen] = useState(false)
  const loadRef = useRef(load)
  loadRef.current = load
  // One lazy component per bell: the loader may be a new function each render.
  const [List] = useState(() => lazy(() => loadRef.current()))
  const warm = useCallback((): void => {
    void loadRef.current().catch(() => {})
  }, [])

  const change = useCallback((next: boolean): void => {
    setNotificationsOpen(next)
    setOpen(next)
  }, [])

  useEffect(() => {
    const onToggle = (event: Event): void => {
      const action = (event as CustomEvent<NotificationsToggle>).detail
      setOpen((current) => {
        const next = action === 'open' ? true : action === 'close' ? false : !current
        setNotificationsOpen(next)
        return next
      })
    }
    // A page opened from anywhere closes the list, like the account menu.
    const onNavigate = (): void => change(false)
    window.addEventListener(NOTIFICATIONS_TOGGLE_EVENT, onToggle)
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, onNavigate)
    return () => {
      window.removeEventListener(NOTIFICATIONS_TOGGLE_EVENT, onToggle)
      window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, onNavigate)
      setNotificationsOpen(false)
    }
  }, [change])

  const label = notificationCountLabel(count.unread)
  return (
    <>
      <Popover open={open} onOpenChange={change}>
        <PopoverTrigger
          render={
            <StatusBarAction
              className={className}
              data-videorc-notification-bell=""
              data-videorc-notification-count={count.unread}
              data-videorc-notification-tone={count.tone ?? 'none'}
              icon={
                <NotificationsIcon
                  aria-hidden
                  className={cn(count.tone && ICON_TONE_CLASS[count.tone])}
                  weight={count.tone ? 'fill' : 'regular'}
                />
              }
              label={notificationBellName(count)}
              platform={platform}
              tooltip="Notifications"
              tooltipAccelerator={accelerator}
              text={
                label ? <span className="text-foreground tabular-nums">{label}</span> : undefined
              }
              onFocus={warm}
              onPointerEnter={warm}
            />
          }
        />
        <PopoverContent
          align="end"
          anchor={anchor ?? undefined}
          className="w-[380px] max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0"
          data-videorc-notification-list=""
          side="top"
          sideOffset={8}
        >
          <Suspense fallback={<div className="h-24" />}>
            <List onClose={() => change(false)} />
          </Suspense>
        </PopoverContent>
      </Popover>
      {/* A new urgent entry interrupts; everything else waits its turn. */}
      <span className="sr-only" role="alert">
        {announcement?.urgent ? announcement.text : ''}
      </span>
      <span className="sr-only" role="status">
        {announcement && !announcement.urgent ? announcement.text : ''}
      </span>
    </>
  )
}
