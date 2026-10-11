import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { useFieldLabelledBy } from '@/components/ui/field-context'

// A slider's name and spoken value belong on its thumbs, the elements with
// role="slider" (plan 174 S0.5, E-3). Radix's root is a plain span, so
// `aria-label`, `aria-labelledby` and `aria-valuetext` go to every thumb
// instead. Inside a Field, a slider that names nothing takes the FieldLabel.
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-valuetext': ariaValueText,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max]),
    [value, defaultValue, min, max]
  )
  const labelledBy = useFieldLabelledBy(ariaLabelledBy, ariaLabel)
  // Only a given label replaces Radix's own ("Minimum" and "Maximum" on a range).
  const thumbLabel = ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        'relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col',
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative grow overflow-hidden rounded-full bg-foreground/15 data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="absolute bg-primary select-none data-horizontal:h-full data-vertical:w-full"
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          {...thumbLabel}
          aria-labelledby={labelledBy}
          aria-valuetext={ariaValueText}
          className="block size-4 shrink-0 rounded-full bg-knob shadow-sm ring-1 ring-knob-ring transition-[color,box-shadow] duration-150 select-none hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
