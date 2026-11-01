'use client'

import { Progress as ProgressPrimitive } from '@base-ui/react/progress'

import { cn } from '@/lib/utils'

const DEFAULT_MAX = 100

// One determinate bar: a 6 px round track with the chrome fill. `value` runs
// from 0 to `max` (100 by default) and reaches the progressbar's
// aria-valuenow. Name the bar with `aria-label` (or a ProgressLabel), and say
// the number in words beside it when the streamer needs it. A non-positive
// `max` (a total not known yet) reads as 100.
function Progress({
  className,
  children,
  value,
  max = DEFAULT_MAX,
  ...props
}: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      className={cn('flex w-full flex-wrap gap-x-3 gap-y-1.5', className)}
      data-slot="progress"
      max={max > 0 ? max : DEFAULT_MAX}
      value={value}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  )
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn(
        'bg-muted relative flex h-1.5 w-full items-center overflow-hidden rounded-full',
        className
      )}
      data-slot="progress-track"
      {...props}
    />
  )
}

function ProgressIndicator({ className, ...props }: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      className={cn('chrome-fill h-full transition-[width] duration-150 ease-out', className)}
      data-slot="progress-indicator"
      {...props}
    />
  )
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn('text-sm font-medium', className)}
      data-slot="progress-label"
      {...props}
    />
  )
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn('text-muted-foreground ml-auto text-sm tabular-nums', className)}
      data-slot="progress-value"
      {...props}
    />
  )
}

export { Progress, ProgressTrack, ProgressIndicator, ProgressLabel, ProgressValue }
