'use client'

import { Input as InputPrimitive } from '@base-ui/react/input'
import type { ComponentProps } from 'react'

import { useFieldControlId, useFieldDescribedBy } from '@/components/ui/field-context'
import { cn } from '@/lib/utils'

// The desktop control height (28 px) and 14 px text at every width: never the
// mobile 16 px, which only exists to stop iOS zooming into a focused field.
// Inside a Field it registers its id, so the FieldLabel names it, and the
// Field's descriptions describe it.
function Input({
  className,
  type,
  id,
  'aria-describedby': ariaDescribedBy,
  ...props
}: ComponentProps<'input'>) {
  const controlId = useFieldControlId(id)
  const describedBy = useFieldDescribedBy(ariaDescribedBy)
  return (
    <InputPrimitive
      aria-describedby={describedBy}
      className={cn(
        'bg-input/50 file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 h-control rounded-chip w-full min-w-0 border border-transparent px-2.5 py-1 text-sm transition-[color,box-shadow] duration-150 outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-3',
        className
      )}
      data-slot="input"
      id={controlId}
      type={type}
      {...props}
    />
  )
}

export { Input }
