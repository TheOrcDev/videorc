'use client'

import type { ComponentProps } from 'react'

import { useFieldControlId, useFieldDescribedBy } from '@/components/ui/field-context'
import { cn } from '@/lib/utils'

// 14 px text at every width, like Input. Inside a Field it registers its id,
// so the FieldLabel names it, and the Field's descriptions describe it.
function Textarea({
  className,
  id,
  'aria-describedby': ariaDescribedBy,
  ...props
}: ComponentProps<'textarea'>) {
  const controlId = useFieldControlId(id)
  const describedBy = useFieldDescribedBy(ariaDescribedBy)
  return (
    <textarea
      aria-describedby={describedBy}
      className={cn(
        'bg-input/50 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 rounded-chip flex field-sizing-content min-h-16 w-full resize-none border border-transparent px-2.5 py-2 text-sm transition-[color,box-shadow] duration-150 outline-none focus-visible:ring-3 disabled:opacity-50 aria-invalid:ring-3',
        className
      )}
      data-slot="textarea"
      id={controlId}
      {...props}
    />
  )
}

export { Textarea }
