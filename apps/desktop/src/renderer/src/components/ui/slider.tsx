'use client'

import { Slider as SliderPrimitive } from '@base-ui/react/slider'

import { useFieldDescribedBy, useFieldLabelledBy } from '@/components/ui/field-context'
import { cn } from '@/lib/utils'

// A slider's name and spoken value belong on its thumbs, whose inputs carry
// role="slider". Base UI's root is a group, so `aria-label`,
// `aria-labelledby`, `aria-describedby` and `aria-valuetext` go to every
// thumb instead. Inside a Field, a slider that names nothing takes the
// FieldLabel, and the Field's descriptions describe it.
// The range is the chrome fill and every thumb a chrome bead on its rim.
// Generic like Base UI's root, so a scalar `value` gets a scalar
// `onValueChange` and an array an array.
function Slider<Value extends number | readonly number[]>({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-valuetext': ariaValueText,
  ...props
}: SliderPrimitive.Root.Props<Value>) {
  // One thumb per value: a scalar (or nothing) is one thumb, an array one
  // each.
  const values = value ?? defaultValue
  const thumbCount = Array.isArray(values) ? values.length : 1
  const labelledBy = useFieldLabelledBy(ariaLabelledBy, ariaLabel)
  const describedBy = useFieldDescribedBy(ariaDescribedBy)

  return (
    <SliderPrimitive.Root
      className={cn('data-horizontal:w-full data-vertical:h-full', className)}
      data-slot="slider"
      defaultValue={defaultValue}
      max={max}
      min={min}
      thumbAlignment="edge"
      value={value}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col">
        <SliderPrimitive.Track
          className="bg-foreground/15 relative grow overflow-hidden rounded-full select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1"
          data-slot="slider-track"
        >
          <SliderPrimitive.Indicator
            className="chrome-fill select-none data-horizontal:h-full data-vertical:w-full"
            data-slot="slider-range"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: thumbCount }, (_, index) => (
          <SliderPrimitive.Thumb
            aria-describedby={describedBy}
            aria-label={ariaLabel}
            aria-labelledby={labelledBy}
            aria-valuetext={ariaValueText}
            className="chrome-bead ring-knob-ring hover:ring-ring/30 has-focus-visible:ring-ring/30 block size-4 shrink-0 rounded-full ring-1 transition-[color,box-shadow] duration-150 select-none hover:ring-4 has-focus-visible:ring-4 data-disabled:pointer-events-none"
            data-slot="slider-thumb"
            index={index}
            key={index}
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
