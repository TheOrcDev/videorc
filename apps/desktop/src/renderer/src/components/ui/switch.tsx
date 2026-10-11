import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { useFieldControlId, useFieldDescribedBy } from '@/components/ui/field-context'

function Switch({
  className,
  size = 'default',
  id,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: 'sm' | 'default'
}) {
  const controlId = useFieldControlId(id)
  const describedBy = useFieldDescribedBy(props['aria-describedby'])
  return (
    <SwitchPrimitive.Root
      id={controlId}
      aria-describedby={describedBy}
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch relative inline-flex shrink-0 items-center rounded-full border-2 transition-colors duration-100 outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-5 data-[size=default]:w-8 data-[size=sm]:h-4 data-[size=sm]:w-6 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=unchecked]:border-transparent data-[state=unchecked]:bg-input/90 data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        // The knob stays white in both themes, like AppKit's and the slider's
        // (plan 174 S1.8, J1-15): --knob with its rim, never the glass coat.
        className="pointer-events-none block rounded-full bg-knob shadow-sm ring-1 ring-knob-ring transition-transform duration-100 group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-4px)] data-[state=unchecked]:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
