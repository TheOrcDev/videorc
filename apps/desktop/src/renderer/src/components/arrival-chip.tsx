import type { ReactElement } from 'react'

import { AccountIcon, ResetIcon, SparkleIcon, type AppIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import type { ViewerArrival } from '@/lib/backend'
import { arrivalChip, type ArrivalChipKind } from '@/lib/community-view'

const CHIP_ICON: Record<ArrivalChipKind, AppIcon> = {
  milestone: SparkleIcon,
  back: ResetIcon,
  regular: AccountIcon
}

/**
 * The one quiet chip on a returning person's arrival row (plan 225 D11):
 * "10th stream", "Back · 3 wk" or "Regular · 14", an outline tag with a
 * monochrome icon like "First chat". Pure render from `message.arrival`: no
 * hook and no fetch per row (D14). Hover opens one line ("14 streams ·
 * since March 2026 · Twitch · YouTube"). The chip sits inside the row's
 * button, so it is a span, never a control: a click on it is the row's
 * click (on stream).
 */
export function ArrivalChip({
  arrival,
  className
}: {
  arrival: ViewerArrival | undefined
  className?: string
}): ReactElement | null {
  const chip = arrivalChip(arrival)
  if (!chip) return null
  const Icon = CHIP_ICON[chip.kind]
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={400}
        render={
          <Badge
            className={className ?? 'shrink-0'}
            data-arrival={chip.kind}
            data-testid="comment-arrival"
            variant="outline"
          />
        }
      >
        <Icon aria-hidden data-icon="inline-start" />
        {chip.label}
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="w-auto max-w-72 px-2.5 py-1.5 text-xs text-muted-foreground"
        data-testid="comment-arrival-hint"
      >
        {chip.hint}
      </HoverCardContent>
    </HoverCard>
  )
}
