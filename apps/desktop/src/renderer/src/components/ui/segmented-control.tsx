'use client'

import * as React from 'react'

import { useFieldLabelledBy } from '@/components/ui/field-context'
import { tabsListVariants, tabsTriggerBaseClassName } from '@/components/ui/tabs-variants'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * One segmented control: pick one of 2–4 exclusive options. It wears the Tabs
 * track (`tabsListVariants`) without Base UI Tabs, so it costs the initial
 * bundle nothing (an icon option's `tooltip` uses the Tooltip every window
 * already loads).
 *
 * Which control when:
 * - `SegmentedControl` chooses a value (Theme, Fit, Corner, Kind of cut).
 * - `Tabs` switch a view: a page or a pane, with its own content.
 * - `ToggleGroup` is for filter chips (several on at once, or a filter row).
 * - `Switch` is for a boolean; a one-shot action is a `Button`.
 *
 * Semantics: the WAI-ARIA radio group pattern. The track is a `radiogroup`
 * and each option a `radio` with `aria-checked` (and `data-checked` or
 * `data-unchecked`, as a Base UI radio marks it). A Field's label names the
 * group (`aria-labelledby`) unless it carries its own `aria-label`.
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
 * control always says why.
 */

type DataAttributes = Record<`data-${string}`, string | number | boolean | undefined>

type SegmentButtonProps = Omit<
  React.ComponentProps<'button'>,
  'aria-checked' | 'children' | 'disabled' | 'onKeyDown' | 'role' | 'tabIndex' | 'type' | 'value'
>

type SegmentedControlOption<T extends string = string> = SegmentButtonProps &
  DataAttributes & {
    value: T
    label: React.ReactNode
    disabled?: boolean
    /**
     * The option's name on hover and on focus, for an option drawn as an icon:
     * never a native `title`.
     */
    tooltip?: React.ReactNode
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

/**
 * The last of the ascending `indexes` before `current`. `findLast` is ES2023,
 * and installs may compile against ES2022.
 */
function lastIndexBefore(indexes: readonly number[], current: number): number | undefined {
  let found: number | undefined
  for (const index of indexes) {
    if (index >= current) {
      break
    }
    found = index
  }
  return found
}

function segmentedTargetIndex(
  enabled: readonly boolean[],
  current: number,
  key: string
): number | null {
  const indexes = enabled.flatMap((on, index) => (on ? [index] : []))
  if (indexes.length === 0) {
    return null
  }
  const first = indexes[0] ?? null
  const last = indexes.at(-1) ?? null
  switch (key) {
    case 'Home': {
      return first
    }
    case 'End': {
      return last
    }
    case 'ArrowRight':
    case 'ArrowDown': {
      return indexes.find((index) => index > current) ?? first
    }
    case 'ArrowLeft':
    case 'ArrowUp': {
      return lastIndexBefore(indexes, current) ?? last
    }
    default: {
      return null
    }
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
  const buttons = React.useRef<(HTMLButtonElement | null)[]>([])
  const enabled = options.map((option) => !(disabled || option.disabled))
  const checkedIndex = options.findIndex((option) => option.value === value)
  const tabStop = segmentedTabStop(enabled, checkedIndex)
  const showReason = disabled && Boolean(disabledReason)
  const describedBy =
    [ariaDescribedBy, showReason ? reasonId : undefined].filter(Boolean).join(' ') || undefined

  const choose = (index: number): void => {
    const option = options[index]
    if (option && enabled[index] && option.value !== value) {
      onValueChange(option.value)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return
    }
    const current = buttons.current.indexOf(event.target as HTMLButtonElement | null)
    if (current === -1) {
      return
    }
    const target = segmentedTargetIndex(enabled, current, event.key)
    if (target === null) {
      return
    }
    event.preventDefault()
    buttons.current[target]?.focus()
    if (activationMode === 'automatic') {
      choose(target)
    }
  }

  const renderOption = (option: SegmentedControlOption<T>, index: number): React.ReactElement => {
    const {
      value: optionValue,
      label,
      disabled: _optionDisabled,
      className: optionClassName,
      onClick: onOptionClick,
      tooltip,
      ...buttonProps
    } = option
    const checked = index === checkedIndex
    const button = (
      <button
        {...buttonProps}
        aria-checked={checked}
        className={cn(
          tabsTriggerBaseClassName,
          size === 'sm' ? 'h-5 px-2 text-xs' : 'h-6',
          'aria-checked:text-foreground aria-checked:chrome-plate',
          optionClassName
        )}
        data-checked={checked ? '' : undefined}
        data-slot="segmented-control-item"
        data-unchecked={checked ? undefined : ''}
        disabled={!enabled[index]}
        onClick={(event) => {
          choose(index)
          onOptionClick?.(event)
        }}
        ref={(element) => {
          buttons.current[index] = element
        }}
        role="radio"
        tabIndex={index === tabStop ? 0 : -1}
        type="button"
      >
        {label}
      </button>
    )
    if (!tooltip) {
      return <React.Fragment key={optionValue}>{button}</React.Fragment>
    }
    // The trigger renders the segment itself: Base UI adds its handlers and
    // `data-popup-open`, and the segment keeps its own checked state.
    return (
      <Tooltip key={optionValue}>
        <TooltipTrigger render={button} />
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    )
  }

  const track = (
    // oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- Roving focus: the checked radio is the group's one tab stop, never the group.
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
      onKeyDown={handleKeyDown}
      role="radiogroup"
    >
      {options.map(renderOption)}
    </div>
  )

  if (!showReason) {
    return track
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-slot="segmented-control-field">
      {track}
      <p className="text-muted-foreground text-xs" id={reasonId}>
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
