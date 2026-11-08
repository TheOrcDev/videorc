import type { ReactElement } from 'react'

import { Badge } from '@/components/ui/badge'
import { bannerTimingSummary, type BannerTiming } from '@/lib/banner-timing'
import { cn } from '@/lib/utils'

/**
 * A banner's timer as a small neutral tag (plan 186 S10): "Shows for 30 s
 * every 15 min". Nothing when both timers are off. It may shrink and
 * truncate in a tight row; the Timing fold says the whole line.
 */
export function BannerTimingChip({
  banner,
  className
}: {
  banner: BannerTiming
  className?: string
}): ReactElement | null {
  const summary = bannerTimingSummary(banner)
  if (!summary) return null
  return (
    <Badge
      className={cn('min-w-0 shrink', className)}
      data-videorc-banner-timing=""
      variant="outline"
    >
      <span className="truncate">{summary}</span>
    </Badge>
  )
}
