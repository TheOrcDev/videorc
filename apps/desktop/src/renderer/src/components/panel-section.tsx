import { AppIcon } from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The flush section (plan 050, D4): the single section treatment for every
 * pane. No border box, background, radius, or shadow; a 13 px / 600 header,
 * a 12 px description, 16 px padding, and a hairline to the next section.
 */
export function PanelSection({
  title,
  description,
  icon: LeadingIcon,
  action,
  children,
  className,
  contentClassName
}: {
  // Optional: a titleless section is just padded content (no header row), for
  // when the surrounding layout already names it.
  title?: string
  description?: ReactNode
  icon?: AppIcon
  action?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
}): ReactElement {
  const hasHeader = Boolean(title || description || action)
  return (
    <section
      className={cn(
        'flex flex-col gap-3 border-b border-border p-gutter last:border-b-0',
        className
      )}
      data-slot="panel-section"
    >
      {hasHeader ? (
        <header className="flex min-h-6 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title ? (
              <h3 className="flex items-center gap-2 text-[13px] leading-5 font-semibold text-foreground">
                {LeadingIcon ? (
                  <LeadingIcon className="size-4 text-muted-foreground" weight="duotone" />
                ) : null}
                {title}
              </h3>
            ) : null}
            {description ? (
              <div className="text-xs text-muted-foreground">{description}</div>
            ) : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      <div className={cn('flex flex-col gap-3', contentClassName)}>{children}</div>
    </section>
  )
}
