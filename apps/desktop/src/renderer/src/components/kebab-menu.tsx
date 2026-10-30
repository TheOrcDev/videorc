'use client'

import type { ReactElement, ReactNode } from 'react'

import { MoreIcon, SpinnerIcon } from '@/components/icons'
import type { AppIcon } from '@/components/icons'
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

interface KebabMenuItem {
  id: string
  label: string
  icon?: AppIcon
  /** Destructive items render in the destructive tone, last, in a group of their own. */
  destructive?: boolean
  disabled?: boolean
  /** Why a disabled item is off, on hover: one sentence. */
  disabledReason?: string | null
  /**
   * Items with the same group sit together, a hairline between groups, in the
   * order each group first appears. Ungrouped items form one group.
   */
  group?: string
  /** The item's keys, right-aligned: a `ShortcutKeys`. */
  shortcut?: ReactNode
  /** Runs when the item is chosen, by click or by key. The menu closes. */
  onSelect: () => void
}

/**
 * Groups the items for the menu: each `group` in first-appearance order, then
 * the destructive items on their own at the end.
 */
function kebabMenuGroups(items: readonly KebabMenuItem[]): KebabMenuItem[][] {
  const groups = new Map<string, KebabMenuItem[]>()
  const destructive: KebabMenuItem[] = []
  for (const item of items) {
    if (item.destructive) {
      destructive.push(item)
      continue
    }
    const key = item.group ?? ''
    const group = groups.get(key)
    if (group) {
      group.push(item)
    } else {
      groups.set(key, [item])
    }
  }
  return destructive.length > 0 ? [...groups.values(), destructive] : [...groups.values()]
}

/**
 * `reveal="hover"`: the trigger hides until its host row (the element with
 * `group/kebab-host`) is hovered or holds focus. It stays visible while the
 * menu is open (`data-popup-open`), while the trigger has keyboard focus, and
 * while it is busy. Visibility, not a restyle: the ghost button keeps its
 * look and only waits for its row.
 */
const REVEAL_ON_HOVER =
  // oxlint-disable-next-line shadcn/no-restyle -- see above.
  'opacity-0 group-hover/kebab-host:opacity-100 group-focus-within/kebab-host:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 aria-busy:opacity-100'

// React bubbles events through portals and triggers, so a click on the ⋯ or
// in its menu would also reach a clickable row behind it (and open the
// recording). The menu's clicks stop here.
const stopRowClick = (event: { stopPropagation: () => void }): void => {
  event.stopPropagation()
}

interface KebabMenuProps {
  items: KebabMenuItem[]
  /** The trigger's accessible name: "Actions for Launch demo". */
  label?: string
  /** An item's work is running: a spinner replaces the dots. */
  busy?: boolean
  /** The whole menu is unavailable (the app is reconnecting). */
  disabled?: boolean
  /** `hover`: hidden until the `group/kebab-host` row is hovered or focused. */
  reveal?: 'always' | 'hover'
  /** The trigger's tab stop: -1 in a roving-focus row that isn't the active one. */
  tabIndex?: number
  className?: string
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
            focusable={false}
            key={item.id}
            reason={item.disabled ? item.disabledReason : null}
            side="left"
          >
            <DropdownMenuItem
              disabled={item.disabled}
              onClick={() => item.onSelect()}
              variant={item.destructive ? 'destructive' : 'default'}
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

/**
 * The ⋯ overflow menu for low-frequency per-item actions: a ghost icon
 * trigger and a dropdown. One anatomy for every list and card (recordings,
 * assets, scenes, scheduled livestreams, chat rows). Items group by `group`
 * with a hairline between groups, destructive items last; `shortcut` shows an
 * item's keys; `busy` swaps the dots for a spinner while an item's work runs.
 */
function KebabMenu({
  items,
  label = 'More actions',
  busy = false,
  disabled = false,
  reveal = 'always',
  tabIndex,
  className
}: KebabMenuProps): ReactElement {
  const groups = kebabMenuGroups(items)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-busy={busy || undefined}
        aria-label={label}
        className={cn(reveal === 'hover' && REVEAL_ON_HOVER, className)}
        data-slot="kebab-menu-trigger"
        disabled={disabled}
        onClick={stopRowClick}
        render={<Button size="icon" variant="ghost" />}
        tabIndex={tabIndex}
      >
        {busy ? (
          <SpinnerIcon aria-hidden className="animate-spin" />
        ) : (
          <MoreIcon aria-hidden weight="bold" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={stopRowClick}>
        {groups.map((group, index) => (
          <KebabMenuGroup items={group} key={group[0]?.id ?? index} separated={index > 0} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { KebabMenu, kebabMenuGroups }
export type { KebabMenuItem, KebabMenuProps }
