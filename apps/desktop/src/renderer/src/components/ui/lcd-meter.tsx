'use client'

import { cva } from 'class-variance-authority'
import { createContext, useCallback, useContext, useLayoutEffect, useRef } from 'react'
import type { ComponentProps, CSSProperties, RefObject } from 'react'

import { DbScale } from '@/components/ui/db-scale'
import { useLcdDisplay } from '@/components/ui/lcd-display'
import {
  LevelMeter,
  LevelMeterChannel,
  LevelMeterClip,
  LevelMeterValue,
  useLevelMeter
} from '@/components/ui/level-meter'
import type {
  LevelMeterChannelProps,
  LevelMeterClipProps,
  LevelMeterProps,
  LevelMeterValueProps
} from '@/components/ui/level-meter'
import { formatDb } from '@/lib/audio/decibels'
import { cn } from '@/lib/utils'

/** The marks a recorder screen prints, kept to the meter's range. */
const DEFAULT_TICKS = [6, 3, 0, -3, -6, -12, -24, -48]
/** Off the dot grid by less than this, in pixels, counts as on it. */
const GRID_EPSILON = 0.01

/**
 * Segments in dots of the display's pitch, so every segment edge falls
 * between two dots. Each thickness centres the track on a line of text of
 * that size with a whole number of dots above and below it.
 */
const lcdMeterVariants = cva(
  '[--lcd-meter-gap:var(--lcd-display-pitch)] [--lcd-meter-nudge-x:0px] [--lcd-meter-nudge-y:0px] [--lcd-meter-segment:calc(var(--lcd-display-pitch)*3)] [--lcd-meter-unlit:color-mix(in_oklab,var(--lcd-display-lit)_14%,transparent)]',
  {
    defaultVariants: {
      size: 'default'
    },
    variants: {
      size: {
        default: '[--lcd-meter-thickness:calc(var(--lcd-display-pitch)*7)]',
        lg: '[--lcd-meter-thickness:calc(var(--lcd-display-pitch)*10)]',
        sm: '[--lcd-meter-thickness:calc(var(--lcd-display-pitch)*5)]'
      }
    }
  }
)

/** A segment and the gap after it. */
const PERIOD = '[--lcd-meter-period:calc(var(--lcd-meter-segment)_+_var(--lcd-meter-gap))]'

/**
 * Starts on the dot grid, and cuts the column down to whole segments so the
 * last one is never cut.
 */
const ON_GRID =
  'ml-(--lcd-meter-nudge-x) w-[calc(round(down,_100%_-_var(--lcd-meter-nudge-x)_+_var(--lcd-meter-gap),_var(--lcd-meter-period))_-_var(--lcd-meter-gap))]'

const SEGMENT_MASK =
  'mask-[repeating-linear-gradient(to_right,#000_0_var(--lcd-meter-segment),transparent_var(--lcd-meter-segment)_var(--lcd-meter-period))]'

/** The display's dot grid, for a track on a screen whose own mask is off. */
const DOT_MASK =
  'mask-[radial-gradient(circle,#000_58%,transparent_64%)] mask-size-[var(--lcd-display-pitch)_var(--lcd-display-pitch)]'

/** The channel a readout inside a row shows. */
const ChannelContext = createContext<number | null>(null)

/** L and R for a pair, numbers for more, nothing for one. */
const channelLabel = (index: number, count: number) => {
  if (count === 2) {
    return index === 0 ? 'L' : 'R'
  }
  return count > 2 ? String(index + 1) : null
}

/** How far short of the next dot a distance ends, or 0 on a dot. */
const toNextDot = (distance: number, pitch: number) => {
  const past = ((distance % pitch) + pitch) % pitch
  return past < GRID_EPSILON || pitch - past < GRID_EPSILON ? 0 : pitch - past
}

/**
 * The screen's dot pitch in pixels, read from its dot mask, which the browser
 * reports in pixels. 0 with the mask off, when there is no grid to meet.
 */
const pitchOf = (content: HTMLElement) => {
  const [width = ''] = (getComputedStyle(content).maskSize || '').split(' ')
  return width.endsWith('px') ? Number(width.slice(0, -'px'.length)) : 0
}

/**
 * The screen's dot mask starts at its content box, so a segment edge falls
 * between dots only when the tracks start a whole number of dots from it.
 * Labels of any width, or rows above of any height, can leave them part of a
 * dot off; this measures the first track and moves the tracks onto the grid.
 */
const useDotGrid = (rootRef: RefObject<HTMLDivElement | null>) => {
  const nudgeRef = useRef({ x: 0, y: 0 })
  // Every render: a new label or row changes the layout without a resize.
  useLayoutEffect(() => {
    const root = rootRef.current
    const content = root?.closest<HTMLElement>('[data-slot=lcd-display-content]')
    if (!(root && content)) {
      return
    }
    const align = () => {
      const nudge = nudgeRef.current
      const track = root.querySelector<HTMLElement>('[data-slot=lcd-meter-track]')
      const pitch = pitchOf(content)
      let x = 0
      let y = 0
      if (track && pitch > 0) {
        const origin = content.getBoundingClientRect()
        const rect = track.getBoundingClientRect()
        x = toNextDot(rect.left - nudge.x - origin.left, pitch)
        y = toNextDot(rect.top - nudge.y - origin.top, pitch)
      }
      if (x !== nudge.x) {
        nudge.x = x
        root.style.setProperty('--lcd-meter-nudge-x', `${x}px`)
      }
      if (y !== nudge.y) {
        nudge.y = y
        root.style.setProperty('--lcd-meter-nudge-y', `${y}px`)
      }
    }
    align()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const resize = new ResizeObserver(align)
    resize.observe(content)
    for (const label of root.querySelectorAll('[data-slot=lcd-meter-label]')) {
      resize.observe(label)
    }
    return () => {
      resize.disconnect()
    }
  })
}

/** Magnitudes, as recorder screens print them; above 0 keeps its plus. */
const printMagnitude = (db: number) =>
  formatDb(db, { decimals: 0, sign: db > 0 ? 'auto' : 'never', unit: false })

export type LcdMeterChannelProps = LevelMeterChannelProps

/** One row of the meter: a label, a track and a readout for one channel. */
export const LcdMeterChannel = ({ index = 0, className, ...props }: LcdMeterChannelProps) => (
  <ChannelContext.Provider value={index}>
    <LevelMeterChannel
      className={cn('col-span-full grid grid-cols-subgrid items-center', className)}
      data-slot="lcd-meter-channel"
      index={index}
      {...props}
    />
  </ChannelContext.Provider>
)

/** Dim text naming a channel, in a column a whole number of dots wide. */
export const LcdMeterLabel = ({ className, ...props }: ComponentProps<'span'>) => (
  <span
    className={cn(
      'col-start-1 min-w-[round(up,_1.5em,_var(--lcd-display-pitch))] text-(--lcd-display-ink-dim)',
      className
    )}
    data-slot="lcd-meter-label"
    {...props}
  />
)

/** The unlit segments, which the bar and the held peak light. */
export const LcdMeterTrack = ({ className, children, ...props }: ComponentProps<'div'>) => {
  const matrix = useLcdDisplay()?.matrix ?? true
  return (
    <div
      className={cn(
        'relative col-start-2 h-(--lcd-meter-thickness)',
        PERIOD,
        ON_GRID,
        !matrix && DOT_MASK,
        className
      )}
      data-slot="lcd-meter-track"
      {...props}
    >
      <div
        className={cn('absolute inset-0 bg-(--lcd-meter-unlit)', SEGMENT_MASK)}
        data-slot="lcd-meter-segments"
      >
        {children}
      </div>
    </div>
  )
}

export interface LcdMeterBarProps extends ComponentProps<'div'> {
  /** Which measurement this bar shows. Layer a `rms` and a `peak` bar for a dual meter. Default `peak`. */
  measure?: 'peak' | 'rms'
}

/** The lit segments. A segment lights whole or not at all. */
export const LcdMeterBar = ({ measure = 'peak', className, ...props }: LcdMeterBarProps) => (
  <div
    aria-hidden
    className={cn(
      'absolute inset-0 bg-(--lcd-display-lit) [clip-path:inset(0_calc(100%_-_round(up,_var(--lcd-meter-bar-level)_*_100%,_var(--lcd-meter-period)))_0_0)]',
      measure === 'rms'
        ? '[--lcd-meter-bar-level:var(--meter-rms)]'
        : '[--lcd-meter-bar-level:var(--meter-level)]',
      className
    )}
    data-measure={measure}
    data-slot="lcd-meter-bar"
    {...props}
  />
)

/** One lit segment at the held peak, hidden at silence. */
export const LcdMeterHold = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    aria-hidden
    className={cn(
      'absolute inset-y-0 left-[calc(round(up,_var(--meter-hold)_*_100%,_var(--lcd-meter-period))_-_var(--lcd-meter-period))] w-(--lcd-meter-segment) bg-(--lcd-display-lit) opacity-[calc(var(--meter-hold)_*_1000)]',
      className
    )}
    data-slot="lcd-meter-hold"
    {...props}
  />
)

export type LcdMeterValueProps = LevelMeterValueProps

/**
 * The level in bright digits, without a unit. Inside a channel it shows that
 * channel, elsewhere the loudest one.
 */
export const LcdMeterValue = ({
  channel,
  unit = false,
  className,
  ...props
}: LcdMeterValueProps) => {
  const index = useContext(ChannelContext)
  return (
    <LevelMeterValue
      channel={channel ?? index ?? 'max'}
      // The readout sizes itself in ch; 1.2 adds the screen's 0.12em of
      // tracking per character of a 0.6em mono digit, so it never changes width.
      className={cn(
        'col-start-3 min-w-[calc(var(--db-readout-width)*1.2)] font-(family-name:--lcd-display-font) text-(--lcd-display-lit)',
        className
      )}
      data-slot="lcd-meter-value"
      unit={unit}
      {...props}
    />
  )
}

export interface LcdMeterScaleProps extends ComponentProps<'div'> {
  /** Tick values. Default: 48, 24, 12, 6, 3 and 0 below, inside the range. */
  ticks?: number[]
  /** Text for each tick. Default: the magnitude, with a plus above 0. */
  format?: (db: number) => string
  /** Print a bracket over the clip zone. Default true. */
  bracket?: boolean
}

/** Dim numbers under the tracks, and a bracket over the clip zone. */
export const LcdMeterScale = ({
  ticks,
  format = printMagnitude,
  bracket = true,
  className,
  ...props
}: LcdMeterScaleProps) => {
  const { maxDb, minDb, taper, zones } = useLevelMeter('LcdMeterScale')
  let clipFromDb = Number.POSITIVE_INFINITY
  for (const zone of zones) {
    if (zone.zone === 'clip') {
      clipFromDb = Math.min(clipFromDb, zone.fromDb)
    }
  }
  const showBracket = bracket && clipFromDb < maxDb
  return (
    <div
      className={cn(
        'col-start-2 flex flex-col gap-(--lcd-display-pitch)',
        PERIOD,
        ON_GRID,
        className
      )}
      data-slot="lcd-meter-scale"
      {...props}
    >
      {showBracket ? (
        <div
          aria-hidden
          className="relative h-[calc(var(--lcd-display-pitch)*2)]"
          data-slot="lcd-meter-bracket"
          style={
            {
              '--lcd-meter-bracket-start': taper.toPosition(clipFromDb).toFixed(4)
            } as CSSProperties
          }
        >
          {/* Starts where the first segment of the zone does. */}
          <div className="absolute inset-y-0 right-0 left-[round(down,_var(--lcd-meter-bracket-start)_*_100%,_var(--lcd-meter-period))] border-x-(length:--lcd-display-pitch) border-t-(length:--lcd-display-pitch) border-(--lcd-display-ink-dim)" />
        </div>
      ) : null}
      <DbScale
        className="h-[round(up,_1em,_var(--lcd-display-pitch))] text-[0.75em] text-(--lcd-display-ink-dim) [&_[data-slot=db-scale-mark]]:hidden"
        format={format}
        maxDb={maxDb}
        minDb={minDb}
        orientation="horizontal"
        taper={taper}
        ticks={ticks ?? DEFAULT_TICKS.filter((tick) => tick >= minDb && tick <= maxDb)}
      />
    </div>
  )
}

export type LcdMeterClipProps = LevelMeterClipProps

/** A CLIP flag: an unlit ghost that inverts while the clip hold is on. */
export const LcdMeterClip = ({ className, children, ...props }: LcdMeterClipProps) => (
  <LevelMeterClip
    className={cn(
      'col-start-3 h-auto self-end justify-self-end rounded-sm px-1 py-0.5 text-[0.75em] font-normal text-(--lcd-meter-unlit) uppercase transition-none hover:bg-transparent focus-visible:ring-1 focus-visible:ring-(--lcd-display-lit) data-clipping:bg-(--lcd-display-lit) data-clipping:text-(--lcd-display-glass)',
      className
    )}
    data-slot="lcd-meter-clip"
    {...props}
  >
    {children ?? 'Clip'}
  </LevelMeterClip>
)

const LcdMeterRows = () => {
  const { channelCount } = useLevelMeter('LcdMeter')
  return (
    <>
      {Array.from({ length: channelCount }, (_, index) => {
        const label = channelLabel(index, channelCount)
        return (
          <LcdMeterChannel index={index} key={`channel-${index}`}>
            {label ? <LcdMeterLabel>{label}</LcdMeterLabel> : null}
            <LcdMeterTrack>
              <LcdMeterBar />
              <LcdMeterHold />
            </LcdMeterTrack>
            <LcdMeterValue />
          </LcdMeterChannel>
        )
      })}
      <LcdMeterScale />
      <LcdMeterClip />
    </>
  )
}

export type LcdMeterProps = Omit<LevelMeterProps, 'orientation' | 'segments' | 'size' | 'variant'>

/**
 * A level meter drawn on an `LcdDisplay`'s screen: block segments in the
 * display's ink, a held peak, readouts, a scale and a CLIP flag. Metering is
 * `LevelMeter`'s; the size and colours come from the display. The `audio`
 * taper gives the loud end of the range most of the track, like a recorder.
 */
export const LcdMeter = ({
  taper = 'audio',
  className,
  children,
  ref,
  ...props
}: LcdMeterProps) => {
  const display = useLcdDisplay()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [ref]
  )
  useDotGrid(rootRef)
  if (!display) {
    throw new Error('LcdMeter must be used inside LcdDisplay.')
  }
  return (
    <LevelMeter
      className={cn(
        lcdMeterVariants({ size: display.size }),
        'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-[calc(var(--lcd-display-pitch)*4)] gap-y-[calc(var(--lcd-display-pitch)*2)] pt-[calc(0.75rem_+_var(--lcd-meter-nudge-y))] pb-3 has-[[data-slot=db-scale]]:pb-3',
        className
      )}
      data-slot="lcd-meter"
      orientation="horizontal"
      ref={setRootRef}
      size={display.size}
      taper={taper}
      {...props}
    >
      {children ?? <LcdMeterRows />}
    </LevelMeter>
  )
}

export { lcdMeterVariants }
