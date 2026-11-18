import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import { NotificationEntryRow } from '@/components/notifications/notification-entry'
import { SectionLabel } from '@/components/section-label'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { NotificationActionView, NotificationEntry } from '@/lib/notifications/types'
import {
  groupNotifications,
  hasClearable,
  type NotificationListSource
} from '@/lib/notifications/view'
import { toastUserError } from '@/lib/user-error'

// The list behind the bell (plan 250): the popover's content. "Now" holds
// what is still true, "Earlier" the rest. One tab stop for the entries: ↑ and
// ↓ move between them, ↵ runs the entry's first action, ⌫ clears it, and Tab
// walks the buttons inside it. Opening it marks everything read when it
// closes, and nothing pops up while it is open.

export interface NotificationCenterProps {
  source: NotificationListSource
  /** A door was pressed: the list closes and the page takes over. */
  onClose: () => void
  /** The line under the list (the quiet rule and its link). */
  footer?: ReactNode
}

const ROW = '[data-notification-key]'

export function NotificationCenter({
  source,
  onClose,
  footer
}: NotificationCenterProps): ReactElement {
  const entries = useSyncExternalStore(source.subscribe, source.snapshot)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [busy, setBusy] = useState<{ key: string; id: string } | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    source.setListOpen(true)
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
      source.setListOpen(false)
      source.markAllRead()
    }
  }, [source])

  const groups = groupNotifications(entries)
  const ordered = [...groups.now, ...groups.earlier]
  const active = ordered.some((entry) => entry.key === activeKey)
    ? activeKey
    : (ordered[0]?.key ?? null)

  const rows = useCallback(
    (): HTMLElement[] => Array.from(listRef.current?.querySelectorAll<HTMLElement>(ROW) ?? []),
    []
  )

  const act = useCallback(
    (entry: NotificationEntry, action: NotificationActionView): void => {
      if (action.kind === 'door') {
        void source.runAction(entry.key, action.id).catch((error: unknown) => {
          toastUserError(error, { action: action.label.toLowerCase() })
        })
        onClose()
        return
      }
      // A fix keeps the list open, with a spinner on its button until it ran.
      setBusy({ key: entry.key, id: action.id })
      void source
        .runAction(entry.key, action.id)
        .catch((error: unknown) => {
          toastUserError(error, { action: action.label.toLowerCase() })
        })
        .finally(() => {
          if (mounted.current) setBusy(null)
        })
    },
    [onClose, source]
  )

  const clear = useCallback(
    (entry: NotificationEntry): void => {
      // Focus moves to the next entry, so the keyboard keeps its place.
      const all = rows()
      const index = all.findIndex((row) => row.dataset.notificationKey === entry.key)
      const next = all[index + 1] ?? all[index - 1] ?? null
      source.clear(entry.key)
      if (next?.dataset.notificationKey) {
        setActiveKey(next.dataset.notificationKey)
        next.focus()
      }
    },
    [rows, source]
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const row = (event.target as HTMLElement).closest<HTMLElement>(ROW)
    if (!row) return
    const entry = ordered.find((candidate) => candidate.key === row.dataset.notificationKey)
    if (!entry) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const all = rows()
      const index = all.indexOf(row)
      const next = all[index + (event.key === 'ArrowDown' ? 1 : -1)]
      event.preventDefault()
      next?.focus()
      return
    }
    // ↵ and ⌫ belong to the row itself: on a button they are the button's.
    if (event.target !== row) return
    if (event.key === 'Enter') {
      const [first] = entry.actions
      if (!first || busy) return
      event.preventDefault()
      act(entry, first)
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      clear(entry)
    }
  }

  const renderRows = (list: readonly NotificationEntry[]): ReactElement[] =>
    list.map((entry) => (
      <NotificationEntryRow
        key={entry.key}
        active={entry.key === active}
        busyActionId={busy?.key === entry.key ? busy.id : null}
        entry={entry}
        nowMs={nowMs}
        onAction={act}
        onActivate={(focused) => setActiveKey(focused.key)}
        onClear={clear}
      />
    ))

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="notification-center">
      <header className="border-border flex h-11 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Notifications</h2>
        {hasClearable(entries) ? (
          <Button
            data-notification-clear-all=""
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => source.clearAll()}
          >
            Clear all
          </Button>
        ) : null}
      </header>
      {ordered.length === 0 ? (
        <Empty className="py-10" data-notification-empty="">
          <EmptyHeader>
            <EmptyTitle>No notifications</EmptyTitle>
            <EmptyDescription>Problems and finished work show up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea
          className="min-h-0 flex-1"
          viewportClassName="max-h-[min(28rem,calc(100vh-11rem))]"
        >
          {/* The rows and their buttons handle the keys; the list only routes them. */}
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above. */}
          <div ref={listRef} aria-label="Notifications" role="list" onKeyDown={onKeyDown}>
            {groups.labelled ? (
              <SectionLabel as="div" className="px-4 pt-3 pb-1">
                Now
              </SectionLabel>
            ) : null}
            <div className="divide-border flex flex-col divide-y" role="presentation">
              {renderRows(groups.now)}
            </div>
            {groups.labelled && groups.earlier.length > 0 ? (
              <SectionLabel as="div" className="border-border border-t px-4 pt-3 pb-1">
                Earlier
              </SectionLabel>
            ) : null}
            <div className="divide-border flex flex-col divide-y" role="presentation">
              {renderRows(groups.earlier)}
            </div>
          </div>
        </ScrollArea>
      )}
      {footer ? (
        <footer className="border-border text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-t pr-2 pl-4 text-xs">
          {footer}
        </footer>
      ) : null}
    </div>
  )
}
