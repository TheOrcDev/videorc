'use client'

import { createContext, useContext, useId, useMemo } from 'react'
import type { ComponentProps, KeyboardEvent } from 'react'

import { AudioConfigProvider } from '@/hooks/use-audio-config'
import type { AudioSize } from '@/hooks/use-audio-config'
import type { BallisticsInput } from '@/lib/audio/ballistics'
import type { MeterZone, Orientation } from '@/lib/audio/types'
import { cn } from '@/lib/utils'

const FOCUSABLE = "input, button, [tabindex]:not([tabindex='-1'])"
const STRIP_SELECTOR = "[data-slot='channel-strip']"

interface MixerContextValue {
  orientation: Orientation
  titleId: string
}

const MixerContext = createContext<MixerContextValue | null>(null)

const useMixerPart = (part: string) => {
  const context = useContext(MixerContext)
  if (!context) {
    throw new Error(`${part} must be used inside Mixer.`)
  }
  return context
}

/** The surrounding mixer's layout, for custom parts. */
export const useMixerContext = (): MixerContextValue => useMixerPart('useMixerContext')

export interface MixerProps extends ComponentProps<'div'> {
  /**
   * `horizontal` stacks row strips; `vertical` lays console strips side by
   * side. Default `horizontal`.
   */
  orientation?: Orientation
  size?: AudioSize
  /** Shared meter range. */
  minDb?: number
  maxDb?: number
  /** Shared meter zones. */
  zones?: MeterZone[]
  /** Shared meter movement. */
  ballistics?: BallisticsInput
  disabled?: boolean
}

export const Mixer = ({
  orientation = 'horizontal',
  size,
  minDb,
  maxDb,
  zones,
  ballistics,
  disabled,
  className,
  children,
  ...props
}: MixerProps) => {
  const titleId = useId()
  const contextValue = useMemo<MixerContextValue>(
    () => ({ orientation, titleId }),
    [orientation, titleId]
  )
  const stripOrientation: Orientation = orientation === 'horizontal' ? 'horizontal' : 'vertical'

  return (
    <MixerContext.Provider value={contextValue}>
      <AudioConfigProvider
        value={{
          ballistics,
          disabled,
          maxDb,
          minDb,
          orientation: stripOrientation,
          size,
          zones
        }}
      >
        <div
          aria-labelledby={titleId}
          className={cn(
            'group/mixer grid min-w-0 gap-3 [--mixer-gap:0.5rem]',
            orientation === 'horizontal'
              ? "grid-cols-1 [grid-template-areas:'header'_'channels'_'separator'_'master']"
              : "grid-cols-[minmax(0,1fr)_auto_auto] grid-rows-[auto_minmax(0,1fr)] [grid-template-areas:'header_header_header'_'channels_separator_master']",
            className
          )}
          data-orientation={orientation}
          data-size={size}
          data-slot="mixer"
          role="group"
          {...props}
        >
          {children}
        </div>
      </AudioConfigProvider>
    </MixerContext.Provider>
  )
}

export const MixerHeader = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    className={cn('flex min-w-0 items-center gap-2 [grid-area:header]', className)}
    data-slot="mixer-header"
    {...props}
  />
)

export const MixerTitle = ({ className, children, ...props }: ComponentProps<'h2'>) => {
  const { titleId } = useMixerPart('MixerTitle')
  return (
    <h2
      className={cn('font-heading mr-auto text-base font-medium', className)}
      data-slot="mixer-title"
      id={titleId}
      {...props}
    >
      {children}
    </h2>
  )
}

export const MixerActions = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('flex items-center gap-1', className)} data-slot="mixer-actions" {...props} />
)

const focusNeighbour = (event: KeyboardEvent<HTMLDivElement>, direction: number) => {
  const target = event.target as HTMLElement
  const strip = target.closest<HTMLElement>(STRIP_SELECTOR)
  if (!strip) {
    return false
  }
  const container = event.currentTarget
  const strips = [...container.querySelectorAll<HTMLElement>(STRIP_SELECTOR)]
  const neighbour = strips[strips.indexOf(strip) + direction]
  if (!neighbour) {
    return false
  }
  const slot = target.closest<HTMLElement>('[data-slot]')?.dataset.slot
  const match = slot ? neighbour.querySelector<HTMLElement>(`[data-slot='${slot}']`) : null
  const focusTarget = match?.matches(FOCUSABLE)
    ? match
    : (match?.querySelector<HTMLElement>(FOCUSABLE) ??
      neighbour.querySelector<HTMLElement>(FOCUSABLE))
  if (!focusTarget) {
    return false
  }
  focusTarget.focus()
  return true
}

export interface MixerChannelsProps extends ComponentProps<'div'> {
  /** Scroll along the strip axis when strips overflow. Default true. */
  scrollable?: boolean
}

export const MixerChannels = ({
  scrollable = true,
  className,
  children,
  onKeyDownCapture,
  ...props
}: MixerChannelsProps) => {
  const { orientation } = useMixerPart('MixerChannels')

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDownCapture?.(event)
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey)) {
      return
    }
    const previous = orientation === 'horizontal' ? 'ArrowUp' : 'ArrowLeft'
    const next = orientation === 'horizontal' ? 'ArrowDown' : 'ArrowRight'
    let direction = 0
    if (event.key === previous) {
      direction = -1
    } else if (event.key === next) {
      direction = 1
    }
    if (direction !== 0 && focusNeighbour(event, direction)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 gap-(--mixer-gap) [grid-area:channels]',
        orientation === 'horizontal' ? 'flex-col' : 'flex-row',
        scrollable && (orientation === 'horizontal' ? 'overflow-y-auto' : 'overflow-x-auto'),
        'empty:hidden',
        className
      )}
      data-slot="mixer-channels"
      onKeyDownCapture={handleKeyDown}
      {...props}
    >
      {children}
    </div>
  )
}

export const MixerSeparator = ({ className, ...props }: ComponentProps<'div'>) => {
  const { orientation } = useMixerPart('MixerSeparator')
  return (
    <div
      aria-hidden
      className={cn(
        'bg-border shrink-0 [grid-area:separator]',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className
      )}
      data-slot="mixer-separator"
      {...props}
    />
  )
}

export const MixerMaster = ({ className, ...props }: ComponentProps<'div'>) => {
  const { orientation } = useMixerPart('MixerMaster')
  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 [grid-area:master]',
        orientation === 'horizontal' ? 'flex-col' : 'flex-row',
        className
      )}
      data-slot="mixer-master"
      {...props}
    />
  )
}

/** Shown when `MixerChannels` renders nothing. */
export const MixerEmpty = ({ className, ...props }: ComponentProps<'div'>) => {
  useMixerPart('MixerEmpty')
  return (
    <div
      className={cn(
        'text-muted-foreground hidden min-h-24 items-center justify-center rounded-xl border border-dashed p-6 text-center text-sm [grid-area:channels] group-has-[[data-slot=mixer-channels]:empty]/mixer:flex',
        className
      )}
      data-slot="mixer-empty"
      {...props}
    />
  )
}
