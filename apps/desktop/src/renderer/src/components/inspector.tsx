import { CaretDown, type Icon } from '@phosphor-icons/react'
import { useState, type ReactElement, type ReactNode } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

/**
 * A collapsible Inspector section — a quiet card with progressive disclosure. Replaces the
 * Studio right-rail PanelSection: the header is a toggle, an optional one-line `summary` shows
 * when collapsed, and the body keeps the PanelSection content spacing (flex-col gap).
 */
export function InspectorSection({
  icon: LeadingIcon,
  title,
  summary,
  defaultOpen = true,
  children,
  className
}: {
  icon?: Icon
  title: string
  summary?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('rounded-xl border bg-card', className)}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        {LeadingIcon ? (
          <LeadingIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
        ) : null}
        <span className="text-sm font-medium">{title}</span>
        {!open && summary ? (
          <span className="ml-auto max-w-[55%] truncate text-xs text-muted-foreground">{summary}</span>
        ) : (
          <span className="ml-auto" />
        )}
        <CaretDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3.5 border-t px-3.5 pb-3.5 pt-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
