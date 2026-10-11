import type { ReactElement } from 'react'

import { kebabMenuGroups, type KebabMenuItem } from '@/components/kebab-menu'
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

/**
 * The right-click twin of a row's ⋯ menu (plan 174 S3.11, E-16): built from
 * the same `KebabMenuItem` list, so the two menus can never disagree. Groups,
 * keys, disabled reasons and the destructive item last, exactly as in
 * `KebabMenu`. The child is the row itself (the trigger, `asChild`).
 * Apart from kebab-menu.tsx so the ⋯ menu's other hosts don't load Radix's
 * context menu.
 */
export function KebabContextMenu({
  items,
  children,
  onOpenChange
}: {
  items: KebabMenuItem[]
  children: ReactElement
  onOpenChange?: (open: boolean) => void
}): ReactElement {
  const groups = kebabMenuGroups(items)
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {groups.map((group, index) => (
          <KebabContextMenuGroup key={group[0]?.id ?? index} items={group} separated={index > 0} />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
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
            key={item.id}
            focusable={false}
            reason={item.disabled ? item.disabledReason : null}
            side="right"
          >
            <ContextMenuItem
              disabled={item.disabled}
              variant={item.destructive ? 'destructive' : 'default'}
              onSelect={() => item.onSelect()}
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
