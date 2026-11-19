import type { ReactElement } from 'react'

import { CloseIcon, ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from '@/components/icons'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { countsAsUnread } from '@/lib/notifications/policy'
import type { NotificationActionView, NotificationEntry } from '@/lib/notifications/types'
import { notificationTimeWords } from '@/lib/notifications/view'
import { cn } from '@/lib/utils'

// One notification (plan 250): a flush row split from its neighbours by a
// hairline, never a card. The tone is on the icon only, like a toast's. The
// first action is the one way out (a fix, or the door to the page that owns
// the control); Clear shows on hover and on focus.

export interface NotificationEntryRowProps {
  entry: NotificationEntry
  nowMs: number
  /** The one row in the tab order (the list is a single tab stop, roving). */
  active: boolean
  /** The action whose fix is still running. */
  busyActionId: string | null
  onAction: (entry: NotificationEntry, action: NotificationActionView) => void
  onClear: (entry: NotificationEntry) => void
  onActivate: (entry: NotificationEntry) => void
}

function EntryIcon({ entry }: { entry: NotificationEntry }): ReactElement {
  if (entry.state === 'running') {
    return <Spinner aria-hidden className="text-muted-foreground size-4" />
  }
  switch (entry.tone) {
    case 'urgent':
      return <ErrorIcon aria-hidden className="text-live size-4" weight="fill" />
    case 'warning':
      return <WarningIcon aria-hidden className="text-warning size-4" weight="fill" />
    case 'done':
      return <SuccessIcon aria-hidden className="text-success size-4" weight="fill" />
    case 'news':
      return <InfoIcon aria-hidden className="text-muted-foreground size-4" />
  }
}

/** What a screen reader says before the title: the tone is not only a colour. */
export function notificationToneWord(entry: Pick<NotificationEntry, 'tone' | 'state'>): string {
  if (entry.state === 'running') return 'In progress'
  if (entry.state === 'resolved') return 'Resolved'
  switch (entry.tone) {
    case 'urgent':
      return 'Urgent'
    case 'warning':
      return 'Warning'
    case 'done':
      return 'Done'
    case 'news':
      return 'News'
  }
}

export function NotificationEntryRow({
  entry,
  nowMs,
  active,
  busyActionId,
  onAction,
  onClear,
  onActivate
}: NotificationEntryRowProps): ReactElement {
  const tabIndex = active ? 0 : -1
  const unread = countsAsUnread(entry)
  // A row with nothing under its title: Clear takes the time's place on hover.
  const bare = !entry.detail && entry.actions.length === 0
  return (
    <div
      aria-label={`${notificationToneWord(entry)}: ${entry.title}`}
      className="group/entry focus-visible:bg-accent hover:bg-accent/60 relative flex gap-3 px-4 py-3 outline-none"
      data-notification-key={entry.key}
      data-notification-state={entry.state}
      data-notification-tone={entry.tone}
      data-notification-unread={unread ? '' : undefined}
      role="listitem"
      tabIndex={tabIndex}
      onFocus={() => onActivate(entry)}
    >
      <span className="flex h-5 shrink-0 items-center">
        <EntryIcon entry={entry} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium" data-notification-title="">
            {entry.title}
          </span>
          <span
            className={cn(
              'text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs tabular-nums',
              bare && 'group-focus-within/entry:invisible group-hover/entry:invisible'
            )}
          >
            {unread ? <StatusDot tone={entry.tone === 'urgent' ? 'live' : 'neutral'} /> : null}
            {/* The clock moves every second: never read out. */}
            <span aria-hidden>{notificationTimeWords(entry, nowMs)}</span>
          </span>
        </div>
        {entry.detail ? (
          <p
            className="text-muted-foreground line-clamp-2 pr-6 text-xs"
            data-notification-detail=""
          >
            {entry.detail}
          </p>
        ) : null}
        {entry.actions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1 pt-1.5 pr-6">
            {entry.actions.map((action, index) => {
              const busy = busyActionId === action.id
              return (
                <Button
                  key={action.id}
                  aria-busy={busy || undefined}
                  data-notification-action={action.id}
                  disabled={busyActionId !== null}
                  size="xs"
                  tabIndex={tabIndex}
                  type="button"
                  variant={index === 0 ? 'default' : 'ghost'}
                  onClick={() => onAction(entry, action)}
                >
                  {busy ? <Spinner aria-hidden data-icon="inline-start" /> : null}
                  {action.label}
                </Button>
              )
            })}
          </div>
        ) : null}
      </div>
      <Button
        aria-label={`Clear ${entry.title}`}
        className={cn(
          'absolute right-2 opacity-0 group-focus-within/entry:opacity-100 group-hover/entry:opacity-100 focus-visible:opacity-100',
          bare ? 'top-2.5' : 'bottom-2'
        )}
        data-notification-clear=""
        size="icon-xs"
        tabIndex={tabIndex}
        type="button"
        variant="ghost"
        onClick={() => onClear(entry)}
      >
        <CloseIcon aria-hidden />
      </Button>
    </div>
  )
}
