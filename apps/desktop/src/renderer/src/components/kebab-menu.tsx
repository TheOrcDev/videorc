import { MoreIcon, SpinnerIcon, type AppIcon } from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface KebabMenuItem {
  id: string
  label: string
  icon?: AppIcon
  /** Destructive items render in the destructive tone, last, in a group of their own. */
  destructive?: boolean
  disabled?: boolean
  /** Why a disabled item is off, on hover (plan 174 S3.11): one sentence. */
  disabledReason?: string | null
  /**
   * Items with the same group sit together, a hairline between groups, in the
   * order each group first appears. Ungrouped items form one group.
   */
  group?: string
  /** The item's keys, right-aligned (`DropdownMenuShortcut`). */
  shortcut?: ReactNode
  onSelect: () => void
}

/**
 * Groups the items for the menu: each `group` in first-appearance order, then
 * the destructive items on their own at the end (plan 174 S1.6b, E-PAT).
 */
export function kebabMenuGroups(items: readonly KebabMenuItem[]): KebabMenuItem[][] {
  const groups = new Map<string, KebabMenuItem[]>()
  const destructive: KebabMenuItem[] = []
  for (const item of items) {
    if (item.destructive) {
      destructive.push(item)
      continue
    }
    const key = item.group ?? ''
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return [...groups.values(), ...(destructive.length > 0 ? [destructive] : [])]
}

/**
 * `reveal="hover"`: the trigger hides until its host row (the element with
 * `group/kebab-host`) is hovered or holds focus. It stays visible while the
 * menu is open, while the trigger has keyboard focus, and while it is busy.
 */
const REVEAL_ON_HOVER =
  'opacity-0 group-hover/kebab-host:opacity-100 group-focus-within/kebab-host:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 aria-busy:opacity-100'

/**
 * ⋯ overflow menu for low-frequency per-item actions (videorc-design): a ghost
 * icon trigger and a dropdown menu. One anatomy for every list and card
 * (plan 174 S1.6b, E-PAT/A-PAT): Library rows, Assets tiles, scenes,
 * scheduled streams, chat and Activity rows. Items group by `group` with a
 * hairline between groups, destructive items last; `shortcut` shows an
 * item's keys; `busy` swaps the dots for a spinner while an item's work runs.
 */
export function KebabMenu({
  items,
  label = 'More actions',
  busy = false,
  disabled = false,
  reveal = 'always',
  tabIndex,
  className
}: {
  items: KebabMenuItem[]
  /** Accessible name for the trigger. */
  label?: string
  /** An item's work is running: a spinner replaces the dots. */
  busy?: boolean
  /** The whole menu is unavailable (the backend is away). */
  disabled?: boolean
  /** `hover`: hidden until the `group/kebab-host` row is hovered or focused. */
  reveal?: 'always' | 'hover'
  /** The trigger's tab stop: -1 in a roving-focus row that is not the active one. */
  tabIndex?: number
  className?: string
}): ReactElement {
  const groups = kebabMenuGroups(items)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-busy={busy || undefined}
            aria-label={label}
            className={cn(reveal === 'hover' && REVEAL_ON_HOVER, className)}
            disabled={disabled}
            size="icon"
            tabIndex={tabIndex}
            variant="ghost"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        {busy ? (
          <SpinnerIcon aria-hidden className="animate-spin" />
        ) : (
          <MoreIcon aria-hidden weight="bold" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {groups.map((group, index) => (
          <KebabMenuGroup key={group[0]?.id ?? index} items={group} separated={index > 0} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function KebabMenuGroup({
  items,
  separated
}: {
  items: KebabMenuItem[]
  separated: boolean
}): ReactElement {
  return (
    <>
      {separated ? <DropdownMenuSeparator /> : null}
      <DropdownMenuGroup>
        {items.map((item) => (
          <DisabledReason
            key={item.id}
            focusable={false}
            reason={item.disabled ? item.disabledReason : null}
            side="left"
          >
            <DropdownMenuItem
              disabled={item.disabled}
              variant={item.destructive ? 'destructive' : 'default'}
              onClick={() => item.onSelect()}
            >
              {item.icon ? <item.icon data-icon="inline-start" /> : null}
              {item.label}
              {item.shortcut ? <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut> : null}
            </DropdownMenuItem>
          </DisabledReason>
        ))}
      </DropdownMenuGroup>
    </>
  )
}
