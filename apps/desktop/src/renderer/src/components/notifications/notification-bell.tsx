import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement
} from 'react'

import { NotificationsIcon } from '@/components/icons'
import { StatusBarAction } from '@/components/status-bar-action'
import {
  notificationBellName,
  notificationCountLabel,
  NOTIFICATIONS_TOGGLE_EVENT,
  notificationsOpen,
  setNotificationsOpen,
  type NotificationAnnouncement,
  type NotificationBellCount,
  type NotificationsToggle
} from '@/lib/notification-count'
import { toastUserError } from '@/lib/user-error'
import { cn } from '@/lib/utils'
import { WORKSPACE_NAVIGATE_EVENT } from '@/lib/workspace-navigation'

// The bell (plan 250, D1): the last control of a status bar. It is in every
// window's first paint, so it is only an icon and a number on a button. The
// popover and the list behind it are one lazy chunk, loaded on the first
// hover, focus or open. It is never a mounted `lazy()` child: a chunk that
// fails to load would throw while rendering, past the page's boundary, and
// take the whole window to the error panel. A failed load closes the list
// and says so; the next press tries again.
//
// The tone is on the icon alone and stays while a problem is open, even with
// nothing unread: a glance says "something is still wrong". The number is
// never coloured.

export interface NotificationBellListProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The bell's button. */
  trigger: HTMLElement | null
  /** What the list lines up with, when that is not the bell. */
  anchor?: Element | null
}

export interface NotificationBellProps {
  count: NotificationBellCount
  announcement: NotificationAnnouncement | null
  /** The shortcut as an Electron accelerator, shown in the tooltip. */
  accelerator?: string
  platform?: string
  /**
   * The popover and its list, in their own chunk. Base UI's popover alone is
   * 12 KB gzip, so the bell renders none of it: only its own button.
   */
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
  // The list mounts with the first open and stays, so it can animate out.
  const [List, setList] = useState<ComponentType<NotificationBellListProps> | null>(null)
  const [button, setButton] = useState<HTMLButtonElement | null>(null)
  // The loader may be a new function each render.
  const loadRef = useRef(load)
  loadRef.current = load
  const mounted = useRef(true)
  const loaded = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // A failure while warming is silent: the open below tries again and says so.
  const warm = useCallback((): void => {
    void loadRef.current().catch(() => {})
  }, [])

  const change = useCallback((next: boolean): void => {
    setNotificationsOpen(next)
    setOpen(next)
    if (!next || loaded.current) return
    void loadRef.current().then(
      (module) => {
        loaded.current = true
        if (mounted.current) setList(() => module.default)
      },
      (error: unknown) => {
        if (!mounted.current) return
        setNotificationsOpen(false)
        setOpen(false)
        toastUserError(error, { action: 'open', object: 'Notifications' })
      }
    )
  }, [])

  useEffect(() => {
    const onToggle = (event: Event): void => {
      const action = (event as CustomEvent<NotificationsToggle>).detail
      change(action === 'open' ? true : action === 'close' ? false : !notificationsOpen())
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
      <StatusBarAction
        ref={setButton}
        aria-expanded={open}
        aria-haspopup="dialog"
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
        text={label ? <span className="text-foreground tabular-nums">{label}</span> : undefined}
        tooltip="Notifications"
        tooltipAccelerator={accelerator}
        onClick={() => change(!open)}
        onFocus={warm}
        onPointerEnter={warm}
      />
      {List ? <List anchor={anchor} open={open} trigger={button} onOpenChange={change} /> : null}
      {/*
        A new urgent entry interrupts; everything else waits its turn. The
        text is a child keyed by the announcement's number: the same words
        twice in a row are a new node, so they are read again.
      */}
      <span className="sr-only" role="alert">
        {announcement?.urgent ? <span key={announcement.sequence}>{announcement.text}</span> : null}
      </span>
      <span className="sr-only" role="status">
        {announcement && !announcement.urgent ? (
          <span key={announcement.sequence}>{announcement.text}</span>
        ) : null}
      </span>
    </>
  )
}
