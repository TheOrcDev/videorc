import * as React from 'react'

import { cn } from '@/lib/utils'
import { useFieldControlId, useFieldDescribedBy } from '@/components/ui/field-context'

function Input({ className, type, id, ...props }: React.ComponentProps<'input'>) {
  const controlId = useFieldControlId(id)
  const describedBy = useFieldDescribedBy(props['aria-describedby'])
  return (
    <input
      id={controlId}
      aria-describedby={describedBy}
      type={type}
      data-slot="input"
      className={cn(
        'h-control w-full min-w-0 rounded-chip border border-transparent bg-input/50 px-2.5 py-1 text-sm transition-[color,box-shadow] duration-150 outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        className
      )}
      {...props}
    />
  )
}

export { Input }
