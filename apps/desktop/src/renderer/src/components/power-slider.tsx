'use client'

import { useId, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'

import { ResetIcon } from '@/components/icons'
import type { AppIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { clampToRange, formatValue, parseNumericInput, valuePercent } from '@/lib/power-slider-math'
import type { SliderRange } from '@/lib/power-slider-math'
import { cn } from '@/lib/utils'

/** The status chip's tone: the Badge variant of the same name. */
type PowerSliderStatusTone = 'default' | 'success' | 'warning' | 'destructive'

interface PowerSliderMark {
  value: number
  label?: string
}

interface PowerSliderProps {
  label: string
  value: number
  min: number
  max: number
  /**
   * The live preview, fired while dragging and on every key. Keep it cheap:
   * write expensive updates (the engine, a saved setting) from `onCommit`,
   * so a continuous drag can't flood them.
   */
  onChange: (value: number) => void
  step?: number
  /** Fired on release, on a key, on reset and on a typed number. Defaults to `onChange`. */
  onCommit?: (value: number) => void
  icon?: AppIcon
  /** The unit after the value: "%", " ms", " dB". */
  suffix?: string
  /** Decimals in the readout; from `step` when unset. */
  decimals?: number
  /** A value either side of zero: the readout signs positives ("+12"). */
  bipolar?: boolean
  /** The Shift+arrow and Page Up/Down move; 10 steps when unset. */
  largeStep?: number
  /** Enables reset (the button and a double-click) once the value drifts from it. */
  defaultValue?: number
  /** Labelled points under the track. */
  marks?: PowerSliderMark[]
  /** The ends (and a bipolar midpoint) under the track, when there are no marks. */
  rangeHints?: boolean
  /** A typed number in place of the readout. */
  numericInput?: boolean
  disabled?: boolean
  /** Why it's disabled, in one sentence under the track. */
  disabledReason?: string
  /** A chip after the label: "Premium", "Not supported". */
  status?: { label: string; tone?: PowerSliderStatusTone }
  className?: string
}

function scalePointsFor({
  marks,
  rangeHints,
  bipolar,
  min,
  max
}: Pick<PowerSliderProps, 'marks' | 'rangeHints' | 'bipolar' | 'min' | 'max'>):
  | PowerSliderMark[]
  | null {
  if (marks && marks.length > 0) {
    return marks
  }
  if (!rangeHints) {
    return null
  }
  return bipolar
    ? [{ value: min }, { value: min + (max - min) / 2 }, { value: max }]
    : [{ value: min }, { value: max }]
}

/**
 * A labelled slider for one engine setting: the label (with an icon and a
 * status chip), the value or a typed number, a reset to the default, the
 * track, and optional marks under it. Every value clamps and snaps through
 * the pure helpers in `lib/power-slider-math`, so what the slider shows is what
 * the tests check.
 */
function PowerSlider({
  label,
  value,
  min,
  max,
  onChange,
  step = 1,
  onCommit,
  icon: LeadingIcon,
  suffix,
  decimals,
  bipolar = false,
  largeStep,
  defaultValue,
  marks,
  rangeHints = false,
  numericInput = false,
  disabled = false,
  disabledReason,
  status,
  className
}: PowerSliderProps): ReactElement {
  const labelId = useId()
  const range: SliderRange = { max, min, step }
  const commit = onCommit ?? onChange
  const [draft, setDraft] = useState<string | null>(null)

  const display = formatValue(value, { bipolar, decimals, step, suffix })
  const canReset =
    defaultValue !== undefined && clampToRange(value, range) !== clampToRange(defaultValue, range)

  const emit = (next: number, withCommit: boolean): void => {
    const clamped = clampToRange(next, range)
    onChange(clamped)
    if (withCommit) {
      commit(clamped)
    }
  }

  const reset = (): void => {
    if (defaultValue !== undefined) {
      emit(defaultValue, true)
    }
  }

  const numericText = draft ?? String(value)
  const commitNumeric = (): void => {
    if (draft === null) {
      return
    }
    const parsed = parseNumericInput(draft, range)
    setDraft(null)
    if (parsed !== null) {
      emit(parsed, true)
    }
  }

  const scalePoints = scalePointsFor({ bipolar, marks, max, min, rangeHints })

  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-slot="power-slider">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {LeadingIcon ? (
            <LeadingIcon
              aria-hidden
              className="text-muted-foreground size-3.5 shrink-0"
              weight="duotone"
            />
          ) : null}
          <Label className="min-w-0" id={labelId}>
            <span className="truncate">{label}</span>
          </Label>
          {status ? <Badge variant={status.tone ?? 'default'}>{status.label}</Badge> : null}
        </div>
        <div className="flex items-center gap-1">
          {numericInput ? (
            <Input
              aria-label={`${label} value`}
              className="w-20 text-right"
              disabled={disabled}
              inputMode="decimal"
              onBlur={commitNumeric}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={() => setDraft(numericText)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitNumeric()
                } else if (event.key === 'Escape') {
                  setDraft(null)
                  event.currentTarget.blur()
                }
              }}
              value={numericText}
            />
          ) : (
            <span className="text-foreground min-w-[3ch] text-right text-sm font-medium tabular-nums">
              {display}
            </span>
          )}
          {canReset ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={`Reset ${label}`}
                    disabled={disabled}
                    onClick={reset}
                    size="icon"
                    variant="ghost"
                  />
                }
              >
                <ResetIcon aria-hidden className="text-muted-foreground size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Reset to default</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {/* Double-click anywhere on the track returns to the default. */}
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- A pointer shortcut; the reset button is the keyboard path. */}
      <div className="relative" onDoubleClick={defaultValue === undefined ? undefined : reset}>
        <Slider
          aria-labelledby={labelId}
          disabled={disabled}
          // Base UI moves by largeStep on Shift+arrow and Page Up/Down.
          largeStep={largeStep ?? step * 10}
          max={max}
          min={min}
          onValueChange={(next) => emit(next, false)}
          onValueCommitted={(next) => emit(next, true)}
          step={step}
          value={value}
        />
      </div>

      {scalePoints ? (
        <div className="text-muted-foreground text-label relative h-4 font-normal">
          {scalePoints.map((point) => (
            <span
              className="absolute left-(--mark) -translate-x-1/2 whitespace-nowrap tabular-nums"
              key={point.value}
              style={
                {
                  '--mark': `${valuePercent(point.value, range)}%`
                } as CSSProperties
              }
            >
              {point.label ?? formatValue(point.value, { bipolar, decimals, step, suffix })}
            </span>
          ))}
        </div>
      ) : null}

      {disabled && disabledReason ? (
        <p className="text-muted-foreground text-xs">{disabledReason}</p>
      ) : null}
    </div>
  )
}

export { PowerSlider }
export type { PowerSliderMark, PowerSliderProps, PowerSliderStatusTone }
