'use client'

import * as React from 'react'
import * as RechartsPrimitive from 'recharts'
import type { TooltipValueType } from 'recharts'

import { cn } from '@/lib/utils'

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = { dark: '.dark', light: '' } as const

const INITIAL_DIMENSION = { height: 200, width: 320 } as const
type TooltipNameType = number | string

/**
 * A series' label, icon and colour. Videorc's chrome is monochrome, so a
 * series is neutral (`var(--muted-foreground)`, `var(--foreground)`) unless
 * its colour means something: `var(--warning)` for a reading that needs
 * attention, `var(--destructive)` for a failure, a `--color-platform-*` tint
 * for a platform's own series.
 */
export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode
    icon?: React.ComponentType
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  )
>

interface ChartContextProps {
  config: ChartConfig
}

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)

  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />')
  }

  return context
}

function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
  initialDimension?: {
    width: number
    height: number
  }
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${id ?? uniqueId.replaceAll(':', '')}`
  const context = React.useMemo(() => ({ config }), [config])

  return (
    <ChartContext.Provider value={context}>
      <div
        className={cn(
          "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border flex aspect-video justify-center text-xs [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
          className
        )}
        data-chart={chartId}
        data-slot="chart"
        {...props}
      >
        <ChartStyle config={config} id={chartId} />
        <RechartsPrimitive.ResponsiveContainer initialDimension={initialDimension}>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(
    ([, itemConfig]) => itemConfig.theme ?? itemConfig.color
  )

  if (!colorConfig.length) {
    return null
  }

  // Each series' colour becomes `--color-<key>` on this chart, per theme. A
  // stylesheet is the one way to scope a value under `.dark`.
  return (
    // oxlint-disable-next-line shadcn/no-inline-styles -- The per-chart, per-theme series colours have no static class.
    <style
      // oxlint-disable-next-line react/no-danger -- The CSS is built from the chart's own config, never from user input.
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] ?? itemConfig.color
    return color ? `  --color-${key}: ${color};` : null
  })
  .join('\n')}
}
`
          )
          .join('\n')
      }}
    />
  )
}

const ChartTooltip = RechartsPrimitive.Tooltip

type ChartTooltipContentProps = React.ComponentProps<typeof RechartsPrimitive.Tooltip> &
  React.ComponentProps<'div'> & {
    hideLabel?: boolean
    hideIndicator?: boolean
    indicator?: 'line' | 'dot' | 'dashed'
    nameKey?: string
    labelKey?: string
  } & Omit<
    RechartsPrimitive.DefaultTooltipContentProps<TooltipValueType, TooltipNameType>,
    'accessibilityLayer'
  >

type ChartTooltipPayloadItem = NonNullable<ChartTooltipContentProps['payload']>[number]

function ChartTooltipIndicator({
  color,
  indicator,
  nestLabel
}: {
  color: string | undefined
  indicator: 'line' | 'dot' | 'dashed'
  nestLabel: boolean
}) {
  return (
    <div
      className={cn('shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)', {
        'h-2.5 w-2.5': indicator === 'dot',
        'my-0.5': nestLabel && indicator === 'dashed',
        'w-0 border-[1.5px] border-dashed bg-transparent': indicator === 'dashed',
        'w-1': indicator === 'line'
      })}
      style={
        {
          '--color-bg': color,
          '--color-border': color
        } as React.CSSProperties
      }
    />
  )
}

type ChartTooltipItemProps = Pick<
  ChartTooltipContentProps,
  'color' | 'formatter' | 'hideIndicator' | 'nameKey'
> & {
  item: ChartTooltipPayloadItem
  index: number
  indicator: 'line' | 'dot' | 'dashed'
  nestLabel: boolean
  tooltipLabel: React.ReactNode
}

function formatTooltipValue(value: ChartTooltipPayloadItem['value']) {
  if (value === null || value === undefined) {
    return null
  }
  return (
    <span className="text-foreground font-mono font-medium tabular-nums">
      {typeof value === 'number' ? value.toLocaleString() : String(value)}
    </span>
  )
}

function ChartTooltipEntry({
  item,
  color,
  hideIndicator,
  indicator,
  nameKey,
  nestLabel,
  tooltipLabel
}: Omit<ChartTooltipItemProps, 'formatter' | 'index'>) {
  const { config } = useChart()
  const key = `${nameKey ?? item.name ?? item.dataKey ?? 'value'}`
  const itemConfig = getPayloadConfigFromPayload(config, item, key)

  let marker: React.ReactNode = null
  if (itemConfig?.icon) {
    marker = <itemConfig.icon />
  } else if (!hideIndicator) {
    marker = (
      <ChartTooltipIndicator
        color={color ?? item.payload?.fill ?? item.color}
        indicator={indicator}
        nestLabel={nestLabel}
      />
    )
  }

  return (
    <>
      {marker}
      <div
        className={cn(
          'flex flex-1 justify-between leading-none',
          nestLabel ? 'items-end' : 'items-center'
        )}
      >
        <div className="grid gap-1.5">
          {nestLabel ? tooltipLabel : null}
          <span className="text-muted-foreground">{itemConfig?.label ?? item.name}</span>
        </div>
        {formatTooltipValue(item.value)}
      </div>
    </>
  )
}

function ChartTooltipItem({ formatter, index, ...props }: ChartTooltipItemProps) {
  const { item, indicator } = props
  return (
    <div
      className={cn(
        '[&>svg]:text-muted-foreground flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5',
        indicator === 'dot' && 'items-center'
      )}
    >
      {formatter && item.value !== undefined && item.name ? (
        formatter(item.value, item.name, item, index, item.payload)
      ) : (
        <ChartTooltipEntry {...props} />
      )}
    </div>
  )
}

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = 'dot',
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey
}: ChartTooltipContentProps) {
  const { config } = useChart()

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) {
      return null
    }

    const [item] = payload
    const key = `${labelKey ?? item?.dataKey ?? item?.name ?? 'value'}`
    const itemConfig = getPayloadConfigFromPayload(config, item, key)
    const value =
      !labelKey && typeof label === 'string' ? (config[label]?.label ?? label) : itemConfig?.label

    if (labelFormatter) {
      return (
        <div className={cn('font-medium', labelClassName)}>{labelFormatter(value, payload)}</div>
      )
    }

    if (!value) {
      return null
    }

    return <div className={cn('font-medium', labelClassName)}>{value}</div>
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey])

  if (!active || !payload?.length) {
    return null
  }

  const nestLabel = payload.length === 1 && indicator !== 'dot'

  return (
    // A chart tooltip floats on the popup glass, never bg-popover with a
    // ring and a shadow.
    <div
      className={cn(
        'rounded-row glass-float text-popover-foreground grid min-w-32 items-start gap-1.5 border px-2.5 py-1.5 text-xs',
        className
      )}
      data-slot="chart-tooltip"
    >
      {nestLabel ? null : tooltipLabel}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== 'none')
          .map((item, index) => (
            <ChartTooltipItem
              color={color}
              formatter={formatter}
              hideIndicator={hideIndicator}
              index={index}
              indicator={indicator}
              item={item}
              key={`${item.dataKey ?? item.name ?? index}`}
              nameKey={nameKey}
              nestLabel={nestLabel}
              tooltipLabel={tooltipLabel}
            />
          ))}
      </div>
    </div>
  )
}

const ChartLegend = RechartsPrimitive.Legend

function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = 'bottom',
  nameKey
}: React.ComponentProps<'div'> & {
  hideIcon?: boolean
  nameKey?: string
} & RechartsPrimitive.DefaultLegendContentProps) {
  const { config } = useChart()

  if (!payload?.length) {
    return null
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center gap-4',
        verticalAlign === 'top' ? 'pb-3' : 'pt-3',
        className
      )}
      data-slot="chart-legend"
    >
      {payload
        .filter((item) => item.type !== 'none')
        .map((item, index) => {
          const key = `${nameKey ?? item.dataKey ?? 'value'}`
          const itemConfig = getPayloadConfigFromPayload(config, item, key)

          return (
            <div
              className="[&>svg]:text-muted-foreground flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3"
              key={`${item.dataKey ?? item.value ?? index}`}
            >
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <div
                  className="h-2 w-2 shrink-0 rounded-[2px] bg-(--color-bg)"
                  style={{ '--color-bg': item.color } as React.CSSProperties}
                />
              )}
              {itemConfig?.label}
            </div>
          )
        })}
    </div>
  )
}

function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== 'object' || payload === null) {
    return
  }

  const payloadPayload =
    'payload' in payload && typeof payload.payload === 'object' && payload.payload !== null
      ? payload.payload
      : undefined

  let configLabelKey: string = key

  if (key in payload && typeof payload[key as keyof typeof payload] === 'string') {
    configLabelKey = payload[key as keyof typeof payload] as string
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key as keyof typeof payloadPayload] === 'string'
  ) {
    configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string
  }

  return configLabelKey in config ? config[configLabelKey] : config[key]
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle
}
