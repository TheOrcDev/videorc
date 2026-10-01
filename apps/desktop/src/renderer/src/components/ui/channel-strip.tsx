'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef } from 'react'
import type { ComponentProps, CSSProperties } from 'react'

import { Badge } from '@/components/ui/badge'
import { AudioConfigProvider, useAudioConfig } from '@/hooks/use-audio-config'
import type { AudioSize } from '@/hooks/use-audio-config'
import type { Orientation } from '@/lib/audio/types'
import { cn } from '@/lib/utils'

interface ChannelStripContextValue {
  orientation: Orientation
  titleId: string
  muted: boolean
  solo: boolean
  dimmed: boolean
}

const ChannelStripContext = createContext<ChannelStripContextValue | null>(null)

const useChannelStripContext = (part: string) => {
  const context = useContext(ChannelStripContext)
  if (!context) {
    throw new Error(`${part} must be used inside ChannelStrip.`)
  }
  return context
}

/** The state of the surrounding channel strip, for custom parts. */
export const useChannelStrip = (): ChannelStripContextValue =>
  useChannelStripContext('useChannelStrip')

const channelStripVariants = cva(
  'group/channel-strip data-selected:ring-ring/40 relative min-w-0 transition-[opacity,box-shadow] outline-none data-disabled:opacity-60 data-selected:ring-2',
  {
    defaultVariants: {
      orientation: 'horizontal',
      variant: 'default'
    },
    variants: {
      orientation: {
        // A row measures itself, so it can stack its header on narrow widths.
        horizontal: '@container/channel-strip w-full',
        // Console strips keep their width and let the mixer scroll instead.
        vertical: 'flex h-full min-h-72 w-[var(--channel-strip-width,6.5rem)] shrink-0 flex-col'
      },
      variant: {
        card: 'bg-card text-card-foreground rounded-xl border p-3 shadow-xs',
        default: 'bg-muted/40 rounded-xl p-3',
        ghost: 'p-2',
        master: 'bg-muted/60 ring-primary/10 rounded-xl border p-3 ring-1'
      }
    }
  }
)

/**
 * The grid the parts place themselves on, by area name. A row stacks its
 * header above the meter and fader until the strip is 36rem wide.
 */
const channelStripLayoutVariants = cva('grid gap-x-3 gap-y-1.5', {
  defaultVariants: { orientation: 'horizontal' },
  variants: {
    orientation: {
      horizontal: [
        "w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center [grid-template-areas:'header_header_header'_'meter_value_controls'_'fader_value_controls']",
        "has-[>[data-slot=channel-strip-notice]]:[grid-template-areas:'header_header_header'_'meter_value_controls'_'fader_value_controls'_'notice_notice_notice']",
        "@xl/channel-strip:grid-cols-[minmax(0,var(--channel-strip-header-width,12rem))_minmax(0,1fr)_auto_auto] @xl/channel-strip:[grid-template-areas:'header_meter_value_controls'_'header_fader_value_controls']",
        "@xl/channel-strip:has-[>[data-slot=channel-strip-notice]]:[grid-template-areas:'header_meter_value_controls'_'header_fader_value_controls'_'notice_notice_notice_notice']"
      ],
      vertical:
        "flex-1 grid-cols-[1fr_auto_auto_1fr] grid-rows-[auto_minmax(0,1fr)_auto_auto_auto] justify-items-center [grid-template-areas:'header_header_header_header'_'._meter_fader_.'_'value_value_value_value'_'controls_controls_controls_controls'_'notice_notice_notice_notice']"
    }
  }
})

export interface ChannelStripProps
  extends
    useRender.ComponentProps<'div'>,
    Omit<VariantProps<typeof channelStripVariants>, 'orientation'> {
  /** Horizontal is a row; vertical is a console strip. Inherited from a mixer. */
  orientation?: Orientation
  size?: AudioSize
  muted?: boolean
  solo?: boolean
  /** Silenced by another channel's solo. */
  dimmed?: boolean
  selected?: boolean
  /** Disables every control inside. */
  disabled?: boolean
  /** A CSS colour for the channel's colour tag. */
  accent?: string
}

export const ChannelStrip = ({
  orientation: orientationProp,
  variant = 'default',
  size: sizeProp,
  muted = false,
  solo = false,
  dimmed = false,
  selected = false,
  disabled: disabledProp,
  accent,
  render,
  className,
  style,
  children,
  ref,
  ...props
}: ChannelStripProps) => {
  const config = useAudioConfig()
  const orientation = orientationProp ?? config.orientation ?? 'horizontal'
  const size = sizeProp ?? config.size ?? 'default'
  const disabled = disabledProp ?? config.disabled ?? false
  const titleId = useId()
  const rootRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof MutationObserver === 'undefined') {
      return
    }
    const update = () => {
      const clipping = root.querySelector("[data-slot='level-meter'][data-clipping]") !== null
      root.toggleAttribute('data-clipping', clipping)
    }
    const observer = new MutationObserver(update)
    // childList too: a meter removed mid-clip must clear the strip.
    observer.observe(root, {
      attributeFilter: ['data-clipping'],
      attributes: true,
      childList: true,
      subtree: true
    })
    update()
    return () => {
      observer.disconnect()
    }
  }, [])

  const setRootRef = useCallback(
    (node: HTMLElement | null) => {
      rootRef.current = node
      if (typeof ref === 'function') {
        ref(node as HTMLDivElement | null)
      } else if (ref) {
        ref.current = node as HTMLDivElement | null
      }
    },
    [ref]
  )

  const contextValue = useMemo<ChannelStripContextValue>(
    () => ({ dimmed, muted, orientation, solo, titleId }),
    [dimmed, muted, orientation, solo, titleId]
  )

  const element = useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(
      {
        'aria-labelledby': titleId,
        children: (
          <ChannelStripContext.Provider value={contextValue}>
            <AudioConfigProvider value={{ dimmed: muted || dimmed, disabled, orientation, size }}>
              <div
                className={channelStripLayoutVariants({ orientation })}
                data-slot="channel-strip-layout"
              >
                {children}
              </div>
            </AudioConfigProvider>
          </ChannelStripContext.Provider>
        ),
        className: cn(
          channelStripVariants({ orientation, variant }),
          accent &&
            (orientation === 'horizontal'
              ? 'before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-full before:bg-(--channel-accent)'
              : 'before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:rounded-full before:bg-(--channel-accent)'),
          className
        ),
        role: 'group',
        style: {
          ...(accent ? { '--channel-accent': accent } : {}),
          ...style
        } as CSSProperties
      },
      props
    ),
    ref: setRootRef,
    render,
    state: {
      dimmed,
      disabled,
      muted,
      orientation,
      selected,
      size,
      slot: 'channel-strip',
      solo,
      variant
    }
  })

  return element
}

export const ChannelStripHeader = ({ className, ...props }: ComponentProps<'div'>) => {
  const { orientation } = useChannelStripContext('ChannelStripHeader')
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 [grid-area:header]',
        orientation === 'vertical' ? 'w-full flex-col text-center *:max-w-full' : 'flex-wrap',
        className
      )}
      data-slot="channel-strip-header"
      {...props}
    />
  )
}

export const ChannelStripIcon = ({ className, ...props }: ComponentProps<'span'>) => (
  <span
    aria-hidden
    className={cn(
      "bg-background text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg shadow-xs [&_svg:not([class*='size-'])]:size-4",
      className
    )}
    data-slot="channel-strip-icon"
    {...props}
  />
)

export const ChannelStripTitle = ({ className, ...props }: ComponentProps<'span'>) => {
  const { titleId } = useChannelStripContext('ChannelStripTitle')
  return (
    <span
      className={cn('truncate text-sm leading-tight font-medium', className)}
      data-slot="channel-strip-title"
      id={titleId}
      {...props}
    />
  )
}

export const ChannelStripDescription = ({ className, ...props }: ComponentProps<'span'>) => (
  <span
    className={cn('text-muted-foreground truncate text-xs leading-tight', className)}
    data-slot="channel-strip-description"
    {...props}
  />
)

/** Groups a title and description so they stack next to an icon. */
export const ChannelStripText = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    className={cn(
      'flex min-w-0 flex-1 flex-col gap-0.5 group-data-[orientation=horizontal]/channel-strip:min-w-20',
      className
    )}
    data-slot="channel-strip-text"
    {...props}
  />
)

const STATUS_CLASS = {
  default: '',
  error: '',
  live: 'bg-meter-ok/15 text-meter-ok-foreground',
  muted: 'bg-channel-mute/15 text-channel-mute-foreground',
  warning: 'bg-meter-warn/20 text-foreground'
} as const

export interface ChannelStripStatusProps extends ComponentProps<typeof Badge> {
  tone?: 'default' | 'live' | 'muted' | 'warning' | 'error'
}

export const ChannelStripStatus = ({
  tone = 'default',
  className,
  ...props
}: ChannelStripStatusProps) => {
  let variant: 'secondary' | 'destructive' | 'outline' = 'outline'
  if (tone === 'error') {
    variant = 'destructive'
  } else if (tone === 'default') {
    variant = 'secondary'
  }
  return (
    <Badge
      className={cn('shrink-0', STATUS_CLASS[tone], className)}
      data-slot="channel-strip-status"
      data-tone={tone}
      variant={variant}
      {...props}
    />
  )
}

export const ChannelStripActions = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    className={cn('ml-auto flex shrink-0 items-center gap-1', className)}
    data-slot="channel-strip-actions"
    {...props}
  />
)

export const ChannelStripMeter = ({ className, ...props }: ComponentProps<'div'>) => {
  const { orientation } = useChannelStripContext('ChannelStripMeter')
  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 [grid-area:meter]',
        orientation === 'horizontal' ? 'w-full items-center' : 'h-full justify-center',
        className
      )}
      data-slot="channel-strip-meter"
      {...props}
    />
  )
}

export const ChannelStripFader = ({ className, ...props }: ComponentProps<'div'>) => {
  const { orientation } = useChannelStripContext('ChannelStripFader')
  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 [grid-area:fader] [&_[data-slot=fader-control]]:p-0 [&_[data-slot=fader-scale]]:p-0',
        orientation === 'horizontal'
          ? 'w-full items-center [&_[data-slot=fader-control]:only-child]:my-[calc((var(--fader-track-size)-var(--fader-thumb-size))/2)]'
          : 'h-full justify-center [&_[data-slot=fader-control]:only-child]:mx-[calc((var(--fader-track-size)-var(--fader-thumb-size))/2)]',
        className
      )}
      data-slot="channel-strip-fader"
      {...props}
    />
  )
}

export const ChannelStripValue = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    className={cn(
      // Wide enough for "−60.0 dB", so dragging a fader never resizes the row.
      'text-muted-foreground flex min-w-[8ch] items-center justify-end font-mono text-xs whitespace-nowrap tabular-nums [grid-area:value] group-data-[orientation=vertical]/channel-strip:justify-center',
      className
    )}
    data-slot="channel-strip-value"
    {...props}
  />
)

export const ChannelStripControls = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    className={cn('flex items-center justify-center gap-1 [grid-area:controls]', className)}
    data-slot="channel-strip-controls"
    {...props}
  />
)

const noticeVariants = cva(
  "flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs [grid-area:notice] [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    defaultVariants: { variant: 'default' },
    variants: {
      variant: {
        default: 'bg-muted text-muted-foreground',
        destructive: 'bg-destructive/10 text-destructive',
        warning: 'bg-meter-warn/15 text-foreground'
      }
    }
  }
)

export interface ChannelStripNoticeProps
  extends ComponentProps<'div'>, VariantProps<typeof noticeVariants> {}

export const ChannelStripNotice = ({
  variant = 'default',
  className,
  ...props
}: ChannelStripNoticeProps) => (
  <div
    className={cn(noticeVariants({ variant }), 'w-full', className)}
    data-slot="channel-strip-notice"
    data-variant={variant}
    role={variant === 'destructive' ? 'alert' : 'status'}
    {...props}
  />
)

export { channelStripLayoutVariants, channelStripVariants }
