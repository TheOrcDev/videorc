'use client'

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react'
import type { ComponentProps, CSSProperties } from 'react'

import { useAudioConfig } from '@/hooks/use-audio-config'
import { DEFAULT_MAX_DB, DEFAULT_MIN_DB, formatDb } from '@/lib/audio/decibels'
import { resolveTaper } from '@/lib/audio/taper'
import type { TaperInput } from '@/lib/audio/taper'
import type { Orientation, Taper } from '@/lib/audio/types'
import { cn } from '@/lib/utils'

const DEFAULT_TICKS = [12, 6, 0, -6, -12, -18, -24, -36, -48, -60, -72, -90]
const EDGE = 0.02
/** Space kept between two labels, in pixels. */
const LABEL_GAP = 3
const MAJOR_STEP = 12

/**
 * Hides labels that would touch a more important one, so narrow scales stay
 * readable: 0 dB first, then the ends, then multiples of 12, then the rest.
 */
export const thinDbScaleLabels = (scale: HTMLElement) => {
  const horizontal = scale.dataset.orientation !== 'vertical'
  const entries: { label: HTMLElement; rank: number; value: number }[] = []
  for (const tick of scale.querySelectorAll<HTMLElement>('[data-slot=db-scale-tick]')) {
    const label = tick.querySelector<HTMLElement>('[data-slot=db-scale-label]')
    if (label) {
      delete label.dataset.hidden
      entries.push({ label, rank: 3, value: Number(tick.dataset.value) })
    }
  }
  const values = entries.map((entry) => entry.value)
  const top = Math.max(...values)
  const bottom = Math.min(...values)
  for (const entry of entries) {
    if (entry.value === 0) {
      entry.rank = 0
    } else if (entry.value === top || entry.value === bottom) {
      entry.rank = 1
    } else if (entry.value % MAJOR_STEP === 0) {
      entry.rank = 2
    }
  }
  entries.sort((a, b) => a.rank - b.rank || b.value - a.value)

  const kept: [number, number][] = []
  for (const { label } of entries) {
    const rect = label.getBoundingClientRect()
    // Not laid out, so there is nothing to compare.
    if (rect.width === 0 && rect.height === 0) {
      continue
    }
    const start = horizontal ? rect.left : rect.top
    const end = horizontal ? rect.right : rect.bottom
    const collides = kept.some(
      ([keptStart, keptEnd]) => start < keptEnd + LABEL_GAP && end > keptStart - LABEL_GAP
    )
    if (collides) {
      label.dataset.hidden = ''
    } else {
      kept.push([start, end])
    }
  }
}

const defaultFormat = (db: number) => formatDb(db, { decimals: 0, unit: false })

interface DbScaleContextValue {
  orientation: Orientation
  side: 'start' | 'end'
  labels: boolean
  taper: Taper
  format: (db: number) => string
}

const DbScaleContext = createContext<DbScaleContextValue | null>(null)

const useDbScale = () => {
  const context = useContext(DbScaleContext)
  if (!context) {
    throw new Error('DbScaleTick must be used inside DbScale.')
  }
  return context
}

/** Keeps labels at the ends of the scale inside it. */
const alignClass = (orientation: Orientation, position: number) => {
  if (orientation === 'vertical') {
    if (position < EDGE) {
      return 'translate-y-0'
    }
    return position > 1 - EDGE ? 'translate-y-full' : 'translate-y-1/2'
  }
  if (position < EDGE) {
    return 'translate-x-0'
  }
  return position > 1 - EDGE ? '-translate-x-full' : '-translate-x-1/2'
}

const markClass = (horizontal: boolean, major: boolean) => {
  if (horizontal) {
    return major ? 'h-1.5 w-px' : 'h-1 w-px'
  }
  return major ? 'h-px w-1.5' : 'h-px w-1'
}

export interface DbScaleTickProps extends ComponentProps<'div'> {
  value: number
  /** Major ticks are longer. Default true. */
  major?: boolean
}

export const DbScaleTick = ({
  value,
  major = true,
  className,
  children,
  style,
  ...props
}: DbScaleTickProps) => {
  const { format, labels, orientation, side, taper } = useDbScale()
  const position = taper.toPosition(value)
  const horizontal = orientation === 'horizontal'
  const reversed = side === 'start'

  return (
    <div
      className={cn(
        'absolute flex items-center gap-0.5',
        horizontal
          ? 'top-0 left-(--tick-position) h-full flex-col'
          : 'bottom-(--tick-position) left-0 w-full flex-row',
        reversed && (horizontal ? 'flex-col-reverse' : 'flex-row-reverse'),
        alignClass(orientation, position),
        className
      )}
      data-major={major ? '' : undefined}
      data-slot="db-scale-tick"
      data-value={value}
      style={{ '--tick-position': `${position * 100}%`, ...style } as CSSProperties}
      {...props}
    >
      <span
        className={cn('bg-border shrink-0', markClass(horizontal, major))}
        data-slot="db-scale-mark"
      />
      {labels ? (
        <span
          className={cn(
            'data-hidden:invisible',
            // Right-aligned so the last digits of a vertical scale line up.
            !horizontal && 'flex-1 text-end'
          )}
          data-slot="db-scale-label"
        >
          {children ?? format(value)}
        </span>
      ) : null}
    </div>
  )
}

export interface DbScaleProps extends ComponentProps<'div'> {
  /** Bottom of the range. Default −60, or the surrounding meter's range. */
  minDb?: number
  /** Top of the range. Default 0, or the surrounding meter's range. */
  maxDb?: number
  /** Tick values. Default: common values inside the range. */
  ticks?: number[]
  /** Position law, so ticks line up with a fader or meter using the same taper. */
  taper?: TaperInput
  orientation?: Orientation
  /** Which side of the tick marks the labels sit on. Default `end`. */
  side?: 'start' | 'end'
  /** Show labels. Default true. */
  labels?: boolean
  format?: (db: number) => string
}

export const DbScale = ({
  minDb: minDbProp,
  maxDb: maxDbProp,
  ticks,
  taper = 'linear',
  orientation: orientationProp,
  side = 'end',
  labels = true,
  format = defaultFormat,
  className,
  children,
  ref,
  ...props
}: DbScaleProps) => {
  const config = useAudioConfig()
  const minDb = minDbProp ?? config.minDb ?? DEFAULT_MIN_DB
  const maxDb = maxDbProp ?? config.maxDb ?? DEFAULT_MAX_DB
  const orientation = orientationProp ?? config.orientation ?? 'horizontal'

  const value = useMemo<DbScaleContextValue>(
    () => ({
      format,
      labels,
      orientation,
      side,
      taper: resolveTaper(taper, minDb, maxDb)
    }),
    [format, labels, maxDb, minDb, orientation, side, taper]
  )

  const values = ticks ?? DEFAULT_TICKS.filter((tick) => tick >= minDb && tick <= maxDb)

  const scaleRef = useRef<HTMLDivElement | null>(null)
  const setScaleRef = useCallback(
    (node: HTMLDivElement | null) => {
      scaleRef.current = node
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [ref]
  )

  // Re-check label collisions when the scale resizes or its ticks change.
  useLayoutEffect(() => {
    const scale = scaleRef.current
    if (!(scale && labels)) {
      return
    }
    let cancelled = false
    const thin = () => thinDbScaleLabels(scale)
    thin()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(thin)
    resize?.observe(scale)
    // Only style changes: hiding a label must not trigger another pass.
    const ticksChanged = new MutationObserver(thin)
    ticksChanged.observe(scale, {
      attributeFilter: ['style'],
      characterData: true,
      childList: true,
      subtree: true
    })
    const afterFonts = async () => {
      await document.fonts?.ready
      if (!cancelled) {
        thin()
      }
    }
    afterFonts()
    return () => {
      cancelled = true
      resize?.disconnect()
      ticksChanged.disconnect()
    }
  }, [labels])

  return (
    <DbScaleContext.Provider value={value}>
      <div
        aria-hidden
        className={cn(
          'text-muted-foreground relative shrink-0 text-[0.625rem] leading-none tabular-nums select-none',
          orientation === 'horizontal' ? 'h-4 w-full' : 'h-full w-7',
          className
        )}
        data-orientation={orientation}
        data-side={side}
        data-slot="db-scale"
        ref={setScaleRef}
        {...props}
      >
        {children ?? values.map((tick) => <DbScaleTick key={tick} value={tick} />)}
      </div>
    </DbScaleContext.Provider>
  )
}
