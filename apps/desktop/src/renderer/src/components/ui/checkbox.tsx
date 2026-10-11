import * as React from 'react'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { useFieldControlId, useFieldDescribedBy } from '@/components/ui/field-context'
import { CheckIcon } from '@/components/icons'

// `checked="indeterminate"` (plan 174 S3.11, E-18: a header checkbox over
// some of its rows) fills like checked and draws a dash instead of the check:
// a 2 px bar, so the mixed state needs no glyph of its own.
function Checkbox({
  className,
  id,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  const controlId = useFieldControlId(id)
  const describedBy = useFieldDescribedBy(props['aria-describedby'])
  return (
    <CheckboxPrimitive.Root
      id={controlId}
      aria-describedby={describedBy}
      data-slot="checkbox"
      className={cn(
        'peer group/checkbox relative flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-transparent bg-input/90 transition-shadow outline-none group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <CheckIcon className="group-data-[state=indeterminate]/checkbox:hidden" />
        <span
          aria-hidden
          className="hidden h-0.5 w-2 rounded-full bg-current group-data-[state=indeterminate]/checkbox:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
