'use client'

import { mergeProps } from '@base-ui/react/merge-props'
import { NumberField as NumberFieldPrimitive } from '@base-ui/react/number-field'
import { Slider as SliderPrimitive } from '@base-ui/react/slider'
import { useRender } from '@base-ui/react/use-render'
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import type { ComponentProps, CSSProperties, KeyboardEvent } from 'react'

import { useAudioConfig } from '@/hooks/use-audio-config'
import { clamp } from '@/lib/audio/decibels'
import { linearTaper, logTaper } from '@/lib/audio/taper'
import type { Taper } from '@/lib/audio/types'
import { cn } from '@/lib/utils'

const POSITION_STEP = 0.0005
const PRECISION = 1e6

export type ParameterChangeReason = 'drag' | 'keyboard' | 'input' | 'reset'

export interface ParameterChangeDetails {
  reason: ParameterChangeReason
  event?: Event
}

export interface ParameterMark {
  value: number
  label?: string
}

interface ParameterSliderContextValue {
  value: number
  min: number
  max: number
  step: number
  largeStep: number
  unit: string | undefined
  decimals: number
  resetValue: number
  position: number
  originPosition: number
  taper: Taper
  disabled: boolean
  marks: ParameterMark[] | undefined
  labelId: string
  descriptionId: string
  format: (value: number) => string
  change: (value: number, details: ParameterChangeDetails) => void
  commit: (value: number) => void
  commitLatest: () => void
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}

const ParameterSliderContext = createContext<ParameterSliderContextValue | null>(null)

const useParameterSlider = (part: string) => {
  const context = useContext(ParameterSliderContext)
  if (!context) {
    throw new Error(`${part} must be used inside ParameterSlider.`)
  }
  return context
}

const decimalsOf = (step: number) => {
  const text = String(step)
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

const roundValue = (value: number) => Math.round(value * PRECISION) / PRECISION

/** Points along the range sampled to find the widest value text. */
const WIDTH_SAMPLES = 24

/** Characters in the widest value along the range, so the value keeps one width. */
const widestValue = (
  format: (value: number) => string,
  taper: Taper,
  snap: (value: number) => number
) => {
  let widest = 0
  for (let index = 0; index <= WIDTH_SAMPLES; index += 1) {
    const sample = snap(taper.toValue(index / WIDTH_SAMPLES))
    widest = Math.max(widest, format(sample).length)
  }
  return widest
}

export interface ParameterSliderProps extends Omit<
  ComponentProps<'div'>,
  'defaultValue' | 'onChange'
> {
  value?: number
  defaultValue?: number
  onValueChange?: (value: number, details: ParameterChangeDetails) => void
  /** Fires when a drag ends, after keyboard input, typing and reset. */
  onValueCommitted?: (value: number) => void
  /** Default 0. */
  min?: number
  /** Default 100. */
  max?: number
  /** Default 1. */
  step?: number
  /** Shift+arrow and Page Up/Down. Default 10. */
  largeStep?: number
  /** Suffix such as "ms", "dB" or "Hz". */
  unit?: string
  /** Digits after the decimal point. Default: from `step`. */
  decimals?: number
  /** `log` suits frequency and time. Default `linear`. */
  scale?: 'linear' | 'log'
  /** Where the fill starts; the middle of a bipolar range. Default `min`. */
  origin?: number
  /** Value restored by reset and double-click. Default `defaultValue` or `min`. */
  resetValue?: number
  marks?: ParameterMark[]
  format?: (value: number) => string
  disabled?: boolean
}

export const ParameterSlider = ({
  value: valueProp,
  defaultValue,
  onValueChange,
  onValueCommitted,
  min = 0,
  max = 100,
  step = 1,
  largeStep = 10,
  unit,
  decimals: decimalsProp,
  scale = 'linear',
  origin,
  resetValue: resetValueProp,
  marks,
  format: formatProp,
  disabled: disabledProp,
  className,
  children,
  ...props
}: ParameterSliderProps) => {
  const config = useAudioConfig()
  const disabled = disabledProp ?? config.disabled ?? false
  const resetValue = resetValueProp ?? defaultValue ?? min
  const [uncontrolled, setUncontrolled] = useState(() =>
    clamp(defaultValue ?? resetValue, min, max)
  )
  const value = valueProp ?? uncontrolled
  const latestRef = useRef(value)
  // Every commit, not only when `value` changes: a controlled parent that
  // rejects a change re-renders with the same value, and the ref must drop
  // the rejected one.
  useLayoutEffect(() => {
    latestRef.current = value
  })
  const decimals = decimalsProp ?? decimalsOf(step)
  const labelId = useId()
  const descriptionId = useId()

  const taper = useMemo(
    () => (scale === 'log' ? logTaper(min, max) : linearTaper(min, max)),
    [max, min, scale]
  )

  const format = useCallback(
    (next: number) => {
      if (formatProp) {
        return formatProp(next)
      }
      const text = next.toFixed(decimals)
      return unit ? `${text} ${unit}` : text
    },
    [decimals, formatProp, unit]
  )

  const quantize = useCallback(
    (next: number) => {
      const stepped = min + Math.round((next - min) / step) * step
      return roundValue(clamp(stepped, min, max))
    },
    [max, min, step]
  )

  const change = useCallback(
    (next: number, details: ParameterChangeDetails) => {
      if (next === latestRef.current) {
        return
      }
      latestRef.current = next
      if (valueProp === undefined) {
        setUncontrolled(next)
      }
      onValueChange?.(next, details)
    },
    [onValueChange, valueProp]
  )

  const commit = useCallback(
    (next: number) => {
      onValueCommitted?.(next)
    },
    [onValueCommitted]
  )

  const commitLatest = useCallback(() => {
    onValueCommitted?.(latestRef.current)
  }, [onValueCommitted])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      const increment = event.shiftKey ? largeStep : step
      const { current } = latestRef
      let next: number | null = null
      switch (event.key) {
        case 'ArrowUp':
        case 'ArrowRight': {
          next = current + increment
          break
        }
        case 'ArrowDown':
        case 'ArrowLeft': {
          next = current - increment
          break
        }
        case 'PageUp': {
          next = current + largeStep
          break
        }
        case 'PageDown': {
          next = current - largeStep
          break
        }
        case 'Home': {
          next = min
          break
        }
        case 'End': {
          next = max
          break
        }
        default: {
          break
        }
      }
      if (next === null) {
        return
      }
      event.preventDefault()
      const quantized = quantize(next)
      change(quantized, { event: event.nativeEvent, reason: 'keyboard' })
      commit(quantized)
    },
    [change, commit, largeStep, max, min, quantize, step]
  )

  const position = taper.toPosition(value)
  const originPosition = taper.toPosition(clamp(origin ?? min, min, max))

  const contextValue = useMemo<ParameterSliderContextValue>(
    () => ({
      change,
      commit,
      commitLatest,
      decimals,
      descriptionId,
      disabled,
      format,
      handleKeyDown,
      labelId,
      largeStep,
      marks,
      max,
      min,
      originPosition,
      position,
      resetValue,
      step,
      taper,
      unit,
      value
    }),
    [
      change,
      commit,
      commitLatest,
      decimals,
      descriptionId,
      disabled,
      format,
      handleKeyDown,
      labelId,
      largeStep,
      marks,
      max,
      min,
      originPosition,
      position,
      resetValue,
      step,
      taper,
      unit,
      value
    ]
  )

  return (
    <ParameterSliderContext.Provider value={contextValue}>
      <div
        className={cn(
          'group/parameter-slider flex w-full flex-col gap-2 data-disabled:opacity-50',
          className
        )}
        data-disabled={disabled ? '' : undefined}
        data-modified={value === resetValue ? undefined : ''}
        data-slot="parameter-slider"
        role="group"
        aria-labelledby={labelId}
        {...props}
      >
        {children}
      </div>
    </ParameterSliderContext.Provider>
  )
}

export const ParameterSliderHeader = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    className={cn('flex min-h-6 items-center gap-2', className)}
    data-slot="parameter-slider-header"
    {...props}
  />
)

export const ParameterSliderLabel = ({ className, ...props }: ComponentProps<'span'>) => {
  const { labelId } = useParameterSlider('ParameterSliderLabel')
  return (
    <span
      className={cn('mr-auto text-sm font-medium', className)}
      data-slot="parameter-slider-label"
      id={labelId}
      {...props}
    />
  )
}

export interface ParameterSliderInputProps extends Omit<
  NumberFieldPrimitive.Input.Props,
  'value' | 'defaultValue'
> {
  /** Drag the unit to change the value. Default true. */
  scrub?: boolean
}

export const ParameterSliderInput = ({
  scrub = true,
  className,
  ...props
}: ParameterSliderInputProps) => {
  const { change, commit, decimals, disabled, labelId, largeStep, max, min, step, unit, value } =
    useParameterSlider('ParameterSliderInput')

  const suffix = unit ? (
    <span className="text-muted-foreground px-1.5 text-xs" data-slot="parameter-slider-unit">
      {unit}
    </span>
  ) : null

  return (
    <NumberFieldPrimitive.Root
      className="shrink-0"
      disabled={disabled}
      format={{
        maximumFractionDigits: decimals,
        minimumFractionDigits: decimals
      }}
      largeStep={largeStep}
      max={max}
      min={min}
      onValueChange={(next, details) => {
        if (next !== null) {
          change(next, { event: details.event, reason: 'input' })
        }
      }}
      onValueCommitted={(next) => {
        if (next !== null) {
          commit(next)
        }
      }}
      step={step}
      value={value}
    >
      <NumberFieldPrimitive.Group
        className="bg-input/50 focus-within:ring-ring/30 flex h-7 items-center rounded-lg focus-within:ring-3"
        data-slot="parameter-slider-input-group"
      >
        <NumberFieldPrimitive.Input
          aria-labelledby={labelId}
          className={cn(
            'h-full w-16 bg-transparent px-2 text-end font-mono text-xs tabular-nums outline-hidden',
            className
          )}
          data-slot="parameter-slider-input"
          {...props}
        />
        {scrub && suffix ? (
          <NumberFieldPrimitive.ScrubArea className="cursor-ew-resize">
            {suffix}
          </NumberFieldPrimitive.ScrubArea>
        ) : (
          suffix
        )}
      </NumberFieldPrimitive.Group>
    </NumberFieldPrimitive.Root>
  )
}

export const ParameterSliderValue = ({ className, style, ...props }: ComponentProps<'span'>) => {
  const { format, max, min, step, taper, value } = useParameterSlider('ParameterSliderValue')
  const valueWidth = useMemo(
    () =>
      widestValue(format, taper, (next) =>
        roundValue(clamp(min + Math.round((next - min) / step) * step, min, max))
      ),
    [format, max, min, step, taper]
  )
  return (
    <span
      className={cn(
        'text-muted-foreground inline-block min-w-(--parameter-value-width) text-end font-mono text-xs whitespace-nowrap tabular-nums',
        className
      )}
      data-slot="parameter-slider-value"
      style={
        {
          '--parameter-value-width': `${valueWidth}ch`,
          ...style
        } as CSSProperties
      }
      {...props}
    >
      {format(value)}
    </span>
  )
}

export type ParameterSliderResetProps = useRender.ComponentProps<'button'>

export const ParameterSliderReset = ({
  render,
  className,
  children,
  ...props
}: ParameterSliderResetProps) => {
  const { change, commit, disabled, resetValue, value } = useParameterSlider('ParameterSliderReset')
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
    state: { modified, slot: 'parameter-slider-reset' }
  })
}

const useSliderBindings = () => {
  const context = useParameterSlider('ParameterSliderControl')
  const { max, min, step, taper } = context
  const quantizeFromPosition = useCallback(
    (position: number) => {
      const raw = taper.toValue(position)
      const stepped = min + Math.round((raw - min) / step) * step
      return roundValue(clamp(stepped, min, max))
    },
    [max, min, step, taper]
  )
  return { ...context, quantizeFromPosition }
}

export const ParameterSliderControl = ({
  className,
  ...props
}: Omit<
  SliderPrimitive.Root.Props<number>,
  'value' | 'defaultValue' | 'onValueChange' | 'onValueCommitted' | 'min' | 'max' | 'step'
>) => {
  const {
    change,
    commit,
    commitLatest,
    descriptionId,
    disabled,
    format,
    handleKeyDown,
    labelId,
    originPosition,
    position,
    quantizeFromPosition,
    resetValue,
    value
  } = useSliderBindings()
  const start = Math.min(originPosition, position) * 100
  const end = Math.max(originPosition, position) * 100
  const range = {
    '--parameter-range-size': `${end - start}%`,
    '--parameter-range-start': `${start}%`
  } as CSSProperties

  return (
    <SliderPrimitive.Root
      className={cn('relative flex w-full touch-none items-center select-none', className)}
      data-slot="parameter-slider-control"
      disabled={disabled}
      max={1}
      min={0}
      onValueChange={(next, details) => {
        change(quantizeFromPosition(next), {
          event: details.event,
          reason: 'drag'
        })
      }}
      onValueCommitted={commitLatest}
      step={POSITION_STEP}
      value={position}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex h-4 w-full items-center px-2 before:absolute before:inset-x-0 before:-inset-y-1.5 pointer-coarse:before:-inset-y-3">
        <SliderPrimitive.Track
          className="bg-input/90 relative h-1 w-full grow rounded-full"
          data-slot="parameter-slider-track"
        >
          <div
            className="bg-primary absolute inset-y-0 left-(--parameter-range-start) w-(--parameter-range-size) rounded-full"
            data-slot="parameter-slider-range"
            style={range}
          />
          <SliderPrimitive.Thumb
            aria-describedby={descriptionId}
            aria-labelledby={labelId}
            className="bg-background ring-foreground/15 hover:ring-ring/30 focus-visible:ring-ring/40 data-dragging:ring-ring/30 block size-4 shrink-0 rounded-full shadow-sm ring-1 outline-hidden transition-[box-shadow] hover:ring-4 focus-visible:ring-4 data-dragging:ring-4"
            data-slot="parameter-slider-thumb"
            getAriaValueText={() => format(value)}
            onDoubleClick={() => {
              change(resetValue, { reason: 'reset' })
              commit(resetValue)
            }}
            onKeyDown={handleKeyDown}
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export const ParameterSliderMarks = ({ className, ...props }: ComponentProps<'div'>) => {
  const { format, marks, taper } = useParameterSlider('ParameterSliderMarks')
  if (!marks || marks.length === 0) {
    return null
  }
  return (
    <div
      aria-hidden
      className={cn('text-muted-foreground relative mx-2 h-4 text-[0.625rem]', className)}
      data-slot="parameter-slider-marks"
      {...props}
    >
      {marks.map((mark) => (
        <span
          className="absolute top-0 left-(--mark-position) -translate-x-1/2 whitespace-nowrap tabular-nums"
          key={mark.value}
          style={
            {
              '--mark-position': `${taper.toPosition(mark.value) * 100}%`
            } as CSSProperties
          }
        >
          {mark.label ?? format(mark.value)}
        </span>
      ))}
    </div>
  )
}

export const ParameterSliderDescription = ({ className, ...props }: ComponentProps<'p'>) => {
  const { descriptionId } = useParameterSlider('ParameterSliderDescription')
  return (
    <p
      className={cn('text-muted-foreground text-xs', className)}
      data-slot="parameter-slider-description"
      id={descriptionId}
      {...props}
    />
  )
}
