import type { ReactElement, ReactNode } from 'react'

import type { AppIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

type PanelSectionProps = {
  /**
   * Optional: a titleless section is just padded content (no header row), for
   * when the surrounding layout already names it.
   */
  title?: string
  description?: ReactNode
  icon?: AppIcon
  /** Controls for the whole section, at the end of its header. */
  action?: ReactNode
  /** Optional: a section that is only its header (a title and what it says) has no content box. */
  children?: ReactNode
  className?: string
  contentClassName?: string
  /** The outline level of the title: 2 (the default) under the page, 3 when nested. */
  headingLevel?: 2 | 3
  // `data-*` hooks for tests and probes.
} & Record<`data-${string}`, string | undefined>

/**
 * The flush section: the single section treatment for every pane. No border
 * box, background, radius or shadow; a 13 px / 600 header, a 12 px
 * description, 16 px padding, and a hairline to the next section. The header
 * is an h2 under the toolbar's h1; a section nested under another section's
 * heading passes `headingLevel={3}`.
 */
function PanelSection({
  title,
  description,
  icon: LeadingIcon,
  action,
  children,
  className,
  contentClassName,
  headingLevel = 2,
  ...data
}: PanelSectionProps): ReactElement {
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  const hasHeader = Boolean(title || description || action)
  const hasContent = children !== null && children !== undefined && children !== false
  return (
    <section
      className={cn(
        'border-border p-gutter flex flex-col gap-3 border-b last:border-b-0',
        className
      )}
      data-slot="panel-section"
      {...data}
    >
      {hasHeader ? (
        <header
          className="flex min-h-6 items-start justify-between gap-3"
          data-slot="panel-section-header"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            {title ? (
              <Heading className="text-section text-foreground flex items-center gap-2 font-semibold">
                {LeadingIcon ? (
                  <LeadingIcon className="text-muted-foreground size-4" weight="duotone" />
                ) : null}
                {title}
              </Heading>
            ) : null}
            {description ? (
              <div
                className="text-meta text-muted-foreground"
                data-slot="panel-section-description"
              >
                {description}
              </div>
            ) : null}
          </div>
          {/* As tall as the title line, so a 28 px button or a switch centres on it. */}
          {action ? (
            <div className="flex h-5 shrink-0 items-center gap-2" data-slot="panel-section-action">
              {action}
            </div>
          ) : null}
        </header>
      ) : null}
      {hasContent ? (
        <div
          className={cn('flex flex-col gap-3', contentClassName)}
          data-slot="panel-section-content"
        >
          {children}
        </div>
      ) : null}
    </section>
  )
}

export { PanelSection, type PanelSectionProps }
