import type { ReactElement } from 'react'
import { Area, AreaChart, YAxis } from 'recharts'

import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { cn } from '@/lib/utils'

/**
 * A stats sparkline (plan 055, D2; plan 057, D1), built on the shadcn chart. Neutral
 * by default; a warning tone only when the tile itself is warning. No axes,
 * no tooltip, no animation: the number above it is the reading.
 */
export function Sparkline({
  points,
  label,
  tone = 'neutral',
  className,
  size = { width: 120, height: 24 }
}: {
  points: readonly number[]
  label: string
  tone?: 'neutral' | 'warning'
  className?: string
  /** The first frame's size, before the container is measured. */
  size?: { width: number; height: number }
}): ReactElement | null {
  if (points.length < 2) return null
  const config = {
    value: {
      label,
      color: tone === 'warning' ? 'var(--warning)' : 'var(--muted-foreground)'
    }
  } satisfies ChartConfig
  const data = points.map((value, index) => ({ index, value }))
  return (
    <ChartContainer
      aria-hidden
      className={cn('aspect-auto h-6 w-full', className)}
      config={config}
      data-slot="sparkline"
      initialDimension={size}
    >
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <YAxis dataKey="value" domain={['dataMin', 'dataMax']} hide />
        <Area
          dataKey="value"
          dot={false}
          fill="var(--color-value)"
          fillOpacity={0.14}
          isAnimationActive={false}
          stroke="var(--color-value)"
          strokeWidth={1.25}
          type="monotone"
        />
      </AreaChart>
    </ChartContainer>
  )
}
