import { DotsThree } from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface KebabMenuItem {
  id: string
  label: string
  icon?: Icon
  /** Destructive items render in the destructive tone and sort last by convention. */
  destructive?: boolean
  disabled?: boolean
  onSelect: () => void
}

/**
 * ⋯ overflow menu for low-frequency per-item actions (videorc-design): a ghost
 * icon trigger + Radix dropdown. Shared E0 primitive — Assets tiles and the
 * Publish session rail use the same anatomy. Pass `separatorBefore` implicitly
 * by ordering: destructive items are separated automatically.
 */
export function KebabMenu({
  items,
  label = 'More actions',
  className
}: {
  items: KebabMenuItem[]
  /** Accessible name for the trigger. */
  label?: string
  className?: string
}): ReactElement {
  const regular = items.filter((item) => !item.destructive)
  const destructive = items.filter((item) => item.destructive)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={label}
          className={cn('size-7', className)}
          size="icon"
          variant="ghost"
          onClick={(event) => event.stopPropagation()}
        >
          <DotsThree className="size-4" weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {regular.map((item) => (
          <DropdownMenuItem
            key={item.id}
            disabled={item.disabled}
            onSelect={() => item.onSelect()}
          >
            {item.icon ? <item.icon data-icon="inline-start" /> : null}
            {item.label}
          </DropdownMenuItem>
        ))}
        {regular.length > 0 && destructive.length > 0 ? <DropdownMenuSeparator /> : null}
        {destructive.map((item) => (
          <DropdownMenuItem
            key={item.id}
            disabled={item.disabled}
            variant="destructive"
            onSelect={() => item.onSelect()}
          >
            {item.icon ? <item.icon data-icon="inline-start" /> : null}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
