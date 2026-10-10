import * as React from 'react'

import { cn } from '@/lib/utils'
import { useFieldLabelledBy } from '@/components/ui/field-context'
import { tabsListVariants, tabsTriggerBaseClassName } from '@/components/ui/tabs-variants'

/**
 * One segmented control (plan 174 S1.7, D13): pick one of 2–4 exclusive
 * options. It wears the Tabs track (`tabsListVariants`) without Radix, so it
 * costs the initial bundle nothing and works in every window.
 *
 * Which control when:
 * - `SegmentedControl` chooses a value (Theme, Fit, Corner, Kind of cut).
 * - `Tabs` switch a view: a page or a pane, with its own content.
 * - `ToggleGroup` is for filter chips (several on at once, or a filter row).
 * - `Switch` is for a boolean; a one-shot action is a `Button`.
 *
 * Semantics: the WAI-ARIA radio group pattern. The track is a `radiogroup`
 * and each option a `radio` with `aria-checked` (and `data-state="on"`, as a
 * Radix toggle marks it). A Field's label names the group (`aria-labelledby`)
 * unless it carries its own `aria-label`.
 *
 * Keyboard (roving focus, one tab stop):
 * - Tab lands on the checked option, or on the first enabled one when nothing
 *   is checked, and Tab again leaves the group.
 * - ArrowRight/ArrowDown move to the next enabled option and ArrowLeft/ArrowUp
 *   to the previous one, wrapping; Home and End go to the first and last.
 * - With `activationMode="automatic"` (the default) a move also checks the
 *   option, as radios do. With `"manual"` a move only focuses, and Space or
 *   Enter checks: for a choice whose change is heavy (a live scene switch).
 *
 * An option's own `onClick` runs after the choice, also on the checked
 * option: the hook for "choosing it again" (replay, re-apply).
 *
 * Disabled with a reason: `disabled` plus `disabledReason` shows the reason as
 * a line under the control and describes the group with it, so a disabled
 * control always says why (the inline line, as on PowerSlider).
 */

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined }

type SegmentButtonProps = Omit<
  React.ComponentProps<'button'>,
  'aria-checked' | 'children' | 'disabled' | 'onKeyDown' | 'role' | 'tabIndex' | 'type' | 'value'
>

type SegmentedControlOption<T extends string = string> = SegmentButtonProps &
  DataAttributes & {
    value: T
    label: React.ReactNode
    disabled?: boolean
  }

type SegmentedControlProps<T extends string = string> = Omit<
  React.ComponentProps<'div'>,
  'children' | 'defaultValue' | 'dir' | 'onChange' | 'role'
> & {
  options: readonly SegmentedControlOption<T>[]
  /** The checked option; `null`, `undefined` or a value not offered checks none. */
  value: T | null | undefined
  /** Called with a newly checked value, never with the value already checked. */
  onValueChange: (value: T) => void
  disabled?: boolean
  /** Why the whole control is disabled: shown under it while `disabled`. */
  disabledReason?: string | null
  activationMode?: 'automatic' | 'manual'
  size?: 'default' | 'sm'
}

/** The option a key moves to, skipping disabled ones; `null` for other keys. */
function segmentedTargetIndex(
  enabled: readonly boolean[],
  current: number,
  key: string
): number | null {
  const indexes = enabled.flatMap((on, index) => (on ? [index] : []))
  if (indexes.length === 0) return null
  switch (key) {
    case 'Home':
      return indexes[0]
    case 'End':
      return indexes[indexes.length - 1]
    case 'ArrowRight':
    case 'ArrowDown':
      return indexes.find((index) => index > current) ?? indexes[0]
    case 'ArrowLeft':
    case 'ArrowUp':
      return [...indexes].reverse().find((index) => index < current) ?? indexes[indexes.length - 1]
    default:
      return null
  }
}

/** The one option Tab reaches: the checked one, else the first enabled one. */
function segmentedTabStop(enabled: readonly boolean[], checkedIndex: number): number {
  return checkedIndex >= 0 && enabled[checkedIndex] ? checkedIndex : enabled.indexOf(true)
}

function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  disabled = false,
  disabledReason,
  activationMode = 'automatic',
  size = 'default',
  className,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  onKeyDown,
  ...props
}: SegmentedControlProps<T>): React.ReactElement {
  const labelledBy = useFieldLabelledBy(ariaLabelledBy, props['aria-label'])
  const reasonId = React.useId()
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([])
  const enabled = options.map((option) => !disabled && !option.disabled)
  const checkedIndex = options.findIndex((option) => option.value === value)
  const tabStop = segmentedTabStop(enabled, checkedIndex)
  const showReason = disabled && Boolean(disabledReason)
  const describedBy =
    [ariaDescribedBy, showReason ? reasonId : undefined].filter(Boolean).join(' ') || undefined

  const choose = (index: number): void => {
    const option = options[index]
    if (option && enabled[index] && option.value !== value) onValueChange(option.value)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const current = buttons.current.findIndex((button) => button === event.target)
    if (current < 0) return
    const target = segmentedTargetIndex(enabled, current, event.key)
    if (target === null) return
    event.preventDefault()
    buttons.current[target]?.focus()
    if (activationMode === 'automatic') choose(target)
  }

  const track = (
    <div
      {...props}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      aria-labelledby={labelledBy}
      className={cn(
        tabsListVariants({ variant: 'default' }),
        // One row when it fits; a narrow pane wraps it instead of clipping.
        'flex-wrap',
        size === 'sm' ? 'min-h-6' : 'min-h-control',
        className
      )}
      data-size={size}
      data-slot="segmented-control"
      role="radiogroup"
      onKeyDown={handleKeyDown}
    >
      {options.map((option, index) => {
        const {
          value: optionValue,
          label,
          disabled: _optionDisabled,
          className: optionClassName,
          onClick: onOptionClick,
          ...buttonProps
        } = option
        const checked = index === checkedIndex
        return (
          <button
            {...buttonProps}
            key={optionValue}
            ref={(element) => {
              buttons.current[index] = element
            }}
            aria-checked={checked}
            className={cn(
              tabsTriggerBaseClassName,
              size === 'sm' ? 'h-5 px-2 text-xs' : 'h-6',
              'aria-checked:text-foreground aria-checked:glass-chip',
              optionClassName
            )}
            data-slot="segmented-control-item"
            data-state={checked ? 'on' : 'off'}
            disabled={!enabled[index]}
            role="radio"
            tabIndex={index === tabStop ? 0 : -1}
            type="button"
            onClick={(event) => {
              choose(index)
              onOptionClick?.(event)
            }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )

  if (!showReason) return track
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-slot="segmented-control-field">
      {track}
      <p className="text-xs text-muted-foreground" id={reasonId}>
        {disabledReason}
      </p>
    </div>
  )
}

export {
  SegmentedControl,
  segmentedTabStop,
  segmentedTargetIndex,
  type SegmentedControlOption,
  type SegmentedControlProps
}
