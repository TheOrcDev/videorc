import { AppIcon } from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * The flush section (plan 050, D4): the single section treatment for every
 * pane. No border box, background, radius, or shadow; a 13 px / 600 header,
 * a 12 px description, 16 px padding, and a hairline to the next section.
 * The header is an h2 under the toolbar's h1 (plan 174 S1.6a, A-24); a
 * section nested under another section's heading passes `headingLevel={3}`.
 */
export function PanelSection({
  title,
  description,
  icon: LeadingIcon,
  action,
  children,
  className,
  contentClassName,
  headingLevel = 2,
  ...data
}: {
  // Optional: a titleless section is just padded content (no header row), for
  // when the surrounding layout already names it.
  title?: string
  description?: ReactNode
  icon?: AppIcon
  action?: ReactNode
  /** Optional: a section that is only its header (a title and what it says) has no content box. */
  children?: ReactNode
  className?: string
  contentClassName?: string
  /** The outline level of the title: 2 (the default) under the page, 3 when nested. */
  headingLevel?: 2 | 3
  // `data-*` hooks for smokes and probes (plan 189: `data-videorc-soundboard`).
} & Record<`data-${string}`, string | undefined>): ReactElement {
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  const hasHeader = Boolean(title || description || action)
  return (
    <section
      className={cn(
        'flex flex-col gap-3 border-b border-border p-gutter last:border-b-0',
        className
      )}
      data-slot="panel-section"
      {...data}
    >
      {hasHeader ? (
        <header className="flex min-h-6 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title ? (
              <Heading className="flex items-center gap-2 text-section font-semibold text-foreground">
                {LeadingIcon ? (
                  <LeadingIcon className="size-4 text-muted-foreground" weight="duotone" />
                ) : null}
                {title}
              </Heading>
            ) : null}
            {description ? (
              <div className="text-meta text-muted-foreground">{description}</div>
            ) : null}
          </div>
          {/* As tall as the title line, so a 28 px button or a switch centres on it. */}
          {action ? <div className="flex h-5 shrink-0 items-center gap-2">{action}</div> : null}
        </header>
      ) : null}
      {children !== null && children !== undefined && children !== false ? (
        <div className={cn('flex flex-col gap-3', contentClassName)}>{children}</div>
      ) : null}
    </section>
  )
}
