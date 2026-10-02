'use client'

import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'

import { useAudioConfig } from '@/hooks/use-audio-config'
import { cn } from '@/lib/utils'

const channelToggleVariants = cva(
  "group/channel-toggle focus-visible:ring-ring/30 inline-flex shrink-0 items-center justify-center gap-1 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    defaultVariants: {
      size: 'default',
      tone: 'neutral',
      variant: 'default'
    },
    variants: {
      size: {
        default: 'h-7 min-w-7 px-1.5',
        icon: 'size-7',
        lg: 'h-8 min-w-8 px-2',
        sm: 'h-6 min-w-6 px-1'
      },
      tone: {
        monitor:
          'data-pressed:border-channel-monitor/40 data-pressed:bg-channel-monitor/15 data-pressed:text-channel-monitor-foreground',
        mute: 'data-pressed:border-channel-mute/40 data-pressed:bg-channel-mute/15 data-pressed:text-channel-mute-foreground',
        neutral: 'data-pressed:bg-foreground data-pressed:text-background',
        solo: 'data-pressed:border-channel-solo/50 data-pressed:bg-channel-solo/20 data-pressed:text-channel-solo-foreground'
      },
      variant: {
        default: 'bg-muted text-muted-foreground hover:text-foreground',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        outline:
          'border-border text-muted-foreground hover:bg-muted hover:text-foreground border bg-transparent'
      }
    }
  }
)

export type ChannelToggleProps = TogglePrimitive.Props & VariantProps<typeof channelToggleVariants>

export const ChannelToggle = ({
  className,
  tone = 'neutral',
  variant = 'default',
  size = 'default',
  disabled,
  ...props
}: ChannelToggleProps) => {
  const config = useAudioConfig()
  return (
    <TogglePrimitive
      className={cn(channelToggleVariants({ size, tone, variant }), className)}
      data-slot="channel-toggle"
      data-tone={tone}
      disabled={disabled ?? config.disabled}
      {...props}
    />
  )
}

export type ChannelTogglePresetProps = Omit<ChannelToggleProps, 'tone'>

export const MuteToggle = (props: ChannelTogglePresetProps) => (
  <ChannelToggle aria-label="Mute" data-slot="mute-toggle" tone="mute" {...props} />
)

export const SoloToggle = (props: ChannelTogglePresetProps) => (
  <ChannelToggle aria-label="Solo" data-slot="solo-toggle" tone="solo" {...props} />
)

export const MonitorToggle = (props: ChannelTogglePresetProps) => (
  <ChannelToggle aria-label="Monitor" data-slot="monitor-toggle" tone="monitor" {...props} />
)

export { channelToggleVariants }
