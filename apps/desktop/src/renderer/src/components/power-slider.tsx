import { type AppIcon, ResetIcon } from '@/components/icons'
import { useId, useState, type ComponentProps, type KeyboardEvent, type ReactElement } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import {
  clampToRange,
  formatValue,
  parseNumericInput,
  stepValue,
  valuePercent,
  type SliderRange
} from '@/lib/power-slider'
import { cn } from '@/lib/utils'

type PowerSliderStatusTone = 'default' | 'success' | 'warning' | 'destructive'

const STATUS_VARIANT: Record<
  PowerSliderStatusTone,
  NonNullable<ComponentProps<typeof Badge>['variant']>
> = {
  default: 'secondary',
  success: 'success',
  warning: 'warning',
  destructive: 'destructive'
}

export type PowerSliderMark = { value: number; label?: string }

export type PowerSliderProps = {
  label: string
  value: number
  min: number
  max: number
  // Live preview, fired during drag/keyboard. Keep this cheap — write backend or
  // native-preview updates from onCommit (pointer-up / numeric commit) instead so
  // a continuous drag can't flood the compositor.
  onChange: (value: number) => void
  step?: number
  onCommit?: (value: number) => void
  icon?: AppIcon
  suffix?: string
  decimals?: number
  bipolar?: boolean
  largeStep?: number
  // Enables reset (button + double-click) once value drifts from this default.
  defaultValue?: number
  marks?: PowerSliderMark[]
  rangeHints?: boolean
  numericInput?: boolean
  disabled?: boolean
  disabledReason?: string
  status?: { label: string; tone?: PowerSliderStatusTone }
  className?: string
}

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

export function PowerSlider({
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
  const range: SliderRange = { min, max, step }
  const commit = onCommit ?? onChange
  const [draft, setDraft] = useState<string | null>(null)

  const display = formatValue(value, { suffix, decimals, bipolar, step })
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

  // Radix moves by `step` on a plain arrow; intercept Shift+arrow in the capture
  // phase (before the thumb's own handler) so the large step replaces it rather
  // than stacking on top.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (disabled || !event.shiftKey || !ARROW_KEYS.has(event.key)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : -1
    emit(stepValue(value, range, direction, { large: true, largeStep }), true)
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

  const scalePoints =
    marks && marks.length > 0
      ? marks
      : rangeHints
        ? bipolar
          ? [{ value: min }, { value: min + (max - min) / 2 }, { value: max }]
          : [{ value: min }, { value: max }]
        : null

  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-slot="power-slider">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {LeadingIcon ? (
            <LeadingIcon className="size-3.5 shrink-0 text-muted-foreground" weight="duotone" />
          ) : null}
          <Label id={labelId} className="truncate">
            {label}
          </Label>
          {status ? (
            <Badge variant={STATUS_VARIANT[status.tone ?? 'default']}>{status.label}</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {numericInput ? (
            <Input
              aria-label={`${label} value`}
              className="h-7 w-20 text-right font-mono text-xs tabular-nums"
              disabled={disabled}
              inputMode="decimal"
              value={numericText}
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
            />
          ) : (
            <span className="min-w-[3ch] text-right text-sm font-medium tabular-nums text-foreground">
              {display}
            </span>
          )}
          {canReset ? (
            <Button
              aria-label={`Reset ${label}`}
              className="size-7 text-muted-foreground"
              disabled={disabled}
              size="icon"
              title="Reset to default"
              variant="ghost"
              onClick={reset}
            >
              <ResetIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <span
        className="relative block"
        onDoubleClick={defaultValue !== undefined ? reset : undefined}
        onKeyDownCapture={onKeyDownCapture}
      >
        <Slider
          aria-labelledby={labelId}
          disabled={disabled}
          max={max}
          min={min}
          step={step}
          value={[value]}
          onValueChange={([next]) => emit(next, false)}
          onValueCommit={([next]) => emit(next, true)}
        />
      </span>

      {scalePoints ? (
        <div className="relative h-3.5 text-[10px] text-muted-foreground">
          {scalePoints.map((point) => (
            <span
              key={point.value}
              className="absolute -translate-x-1/2 whitespace-nowrap tabular-nums"
              style={{ left: `${valuePercent(point.value, range)}%` }}
            >
              {point.label ?? formatValue(point.value, { suffix, decimals, bipolar, step })}
            </span>
          ))}
        </div>
      ) : null}

      {disabled && disabledReason ? (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}
    </div>
  )
}
