'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { Slider as SliderPrimitive } from '@base-ui/react/slider'
import { useRender } from '@base-ui/react/use-render'
import { cva } from 'class-variance-authority'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { ComponentProps, CSSProperties, KeyboardEvent, RefObject } from 'react'

import { DbScale } from '@/components/ui/db-scale'
import type { DbScaleProps } from '@/components/ui/db-scale'
import { useAudioConfig } from '@/hooks/use-audio-config'
import type { AudioSize } from '@/hooks/use-audio-config'
import { clamp, formatDb, SILENCE_DB } from '@/lib/audio/decibels'
import { resolveTaper } from '@/lib/audio/taper'
import type { TaperInput } from '@/lib/audio/taper'
import type { Orientation, Taper } from '@/lib/audio/types'
import { cn } from '@/lib/utils'

const DEFAULT_MIN_DB = -60
const DEFAULT_MAX_DB = 6
const POSITION_STEP = 0.0005
const DETENT_SNAP = 0.012
const PRECISION = 1e6
const DEFAULT_DETENTS = [0]
const DB_SUFFIX = /db/iu
const INFINITY_TEXT = /^-?(?:inf|infinity|∞)$/iu

export type FaderChangeReason = 'drag' | 'track-press' | 'keyboard' | 'wheel' | 'reset' | 'input'

export interface FaderChangeDetails {
  reason: FaderChangeReason
  event?: Event
}

interface FaderContextValue {
  ariaLabel?: string
  ariaLabelledBy?: string
  value: number
  position: number
  originPosition: number
  min: number
  max: number
  resetValue: number
  orientation: Orientation
  variant: 'default' | 'console'
  size: AudioSize
  disabled: boolean
  taper: Taper
  format: (db: number) => string
  change: (db: number, details: FaderChangeDetails) => void
  commit: (db: number) => void
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}

const FaderContext = createContext<FaderContextValue | null>(null)

const useFader = (part: string) => {
  const context = useContext(FaderContext)
  if (!context) {
    throw new Error(`${part} must be used inside Fader.`)
  }
  return context
}

const defaultFormat = (db: number) => (db === SILENCE_DB ? 'Silent' : formatDb(db))

const roundValue = (value: number) => Math.round(value * PRECISION) / PRECISION

/** A ref that always holds the latest value, for event handlers. */
const useLatest = <T,>(value: T): RefObject<T> => {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

export const FaderLabel = ({ className, ...props }: SliderPrimitive.Label.Props) => (
  <SliderPrimitive.Label
    className={cn('text-sm font-medium', className)}
    data-slot="fader-label"
    {...props}
  />
)

export const FaderTrack = ({ className, children, ...props }: SliderPrimitive.Control.Props) => {
  const { orientation } = useFader('FaderTrack')
  const horizontal = orientation === 'horizontal'

  return (
    <SliderPrimitive.Control
      className={cn(
        'relative flex min-h-0 min-w-0 items-center',
        horizontal
          ? 'h-(--fader-thumb-size) w-full px-[calc(var(--fader-thumb-size)/2)] before:absolute before:inset-x-0 before:-inset-y-1.5 pointer-coarse:before:-inset-y-3'
          : 'h-full w-(--fader-thumb-size) flex-col py-[calc(var(--fader-thumb-size)/2)] before:absolute before:-inset-x-1.5 before:inset-y-0 pointer-coarse:before:-inset-x-3'
      )}
      data-slot="fader-control"
      {...props}
    >
      <SliderPrimitive.Track
        className={cn(
          'bg-input/90 relative grow rounded-full',
          horizontal ? 'h-(--fader-track-size) w-full' : 'h-full w-(--fader-track-size)',
          className
        )}
        data-slot="fader-track"
      >
        {children}
      </SliderPrimitive.Track>
    </SliderPrimitive.Control>
  )
}

export const FaderRange = ({ className, style, ...props }: ComponentProps<'div'>) => {
  const { orientation, originPosition, position } = useFader('FaderRange')
  const start = Math.min(originPosition, position) * 100
  const end = Math.max(originPosition, position) * 100

  return (
    <div
      className={cn(
        'bg-primary absolute rounded-full',
        orientation === 'horizontal'
          ? 'inset-y-0 left-(--fader-range-start) w-(--fader-range-size)'
          : 'inset-x-0 bottom-(--fader-range-start) h-(--fader-range-size)',
        className
      )}
      data-slot="fader-range"
      style={
        {
          '--fader-range-size': `${end - start}%`,
          '--fader-range-start': `${start}%`,
          ...style
        } as CSSProperties
      }
      {...props}
    />
  )
}

const thumbVariants = cva(
  'bg-background ring-foreground/15 hover:ring-ring/30 focus-visible:ring-ring/40 data-dragging:ring-ring/30 block shrink-0 shadow-sm ring-1 outline-hidden transition-[box-shadow] hover:ring-4 focus-visible:ring-4 data-disabled:pointer-events-none data-dragging:ring-4',
  {
    compoundVariants: [
      {
        className:
          'h-[calc(var(--fader-thumb-size)*1.6)] w-[calc(var(--fader-thumb-size)*0.7)] bg-[linear-gradient(to_right,transparent_calc(50%-0.5px),var(--foreground)_calc(50%-0.5px),var(--foreground)_calc(50%+0.5px),transparent_calc(50%+0.5px))]',
        orientation: 'horizontal',
        variant: 'console'
      },
      {
        className:
          'h-[calc(var(--fader-thumb-size)*0.7)] w-[calc(var(--fader-thumb-size)*1.8)] bg-[linear-gradient(to_bottom,transparent_calc(50%-0.5px),var(--foreground)_calc(50%-0.5px),var(--foreground)_calc(50%+0.5px),transparent_calc(50%+0.5px))]',
        orientation: 'vertical',
        variant: 'console'
      }
    ],
    defaultVariants: {
      orientation: 'horizontal',
      variant: 'default'
    },
    variants: {
      orientation: {
        horizontal: '',
        vertical: ''
      },
      variant: {
        console: 'border-border rounded-sm border',
        default: 'size-(--fader-thumb-size) rounded-full'
      }
    }
  }
)

export type FaderThumbProps = Omit<SliderPrimitive.Thumb.Props, 'getAriaValueText' | 'onKeyDown'>

export const FaderThumb = ({ className, onDoubleClick, ...props }: FaderThumbProps) => {
  const {
    ariaLabel,
    ariaLabelledBy,
    change,
    commit,
    format,
    handleKeyDown,
    orientation,
    resetValue,
    value,
    variant
  } = useFader('FaderThumb')

  return (
    <SliderPrimitive.Thumb
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={cn(thumbVariants({ orientation, variant }), className)}
      data-slot="fader-thumb"
      getAriaValueText={() => format(value)}
      onDoubleClick={(event) => {
        onDoubleClick?.(event)
        change(resetValue, { event: event.nativeEvent, reason: 'reset' })
        commit(resetValue)
      }}
      onKeyDown={handleKeyDown}
      {...props}
    />
  )
}

export type FaderScaleProps = Omit<DbScaleProps, 'minDb' | 'maxDb' | 'taper' | 'orientation'>

export const FaderScale = ({ className, ...props }: FaderScaleProps) => {
  const { max, min, orientation, taper } = useFader('FaderScale')
  const horizontal = orientation === 'horizontal'

  return (
    <div
      className={cn(
        horizontal
          ? 'px-[calc(var(--fader-thumb-size)/2)]'
          : 'py-[calc(var(--fader-thumb-size)/2)]',
        className
      )}
      data-slot="fader-scale"
    >
      <DbScale maxDb={max} minDb={min} orientation={orientation} taper={taper} {...props} />
    </div>
  )
}

const parseDb = (text: string): number | null => {
  const normalized = text.replaceAll('−', '-').replace(DB_SUFFIX, '').trim()
  if (INFINITY_TEXT.test(normalized)) {
    return SILENCE_DB
  }
  if (normalized === '') {
    return null
  }
  const parsed = Number(normalized)
  return Number.isNaN(parsed) ? null : parsed
}

export interface FaderValueProps extends ComponentProps<'span'> {
  /** Click to type a value. Default false. */
  editable?: boolean
}

/** Levels whose text is as wide as any a fader shows: two digits either side of 0. */
const WIDTH_SAMPLES_DB = [-88.8, -8.8, 8.8, 88.8]

/** Characters in the widest value this fader can show. */
const widestValue = (format: (db: number) => string, min: number, max: number) =>
  Math.max(
    ...[
      SILENCE_DB,
      min,
      min + 0.1,
      max,
      max - 0.1,
      ...WIDTH_SAMPLES_DB.filter((db) => db > min && db < max)
    ].map((db) => format(db).length)
  )

export const FaderValue = ({ editable = false, className, style, ...props }: FaderValueProps) => {
  const { change, commit, disabled, format, max, min, value } = useFader('FaderValue')
  // A fixed width, so moving the fader never shifts the layout around it.
  const widthStyle = {
    '--fader-value-width': `${widestValue(format, min, max)}ch`,
    ...style
  } as CSSProperties
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const focusInput = useCallback((node: HTMLInputElement | null) => {
    node?.focus()
    node?.select()
  }, [])

  const finish = (apply: boolean) => {
    setEditing(false)
    if (!apply) {
      return
    }
    const parsed = parseDb(draft)
    if (parsed === null) {
      return
    }
    const next = parsed === SILENCE_DB ? min : clamp(parsed, min, max)
    change(next, { reason: 'input' })
    commit(next)
  }

  if (editing) {
    return (
      <input
        aria-label="Value in dB"
        className={cn(
          'bg-background focus-visible:ring-ring/30 h-6 w-[calc(var(--fader-value-width)+0.75rem)] rounded-md border px-[calc(0.375rem-1px)] text-end font-mono text-xs tabular-nums outline-none focus-visible:ring-3',
          className
        )}
        data-slot="fader-value-input"
        onBlur={() => finish(true)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            finish(true)
          } else if (event.key === 'Escape') {
            finish(false)
          }
        }}
        ref={focusInput}
        style={widthStyle}
        value={draft}
      />
    )
  }

  const text = format(value)

  if (editable) {
    return (
      <button
        className={cn(
          'text-muted-foreground hover:bg-muted focus-visible:ring-ring/30 h-6 w-[calc(var(--fader-value-width)+0.75rem)] shrink-0 rounded-md text-end font-mono text-xs tabular-nums outline-none focus-visible:ring-3',
          'px-1.5',
          className
        )}
        data-slot="fader-value"
        disabled={disabled}
        onClick={() => {
          setDraft(value === SILENCE_DB ? '-inf' : String(value))
          setEditing(true)
        }}
        style={widthStyle}
        type="button"
      >
        {text}
      </button>
    )
  }

  return (
    <span
      className={cn(
        'text-muted-foreground inline-block w-(--fader-value-width) shrink-0 text-end font-mono text-xs whitespace-nowrap tabular-nums',
        className
      )}
      data-slot="fader-value"
      style={widthStyle}
      {...props}
    >
      {text}
    </span>
  )
}

export type FaderResetProps = useRender.ComponentProps<'button'>

export const FaderReset = ({ render, className, children, ...props }: FaderResetProps) => {
  const { change, commit, disabled, resetValue, value } = useFader('FaderReset')
  const modified = value !== resetValue

  return useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(
      {
        'aria-label': 'Reset',
        children: children ?? 'Reset',
        className: cn(
          'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/30 inline-flex h-6 items-center rounded-md px-1.5 text-xs outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-0',
          className
        ),
        disabled: disabled || !modified,
        onClick: () => {
          change(resetValue, { reason: 'reset' })
          commit(resetValue)
        },
        type: 'button'
      },
      props
    ),
    render,
    state: {
      modified,
      slot: 'fader-reset'
    }
  })
}

const faderVariants = cva(
  'group/fader relative flex touch-none gap-2 select-none data-disabled:opacity-50',
  {
    defaultVariants: {
      orientation: 'horizontal',
      size: 'default'
    },
    variants: {
      orientation: {
        horizontal: 'w-full flex-col',
        vertical: 'h-full min-h-32 flex-row justify-center'
      },
      size: {
        default: '[--fader-thumb-size:1rem] [--fader-track-size:0.25rem]',
        lg: '[--fader-thumb-size:1.25rem] [--fader-track-size:0.375rem]',
        sm: '[--fader-thumb-size:0.75rem] [--fader-track-size:0.1875rem]'
      }
    }
  }
)

type SliderRootProps = SliderPrimitive.Root.Props<number>

export interface FaderProps extends Omit<
  SliderRootProps,
  | 'value'
  | 'defaultValue'
  | 'onValueChange'
  | 'onValueCommitted'
  | 'min'
  | 'max'
  | 'step'
  | 'largeStep'
  | 'format'
  | 'orientation'
> {
  /** The value in dB. */
  value?: number
  defaultValue?: number
  onValueChange?: (value: number, details: FaderChangeDetails) => void
  /** Fires when a drag ends, after keyboard input, and on reset. */
  onValueCommitted?: (value: number) => void
  /** Bottom of the range in dB. Default −60. */
  min?: number
  /** Top of the range in dB. Default +6. */
  max?: number
  /** Arrow keys and drag resolution in dB. Default 0.5. */
  step?: number
  /** Shift+arrow and Page Up/Down, in dB. Default 6. */
  largeStep?: number
  /** Alt+arrow and Alt+drag resolution, in dB. Default 0.1. */
  fineStep?: number
  /** Value restored by double-clicking the thumb. Default 0. */
  resetValue?: number
  /** Position law. Default `linear`. */
  taper?: TaperInput
  /** Where the range fill starts. Set 0 for a bipolar gain. Default `min`. */
  origin?: number
  /** Values the thumb snaps to while dragging. Default `[0]`. */
  detents?: number[]
  /** The bottom position reports `-Infinity`. Default false. */
  silenceAtMin?: boolean
  /** The mouse wheel adjusts the value while the fader is focused. Default false. */
  allowWheel?: boolean
  orientation?: Orientation
  /** `console` has a wide cap thumb. Default `default`. */
  variant?: 'default' | 'console'
  size?: AudioSize
  /** Formats the value for `FaderValue` and assistive technology. */
  format?: (db: number) => string
}

interface FaderValueOptions {
  value: number | undefined
  defaultValue: number | undefined
  resetValue: number
  min: number
  max: number
  onValueChange: FaderProps['onValueChange']
  onValueCommitted: FaderProps['onValueCommitted']
}

/** Controlled or uncontrolled value, with change and commit callbacks. */
const useFaderValue = ({
  value: valueProp,
  defaultValue,
  resetValue,
  min,
  max,
  onValueChange,
  onValueCommitted
}: FaderValueOptions) => {
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? clamp(resetValue, min, max))
  const value = valueProp ?? uncontrolled
  const latestRef = useLatest(value)
  const controlled = valueProp !== undefined

  const change = useCallback(
    (db: number, details: FaderChangeDetails) => {
      if (db === latestRef.current) {
        return
      }
      latestRef.current = db
      if (!controlled) {
        setUncontrolled(db)
      }
      onValueChange?.(db, details)
    },
    [controlled, latestRef, onValueChange]
  )

  const commit = useCallback(
    (db: number) => {
      onValueCommitted?.(db)
    },
    [onValueCommitted]
  )

  return { change, commit, latestRef, value }
}

interface FaderSteppingOptions {
  min: number
  max: number
  step: number
  largeStep: number
  fineStep: number
  silenceAtMin: boolean
  detents: number[]
  taper: TaperInput
  latestRef: RefObject<number>
  change: (db: number, details: FaderChangeDetails) => void
  commit: (db: number) => void
}

const incrementFor = (
  event: { altKey: boolean; shiftKey: boolean },
  step: number,
  fineStep: number,
  largeStep: number
) => {
  if (event.altKey) {
    return fineStep
  }
  return event.shiftKey ? largeStep : step
}

/** Maps positions to dB and handles keyboard stepping. */
const useFaderStepping = ({
  min,
  max,
  step,
  largeStep,
  fineStep,
  silenceAtMin,
  detents,
  taper,
  latestRef,
  change,
  commit
}: FaderSteppingOptions) => {
  const taperFn = useMemo(() => resolveTaper(taper, min, max), [taper, min, max])

  const toPosition = useCallback(
    (db: number) => (db === SILENCE_DB ? 0 : taperFn.toPosition(db)),
    [taperFn]
  )

  const quantize = useCallback(
    (db: number, increment: number) => {
      if (db === SILENCE_DB) {
        return silenceAtMin ? SILENCE_DB : min
      }
      const stepped = min + Math.round((db - min) / increment) * increment
      return roundValue(clamp(stepped, min, max))
    },
    [max, min, silenceAtMin]
  )

  const fromPosition = useCallback(
    (position: number, fine: boolean) => {
      if (silenceAtMin && position <= 0) {
        return SILENCE_DB
      }
      for (const detent of detents) {
        if (Math.abs(position - toPosition(detent)) < DETENT_SNAP) {
          return detent
        }
      }
      return quantize(taperFn.toValue(position), fine ? fineStep : step)
    },
    [detents, fineStep, quantize, silenceAtMin, step, taperFn, toPosition]
  )

  const nudge = useCallback(
    (direction: number, increment: number) => {
      const { current } = latestRef
      if (current === SILENCE_DB) {
        return direction > 0 ? min : SILENCE_DB
      }
      if (silenceAtMin && direction < 0 && current <= min) {
        return SILENCE_DB
      }
      return quantize(current + direction * increment, Math.min(increment, step))
    },
    [latestRef, min, quantize, silenceAtMin, step]
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      const increment = incrementFor(event, step, fineStep, largeStep)
      const targets: Record<string, () => number> = {
        ArrowDown: () => nudge(-1, increment),
        ArrowLeft: () => nudge(-1, increment),
        ArrowRight: () => nudge(1, increment),
        ArrowUp: () => nudge(1, increment),
        End: () => max,
        Home: () => (silenceAtMin ? SILENCE_DB : min),
        PageDown: () => nudge(-1, largeStep),
        PageUp: () => nudge(1, largeStep)
      }
      const target = targets[event.key]
      if (!target) {
        return
      }
      event.preventDefault()
      const next = target()
      change(next, { event: event.nativeEvent, reason: 'keyboard' })
      commit(next)
    },
    [change, commit, fineStep, largeStep, max, min, nudge, silenceAtMin, step]
  )

  return { fromPosition, handleKeyDown, nudge, taperFn, toPosition }
}

/** Mouse-wheel adjustment while focused, with a non-passive listener. */
const useFaderWheel = (
  rootRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  handlers: {
    disabled: boolean
    fineStep: number
    step: number
    nudge: (direction: number, increment: number) => number
    change: (db: number, details: FaderChangeDetails) => void
    commit: (db: number) => void
  }
) => {
  const onWheel = useEffectEvent((event: globalThis.WheelEvent, root: HTMLDivElement) => {
    const focused = root.contains(document.activeElement)
    if (handlers.disabled || !focused || event.deltaY === 0) {
      return
    }
    event.preventDefault()
    const next = handlers.nudge(
      event.deltaY < 0 ? 1 : -1,
      event.altKey ? handlers.fineStep : handlers.step
    )
    handlers.change(next, { event, reason: 'wheel' })
    handlers.commit(next)
  })

  useEffect(() => {
    const root = rootRef.current
    if (!(root && enabled)) {
      return
    }
    const listener = (event: globalThis.WheelEvent) => {
      onWheel(event, root)
    }
    root.addEventListener('wheel', listener, { passive: false })
    return () => {
      root.removeEventListener('wheel', listener)
    }
  }, [enabled, rootRef])
}

/** Orientation, size and disabled, from props or the surrounding strip. */
const useControlSettings = (props: {
  orientation?: Orientation
  size?: AudioSize
  disabled?: boolean
}) => {
  const config = useAudioConfig()
  return {
    disabled: props.disabled ?? config.disabled ?? false,
    orientation: props.orientation ?? config.orientation ?? 'horizontal',
    size: props.size ?? config.size ?? 'default'
  }
}

export const Fader = ({
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  value: valueProp,
  defaultValue,
  onValueChange,
  onValueCommitted,
  min = DEFAULT_MIN_DB,
  max = DEFAULT_MAX_DB,
  step = 0.5,
  largeStep = 6,
  fineStep = 0.1,
  resetValue = 0,
  taper = 'linear',
  origin,
  detents = DEFAULT_DETENTS,
  silenceAtMin = false,
  allowWheel = false,
  orientation: orientationProp,
  variant = 'default',
  size: sizeProp,
  format = defaultFormat,
  disabled: disabledProp,
  className,
  children,
  ref,
  ...props
}: FaderProps) => {
  const { disabled, orientation, size } = useControlSettings({
    disabled: disabledProp,
    orientation: orientationProp,
    size: sizeProp
  })
  const { change, commit, latestRef, value } = useFaderValue({
    defaultValue,
    max,
    min,
    onValueChange,
    onValueCommitted,
    resetValue,
    value: valueProp
  })
  const { fromPosition, handleKeyDown, nudge, taperFn, toPosition } = useFaderStepping({
    change,
    commit,
    detents,
    fineStep,
    largeStep,
    latestRef,
    max,
    min,
    silenceAtMin,
    step,
    taper
  })

  const rootRef = useRef<HTMLDivElement | null>(null)
  useFaderWheel(rootRef, allowWheel, {
    change,
    commit,
    disabled,
    fineStep,
    nudge,
    step
  })

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

  const position = toPosition(value)
  const originPosition = toPosition(clamp(origin ?? min, min, max))

  const contextValue = useMemo<FaderContextValue>(
    () => ({
      ariaLabel,
      ariaLabelledBy,
      change,
      commit,
      disabled,
      format,
      handleKeyDown,
      max,
      min,
      orientation,
      originPosition,
      position,
      resetValue,
      size,
      taper: taperFn,
      value,
      variant
    }),
    [
      ariaLabel,
      ariaLabelledBy,
      change,
      commit,
      disabled,
      format,
      handleKeyDown,
      max,
      min,
      orientation,
      originPosition,
      position,
      resetValue,
      size,
      taperFn,
      value,
      variant
    ]
  )

  return (
    <FaderContext.Provider value={contextValue}>
      <SliderPrimitive.Root
        className={cn(faderVariants({ orientation, size }), className)}
        data-at-detent={detents.includes(value) ? '' : undefined}
        data-silent={value === SILENCE_DB ? '' : undefined}
        data-size={size}
        data-slot="fader"
        data-variant={variant}
        disabled={disabled}
        max={1}
        min={0}
        onValueChange={(next, details) => {
          const fine = 'altKey' in details.event && Boolean((details.event as MouseEvent).altKey)
          const reason: FaderChangeReason =
            details.reason === 'track-press' ? 'track-press' : 'drag'
          change(fromPosition(next, fine), { event: details.event, reason })
        }}
        onValueCommitted={() => {
          commit(latestRef.current)
        }}
        orientation={orientation}
        ref={setRootRef}
        step={POSITION_STEP}
        value={position}
        {...props}
      >
        {children ?? (
          <FaderTrack>
            <FaderRange />
            <FaderThumb />
          </FaderTrack>
        )}
      </SliderPrimitive.Root>
    </FaderContext.Provider>
  )
}

export { faderVariants }
