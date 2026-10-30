'use client'

import type { ReactElement } from 'react'

import { kebabMenuGroups } from '@/components/kebab-menu'
import type { KebabMenuItem } from '@/components/kebab-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { DisabledReason } from '@/components/ui/disabled-reason'

interface KebabContextMenuProps {
  /** The same list the row's ⋯ menu takes. */
  items: KebabMenuItem[]
  /** The row itself: it becomes the trigger and keeps its own element. */
  children: ReactElement
  onOpenChange?: (open: boolean) => void
}

function KebabContextMenuGroup({
  items,
  separated
}: {
  items: KebabMenuItem[]
  separated: boolean
}): ReactElement {
  return (
    <>
      {separated ? <ContextMenuSeparator /> : null}
      <ContextMenuGroup>
        {items.map((item) => (
          <DisabledReason
            focusable={false}
            key={item.id}
            reason={item.disabled ? item.disabledReason : null}
            side="right"
          >
            <ContextMenuItem
              disabled={item.disabled}
              onClick={() => item.onSelect()}
              variant={item.destructive ? 'destructive' : 'default'}
            >
              {item.icon ? <item.icon data-icon="inline-start" /> : null}
              {item.label}
              {item.shortcut ? <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut> : null}
            </ContextMenuItem>
          </DisabledReason>
        ))}
      </ContextMenuGroup>
    </>
  )
}

/**
 * The right-click twin of a row's ⋯ menu: built from the same `KebabMenuItem`
 * list, so the two menus can never disagree. Groups, keys, disabled reasons
 * and the destructive item last, exactly as in `KebabMenu`. Apart from
 * kebab-menu.tsx so the ⋯ menu's other hosts don't load the context menu.
 */
function KebabContextMenu({ items, children, onOpenChange }: KebabContextMenuProps): ReactElement {
  const groups = kebabMenuGroups(items)
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent>
        {groups.map((group, index) => (
          <KebabContextMenuGroup items={group} key={group[0]?.id ?? index} separated={index > 0} />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export { KebabContextMenu }
export type { KebabContextMenuProps }
