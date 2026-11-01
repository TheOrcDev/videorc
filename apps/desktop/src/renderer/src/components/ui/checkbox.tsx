'use client'

import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'

import { CheckIcon } from '@/components/icons'
import { useFieldControlId, useFieldDescribedBy } from '@/components/ui/field-context'
import { cn } from '@/lib/utils'

// Checked is the chrome fill on a transparent rim, with its ink.
// `indeterminate` (a header checkbox over some of its rows) fills like
// checked and draws a dash instead of the check: a 2 px bar, so the mixed
// state needs no glyph of its own.
// Inside a Field its id goes on Base UI's hidden input, which the FieldLabel
// points at; Base UI then names the checkbox by that label.
function Checkbox({
  className,
  id,
  'aria-describedby': ariaDescribedBy,
  ...props
}: CheckboxPrimitive.Root.Props) {
  const controlId = useFieldControlId(id)
  const describedBy = useFieldDescribedBy(ariaDescribedBy)
  return (
    <CheckboxPrimitive.Root
      aria-describedby={describedBy}
      className={cn(
        'peer group/checkbox bg-input/90 focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 not-data-unchecked:chrome-fill rounded-chip relative flex size-4 shrink-0 items-center justify-center border border-transparent transition-shadow outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-3 aria-invalid:ring-3 data-disabled:opacity-50',
        className
      )}
      data-slot="checkbox"
      id={controlId}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
        data-slot="checkbox-indicator"
      >
        <CheckIcon className="group-data-indeterminate/checkbox:hidden" />
        <span
          aria-hidden
          className="hidden h-0.5 w-2 rounded-full bg-current group-data-indeterminate/checkbox:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
