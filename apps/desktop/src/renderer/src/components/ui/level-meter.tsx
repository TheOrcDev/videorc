'use client'

import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import type { ComponentProps, CSSProperties, Ref, RefObject } from 'react'

import { ClipIndicator } from '@/components/ui/clip-indicator'
import type { ClipIndicatorProps } from '@/components/ui/clip-indicator'
import { DbReadout, readChannel } from '@/components/ui/db-readout'
import type { DbReadoutProps } from '@/components/ui/db-readout'
import { DbScale } from '@/components/ui/db-scale'
import type { DbScaleProps } from '@/components/ui/db-scale'
import { useAudioConfig } from '@/hooks/use-audio-config'
import type { AudioSize } from '@/hooks/use-audio-config'
import { useFrameSource } from '@/hooks/use-frame-source'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useVisibility } from '@/hooks/use-visibility'
import { createBallistics, resolveBallistics } from '@/lib/audio/ballistics'
import type { Ballistics, BallisticsInput } from '@/lib/audio/ballistics'
import { DEFAULT_MAX_DB, DEFAULT_MIN_DB, formatDb, SILENCE_DB } from '@/lib/audio/decibels'
import { createFrameTask, createPainterClock } from '@/lib/audio/frame-loop'
import { createFrameEmitter } from '@/lib/audio/frame-source'
import { resolveTaper } from '@/lib/audio/taper'
import type { TaperInput } from '@/lib/audio/taper'
import type {
  ChannelLevel,
  FrameSource,
  MeterFrame,
  MeterZone,
  Orientation,
  Taper
} from '@/lib/audio/types'
import { CLIP_HOLD_MS, CLIP_THRESHOLD_DB, DEFAULT_ZONES, zoneForDb } from '@/lib/audio/zones'
import { cn } from '@/lib/utils'

const ARIA_INTERVAL_MS = 250
const REDUCED_MOTION_INTERVAL_MS = 250
const DEFAULT_SEGMENTS = 24
const POSITION_EPSILON = 0.0005
/**
 * A meter this close to its input has nothing visible left to animate (about
 * 0.06 dB on the default range, under a pixel on any meter), so it sleeps.
 */
const SETTLE_EPSILON = 0.001

export type LevelMeterVariant = 'solid' | 'segmented' | 'gradient'

export interface LevelMeterActions {
  /** Paint a frame directly, for callers that own their own frame loop. */
  paint: (frame: MeterFrame) => void
  /** Drop the level and the peak hold to silence. */
  reset: () => void
}

interface LevelMeterContextValue {
  orientation: Orientation
  variant: LevelMeterVariant
  minDb: number
  maxDb: number
  taper: Taper
  frames: FrameSource<MeterFrame>
  /** The declarative levels, when the meter has values instead of a source. */
  declared: MeterFrame | null
  registerChannel: (index: number, element: HTMLElement | null) => void
}

const LevelMeterContext = createContext<LevelMeterContextValue | null>(null)

const useLevelMeter = (part: string) => {
  const context = useContext(LevelMeterContext)
  if (!context) {
    throw new Error(`${part} must be used inside LevelMeter.`)
  }
  return context
}

/**
 * Zones in rising order, as a new array. An insertion rather than the ES2023
 * sorted-copy method, which projects compiling against ES2022 lack; a meter
 * has a handful of zones.
 */
const byFromDb = (zones: MeterZone[]): MeterZone[] => {
  const sorted: MeterZone[] = []
  for (const zone of zones) {
    const index = sorted.findIndex((other) => other.fromDb > zone.fromDb)
    if (index === -1) {
      sorted.push(zone)
    } else {
      sorted.splice(index, 0, zone)
    }
  }
  return sorted
}

const buildZoneFill = (
  zones: MeterZone[],
  taper: Taper,
  orientation: Orientation,
  variant: LevelMeterVariant
) => {
  const direction = orientation === 'horizontal' ? 'to right' : 'to top'
  const sorted = byFromDb(zones)
  // Rounded so the server and the browser print the same stops.
  const starts = sorted.map((zone) => Number((taper.toPosition(zone.fromDb) * 100).toFixed(3)))

  if (variant === 'gradient') {
    const stops = sorted.map((zone, index) => `var(--meter-${zone.zone}) ${starts[index] ?? 0}%`)
    const last = sorted.at(-1)
    return `linear-gradient(${direction}, ${stops.join(', ')}, var(--meter-${last?.zone ?? 'ok'}) 100%)`
  }

  const stops = sorted.map((zone, index) => {
    const start = starts[index] ?? 0
    const end = starts[index + 1] ?? 100
    return `var(--meter-${zone.zone}) ${start}% ${end}%`
  })
  return `linear-gradient(${direction}, ${stops.join(', ')})`
}

const buildSegmentMask = (orientation: Orientation, segments: number) => {
  const direction = orientation === 'horizontal' ? 'to right' : 'to top'
  const size = `calc(100% / ${segments})`
  return `repeating-linear-gradient(${direction}, black 0 calc(${size} - 2px), transparent calc(${size} - 2px) ${size})`
}

const serializeLevels = (
  channels: ChannelLevel[] | undefined,
  peakDb: number | undefined,
  rmsDb: number | undefined
): string => {
  if (channels) {
    return channels.map((level) => `${level.peakDb}:${level.rmsDb}`).join('|')
  }
  if (peakDb === undefined && rmsDb === undefined) {
    return ''
  }
  return `${peakDb ?? SILENCE_DB}:${rmsDb}`
}

const parseNumber = (text: string | undefined): number | undefined => {
  const value = Number(text)
  return Number.isNaN(value) ? undefined : value
}

const parseLevels = (key: string): MeterFrame | null => {
  if (key === '') {
    return null
  }
  return {
    channels: key.split('|').map((entry) => {
      const [peak, rms] = entry.split(':')
      return {
        peakDb: parseNumber(peak) ?? SILENCE_DB,
        rmsDb: parseNumber(rms)
      }
    })
  }
}

interface ChannelState {
  element: HTMLElement
  peak: Ballistics
  rms: Ballistics
  level: number
  rmsLevel: number
  hold: number
  zone: string
  /** Null until first painted, so a new painter always writes it. */
  active: boolean | null
}

/** Handed to the painter when it changes, so it never rebuilds the painter. */
interface MeterScale {
  maxDb: number
  minDb: number
  taper: Taper
  zones: MeterZone[]
}

interface PainterOptions {
  ballistics: BallisticsInput
  channels: Map<number, HTMLElement>
  latest: RefObject<MeterFrame | null>
  reducedMotion: boolean
  root: RefObject<HTMLElement | null>
  scale: MeterScale
  visible: RefObject<boolean>
}

interface MeterPainter {
  /** Paints one frame. Returns true while the meter needs another. */
  paint: (frameMs: number) => boolean
  /** A new range, taper or zones, used from the next frame. */
  setScale: (scale: MeterScale) => void
}

const silentLevel: ChannelLevel = { peakDb: SILENCE_DB }

const noop = () => {
  // Nothing to wake before the painter starts.
}

const writePosition = (element: HTMLElement, property: string, previous: number, next: number) => {
  if (Math.abs(previous - next) > POSITION_EPSILON) {
    element.style.setProperty(property, next.toFixed(4))
    return next
  }
  return previous
}

interface ChannelPaint {
  /** The smoothed peak this frame, in dBFS. */
  db: number
  /** Level, RMS and hold have all reached the input: nothing left to animate. */
  settled: boolean
}

/**
 * Paints a meter's channels outside React: steps ballistics, writes CSS
 * variables and data attributes, and throttles ARIA updates. Returns true
 * while it needs another frame, so a meter that has settled, or is off
 * screen, stops costing frames until something wakes it.
 */
const createMeterPainter = (options: PainterOptions): MeterPainter => {
  const ballisticsOptions: BallisticsInput = options.reducedMotion ? 'instant' : options.ballistics
  const states = new Map<number, ChannelState>()
  const clock = createPainterClock()
  let { scale } = options
  let clipUntil = 0
  // Null until first painted: a painter rebuilt mid-clip must still clear
  // the attribute the previous one left.
  let clippingShown: boolean | null = null
  let lastAriaMs = Number.NEGATIVE_INFINITY
  let ariaShown: string | null = null
  let rootZoneShown: string | null = null
  let lastPaintMs = Number.NEGATIVE_INFINITY

  const stateFor = (index: number, element: HTMLElement) => {
    const existing = states.get(index)
    if (existing && existing.element === element) {
      return existing
    }
    const created: ChannelState = {
      active: null,
      element,
      hold: -1,
      level: -1,
      peak: createBallistics(ballisticsOptions),
      rms: createBallistics({
        ...resolveBallistics(ballisticsOptions),
        peakHoldMs: 0
      }),
      rmsLevel: -1,
      zone: ''
    }
    states.set(index, created)
    return created
  }

  const paintChannel = (
    index: number,
    element: HTMLElement,
    input: ChannelLevel,
    nowMs: number
  ): ChannelPaint => {
    const state = stateFor(index, element)
    const inputRmsDb = input.rmsDb ?? input.peakDb
    const peak = state.peak.step(input.peakDb, nowMs)
    const rms = state.rms.step(inputRmsDb, nowMs)
    const { taper } = scale
    const level = taper.toPosition(peak.db)
    const rmsLevel = taper.toPosition(rms.db)
    const hold = taper.toPosition(peak.holdDb)
    state.level = writePosition(element, '--meter-level', state.level, level)
    state.rmsLevel = writePosition(element, '--meter-rms', state.rmsLevel, rmsLevel)
    state.hold = writePosition(element, '--meter-hold', state.hold, hold)

    const zone = zoneForDb(peak.db, scale.zones)
    if (zone !== state.zone) {
      state.zone = zone
      element.dataset.zone = zone
    }
    const active = state.level > 0
    if (active !== state.active) {
      state.active = active
      element.toggleAttribute('data-active', active)
    }
    const settled =
      Math.abs(level - taper.toPosition(input.peakDb)) <= SETTLE_EPSILON &&
      Math.abs(rmsLevel - taper.toPosition(inputRmsDb)) <= SETTLE_EPSILON &&
      Math.abs(hold - level) <= SETTLE_EPSILON
    return { db: peak.db, settled }
  }

  const paintRoot = (root: HTMLElement, loudest: number, nowMs: number, settled: boolean) => {
    const clipping = nowMs < clipUntil
    if (clipping !== clippingShown) {
      clippingShown = clipping
      root.toggleAttribute('data-clipping', clipping)
    }
    const text = formatDb(loudest, { floorDb: scale.minDb })
    const zone = zoneForDb(loudest, scale.zones)
    if (text === ariaShown && zone === rootZoneShown) {
      return
    }
    // Throttled while the level moves; a settled level is written at once,
    // so the value a screen reader finds is never a stale one.
    if (!settled && nowMs - lastAriaMs < ARIA_INTERVAL_MS) {
      return
    }
    lastAriaMs = nowMs
    ariaShown = text
    rootZoneShown = zone
    const clamped = Math.min(scale.maxDb, Math.max(scale.minDb, loudest))
    root.setAttribute('aria-valuenow', clamped.toFixed(1))
    root.setAttribute('aria-valuetext', text)
    root.dataset.zone = zone
  }

  const paint = (frameMs: number): boolean => {
    // Hidden: sleep. Coming back into view wakes the painter.
    if (!options.visible.current) {
      return false
    }
    const nowMs = clock(frameMs)
    if (options.reducedMotion && nowMs - lastPaintMs < REDUCED_MOTION_INTERVAL_MS) {
      return true
    }
    lastPaintMs = nowMs
    const frame = options.latest.current
    let loudest = SILENCE_DB
    let settled = true
    let inputClipping = false
    for (const [index, element] of options.channels) {
      const input = frame?.channels[index] ?? silentLevel
      if (input.peakDb >= CLIP_THRESHOLD_DB) {
        clipUntil = nowMs + CLIP_HOLD_MS
        inputClipping = true
      }
      const painted = paintChannel(index, element, input, nowMs)
      loudest = Math.max(loudest, painted.db)
      settled &&= painted.settled
    }
    const root = options.root.current
    if (root) {
      paintRoot(root, loudest, nowMs, settled)
    }
    // A clip light counting down after the input dropped needs the frames
    // that turn it off; one held by a still-clipping input does not.
    const releasingClip = nowMs < clipUntil && !inputClipping
    return !settled || releasingClip
  }

  return {
    paint,
    setScale: (next) => {
      scale = next
    }
  }
}

export const LevelMeterChannels = ({ className, ...props }: ComponentProps<'div'>) => {
  const { orientation } = useLevelMeter('LevelMeterChannels')
  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-1 gap-(--meter-gap)',
        orientation === 'horizontal' ? 'flex-col' : 'h-full flex-row',
        className
      )}
      data-orientation={orientation}
      data-slot="level-meter-channels"
      {...props}
    />
  )
}

export interface LevelMeterChannelProps extends ComponentProps<'div'> {
  /** Which channel of the frames this track shows. Default 0. */
  index?: number
}

export const LevelMeterChannel = ({
  index = 0,
  className,
  ref,
  ...props
}: LevelMeterChannelProps) => {
  const { orientation, registerChannel } = useLevelMeter('LevelMeterChannel')

  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      registerChannel(index, node)
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [index, ref, registerChannel]
  )

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 [--meter-hold:0] [--meter-level:0] [--meter-rms:0]',
        orientation === 'horizontal' ? 'w-full' : 'h-full',
        className
      )}
      data-index={index}
      data-orientation={orientation}
      data-slot="level-meter-channel"
      ref={setRef}
      {...props}
    />
  )
}

export const LevelMeterTrack = ({ className, children, ...props }: ComponentProps<'div'>) => {
  const { orientation, variant } = useLevelMeter('LevelMeterTrack')
  const horizontal = orientation === 'horizontal'

  return (
    <div
      className={cn(
        'bg-muted relative overflow-hidden rounded-full',
        horizontal ? 'h-(--meter-thickness) w-full' : 'h-full w-(--meter-thickness)',
        className
      )}
      data-orientation={orientation}
      data-slot="level-meter-track"
      {...props}
    >
      {variant === 'segmented' ? (
        <div
          aria-hidden
          className="absolute inset-0 bg-(image:--meter-fill) mask-(--meter-mask) opacity-20"
          data-slot="level-meter-segments"
        />
      ) : null}
      {children}
    </div>
  )
}

export interface LevelMeterBarProps extends ComponentProps<'div'> {
  /** Which measurement this bar shows. Layer a `rms` and a `peak` bar for a dual meter. Default `peak`. */
  measure?: 'peak' | 'rms'
}

export const LevelMeterBar = ({ measure = 'peak', className, ...props }: LevelMeterBarProps) => {
  const { orientation } = useLevelMeter('LevelMeterBar')
  const horizontal = orientation === 'horizontal'

  return (
    <div
      aria-hidden
      className={cn(
        'absolute inset-0 overflow-hidden',
        measure === 'rms'
          ? '[--meter-bar-level:var(--meter-rms)]'
          : '[--meter-bar-level:var(--meter-level)]',
        horizontal
          ? 'translate-x-[calc((var(--meter-bar-level)_-_1)_*_100%)]'
          : 'translate-y-[calc((1_-_var(--meter-bar-level))_*_100%)]',
        className
      )}
      data-measure={measure}
      data-slot="level-meter-bar"
      {...props}
    >
      <div
        className={cn(
          'absolute inset-0 bg-(image:--meter-fill) mask-(--meter-mask)',
          horizontal
            ? 'translate-x-[calc((1_-_var(--meter-bar-level))_*_100%)]'
            : 'translate-y-[calc((var(--meter-bar-level)_-_1)_*_100%)]'
        )}
        data-slot="level-meter-fill"
      />
    </div>
  )
}

export const LevelMeterHold = ({ className, ...props }: ComponentProps<'div'>) => {
  const { orientation } = useLevelMeter('LevelMeterHold')
  const horizontal = orientation === 'horizontal'

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 opacity-[calc(var(--meter-hold)_*_50)]',
        horizontal
          ? 'translate-x-[calc((var(--meter-hold)_-_1)_*_100%)]'
          : 'translate-y-[calc((1_-_var(--meter-hold))_*_100%)]'
      )}
      data-slot="level-meter-hold"
      {...props}
    >
      <div
        className={cn(
          'bg-foreground/80 absolute',
          horizontal ? 'inset-y-0 right-0 w-0.5' : 'inset-x-0 top-0 h-0.5',
          className
        )}
      />
    </div>
  )
}

export type LevelMeterScaleProps = Omit<DbScaleProps, 'minDb' | 'maxDb' | 'taper' | 'orientation'>

export const LevelMeterScale = (props: LevelMeterScaleProps) => {
  const { maxDb, minDb, orientation, taper } = useLevelMeter('LevelMeterScale')
  return <DbScale maxDb={maxDb} minDb={minDb} orientation={orientation} taper={taper} {...props} />
}

export type LevelMeterValueProps = Omit<DbReadoutProps, 'source' | 'value'>

export const LevelMeterValue = (props: LevelMeterValueProps) => {
  const { declared, frames, minDb } = useLevelMeter('LevelMeterValue')
  // Declarative levels only change on render, so show them as a value. A
  // stream keeps its live readout, which falls to −∞ when it stops.
  const value = declared
    ? readChannel(declared, props.measure ?? 'peak', props.channel ?? 'max')
    : undefined
  return (
    <DbReadout
      className="text-muted-foreground text-xs"
      floorDb={minDb}
      source={declared ? null : frames}
      value={value}
      {...props}
    />
  )
}

export type LevelMeterClipProps = Omit<ClipIndicatorProps, 'source'>

export const LevelMeterClip = (props: LevelMeterClipProps) => {
  const { frames } = useLevelMeter('LevelMeterClip')
  return <ClipIndicator source={frames} {...props} />
}

const levelMeterVariants = cva(
  'group/level-meter flex gap-2 [--meter-gap:0.25rem] data-dimmed:opacity-50',
  {
    defaultVariants: {
      orientation: 'horizontal',
      size: 'default'
    },
    variants: {
      orientation: {
        horizontal: 'w-full flex-row items-center',
        vertical: 'min-h-32 flex-col items-center'
      },
      size: {
        default: '[--meter-thickness:0.5rem]',
        lg: '[--meter-thickness:0.75rem]',
        sm: '[--meter-thickness:0.25rem]'
      }
    }
  }
)

export interface LevelMeterProps
  extends ComponentProps<'div'>, Omit<VariantProps<typeof levelMeterVariants>, 'orientation'> {
  /** A meter source; the meter subscribes and paints itself without re-rendering React. */
  source?: FrameSource<MeterFrame> | null
  /** Mono peak level in dBFS, for declarative use. */
  peakDb?: number
  /** Mono RMS level in dBFS, for declarative use. */
  rmsDb?: number
  /** Levels per channel, for declarative multi-channel use. */
  channels?: ChannelLevel[]
  /** Tracks to render before data arrives. Default 1. */
  channelCount?: number
  /** Bottom of the displayed range. Default −60. */
  minDb?: number
  /** Top of the displayed range. Default 0. */
  maxDb?: number
  /** Colour zones. Default ok / warn from −20 / clip from −9. */
  zones?: MeterZone[]
  /** How the meter moves. Default `peak`. */
  ballistics?: BallisticsInput
  /** Scale law. Default `linear`. */
  taper?: TaperInput
  orientation?: Orientation
  /** `segmented` is an LED ladder. Default `solid`. */
  variant?: LevelMeterVariant
  /** Segments for the `segmented` variant. Default 24. */
  segments?: number
  actionsRef?: Ref<LevelMeterActions>
}

interface MeterSettings {
  orientation: Orientation
  size: AudioSize
  minDb: number
  maxDb: number
  zones: MeterZone[]
  ballistics: BallisticsInput
  dimmed: boolean
}

/** Explicit props win over the surrounding mixer or strip. */
const useMeterSettings = (props: Partial<MeterSettings>): MeterSettings => {
  const config = useAudioConfig()
  return {
    ballistics: props.ballistics ?? config.ballistics ?? 'peak',
    dimmed: config.dimmed ?? false,
    maxDb: props.maxDb ?? config.maxDb ?? DEFAULT_MAX_DB,
    minDb: props.minDb ?? config.minDb ?? DEFAULT_MIN_DB,
    orientation: props.orientation ?? config.orientation ?? 'horizontal',
    size: props.size ?? config.size ?? 'default',
    zones: props.zones ?? config.zones ?? DEFAULT_ZONES
  }
}

export const LevelMeter = ({
  source,
  peakDb,
  rmsDb,
  channels,
  channelCount: channelCountProp,
  minDb: minDbProp,
  maxDb: maxDbProp,
  zones: zonesProp,
  ballistics: ballisticsProp,
  taper = 'linear',
  orientation: orientationProp,
  variant = 'solid',
  segments = DEFAULT_SEGMENTS,
  size: sizeProp,
  actionsRef,
  className,
  children,
  ref,
  style,
  ...props
}: LevelMeterProps) => {
  const settings = useMeterSettings({
    ballistics: ballisticsProp,
    maxDb: maxDbProp,
    minDb: minDbProp,
    orientation: orientationProp,
    size: sizeProp ?? undefined,
    zones: zonesProp
  })
  const { maxDb, minDb, orientation, zones } = settings
  const reducedMotion = useReducedMotion()
  const frames = useMemo(() => createFrameEmitter<MeterFrame>(), [])
  const latestRef = useRef<MeterFrame | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const channelsRef = useRef(new Map<number, HTMLElement>())
  // Wakes the painter when something changed. A settled meter sleeps.
  const wakeRef = useRef<() => void>(noop)
  const visibleRef = useVisibility(rootRef, (visible) => {
    if (visible) {
      wakeRef.current()
    }
  })
  const [observedCount, setObservedCount] = useState<number | null>(null)

  const accept = useCallback(
    (frame: MeterFrame) => {
      latestRef.current = frame
      frames.emit(frame)
      wakeRef.current()
    },
    [frames]
  )

  const acceptAndCount = useCallback(
    (frame: MeterFrame) => {
      accept(frame)
      const count = frame.channels.length
      if (count > 0) {
        setObservedCount((previous) => (previous === count ? previous : count))
      }
    },
    [accept]
  )

  useFrameSource(source, acceptAndCount)

  const declarativeKey = serializeLevels(channels, peakDb, rmsDb)
  let declaredCount: number | null = null
  if (channels) {
    declaredCount = channels.length
  } else if (declarativeKey !== '') {
    declaredCount = 1
  }
  const channelCount = declaredCount ?? observedCount ?? channelCountProp ?? 1
  const declared = useMemo(
    () => (source ? null : parseLevels(declarativeKey)),
    [declarativeKey, source]
  )

  useEffect(() => {
    const frame = parseLevels(declarativeKey)
    if (frame) {
      accept(frame)
    }
  }, [accept, declarativeKey])

  const taperFn = useMemo(() => resolveTaper(taper, minDb, maxDb), [taper, minDb, maxDb])

  const registerChannel = useCallback((index: number, element: HTMLElement | null) => {
    if (element) {
      channelsRef.current.set(index, element)
    } else {
      channelsRef.current.delete(index)
    }
    wakeRef.current()
  }, [])

  const ballisticsKey = JSON.stringify(
    typeof settings.ballistics === 'string'
      ? settings.ballistics
      : resolveBallistics(settings.ballistics)
  )

  // Scale changes (an inline zones array, a new range) reach the painter on
  // its next frame instead of rebuilding it and resetting the ballistics.
  const scale = useMemo<MeterScale>(
    () => ({ maxDb, minDb, taper: taperFn, zones }),
    [maxDb, minDb, taperFn, zones]
  )
  const readScale = useEffectEvent(() => scale)
  const painterRef = useRef<MeterPainter | null>(null)

  useEffect(() => {
    const painter = createMeterPainter({
      ballistics: JSON.parse(ballisticsKey) as BallisticsInput,
      channels: channelsRef.current,
      latest: latestRef,
      reducedMotion,
      root: rootRef,
      scale: readScale(),
      visible: visibleRef
    })
    const task = createFrameTask(painter.paint)
    painterRef.current = painter
    wakeRef.current = task.wake
    return () => {
      painterRef.current = null
      wakeRef.current = noop
      task.stop()
    }
  }, [ballisticsKey, reducedMotion, visibleRef])

  // A new range or zones array reaches the painter, and repaints a meter that
  // had settled.
  useEffect(() => {
    painterRef.current?.setScale(scale)
    wakeRef.current()
  }, [scale])

  useImperativeHandle(
    actionsRef,
    () => ({
      paint: acceptAndCount,
      reset: () => {
        accept({ channels: [] })
      }
    }),
    [accept, acceptAndCount]
  )

  const zoneFill = useMemo(
    () => buildZoneFill(zones, taperFn, orientation, variant),
    [orientation, taperFn, variant, zones]
  )
  const segmentMask = variant === 'segmented' ? buildSegmentMask(orientation, segments) : 'none'

  const contextValue = useMemo<LevelMeterContextValue>(
    () => ({
      declared,
      frames,
      maxDb,
      minDb,
      orientation,
      registerChannel,
      taper: taperFn,
      variant
    }),
    [declared, frames, maxDb, minDb, orientation, registerChannel, taperFn, variant]
  )

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

  return (
    <LevelMeterContext.Provider value={contextValue}>
      <div
        aria-valuemax={maxDb}
        aria-valuemin={minDb}
        aria-valuenow={minDb}
        className={cn(levelMeterVariants({ orientation, size: settings.size }), className)}
        data-dimmed={settings.dimmed ? '' : undefined}
        data-orientation={orientation}
        data-size={settings.size}
        data-slot="level-meter"
        data-variant={variant}
        ref={setRootRef}
        role="meter"
        style={
          {
            '--meter-fill': zoneFill,
            '--meter-mask': segmentMask,
            ...style
          } as CSSProperties
        }
        {...props}
      >
        {children ?? (
          <LevelMeterChannels>
            {Array.from({ length: channelCount }, (_, index) => (
              <LevelMeterChannel index={index} key={`channel-${index}`}>
                <LevelMeterTrack>
                  <LevelMeterBar />
                  <LevelMeterHold />
                </LevelMeterTrack>
              </LevelMeterChannel>
            ))}
          </LevelMeterChannels>
        )}
      </div>
    </LevelMeterContext.Provider>
  )
}

export { levelMeterVariants }
