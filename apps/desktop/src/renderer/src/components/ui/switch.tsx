'use client'

import { Switch as SwitchPrimitive } from '@base-ui/react/switch'

import { useFieldControlId, useFieldDescribedBy } from '@/components/ui/field-context'
import { cn } from '@/lib/utils'

// On, the track is the chrome fill; off, it is recessed. `sm` is a 16 px
// track, not a control height. Inside a Field its id goes on Base UI's hidden
// input, which the FieldLabel points at; Base UI then names the switch by
// that label.
function Switch({
  className,
  size = 'default',
  id,
  'aria-describedby': ariaDescribedBy,
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: 'sm' | 'default'
}) {
  const controlId = useFieldControlId(id)
  const describedBy = useFieldDescribedBy(ariaDescribedBy)
  return (
    <SwitchPrimitive.Root
      aria-describedby={describedBy}
      className={cn(
        'peer group/switch focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 data-checked:chrome-fill data-unchecked:bg-input/90 relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors duration-100 outline-none group-has-[:focus-visible]/field-label:ring-0 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-3 aria-invalid:ring-3 data-disabled:opacity-50 data-[size=default]:h-5 data-[size=default]:w-8 data-[size=sm]:h-4 data-[size=sm]:w-6',
        className
      )}
      data-size={size}
      data-slot="switch"
      id={controlId}
      {...props}
    >
      <SwitchPrimitive.Thumb
        // A chrome bead on its rim, like the slider's, never the glass coat.
        // On, the track is chrome, so the knob turns the inverse bead: black
        // in dark, pearl in light.
        className="chrome-bead ring-knob-ring data-checked:chrome-bead-ink pointer-events-none block rounded-full ring-1 transition-transform duration-100 group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-checked:translate-x-[calc(100%-4px)] data-unchecked:translate-x-0"
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
