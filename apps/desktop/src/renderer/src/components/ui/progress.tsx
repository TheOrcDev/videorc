import * as React from 'react'
import { Progress as ProgressPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

// shadcn `progress` (radix-rhea), plan 174 S1.5 (J1-21): one determinate bar,
// a 6 px round track with the fill in the primary tone. `value` runs from 0 to
// `max` (100 by default) and reaches the progressbar's aria-valuenow; the
// caller names the bar with `aria-label` and says the number in words beside
// it when the streamer needs it.
function Progress({
  className,
  value,
  max = 100,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const safeMax = max > 0 ? max : 100
  const percent = Math.min(100, Math.max(0, ((value ?? 0) / safeMax) * 100))
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
      max={safeMax}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full bg-primary transition-transform duration-150 ease-out"
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
