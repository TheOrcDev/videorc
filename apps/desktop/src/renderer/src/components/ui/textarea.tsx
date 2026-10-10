import * as React from 'react'

import { cn } from '@/lib/utils'
import { useFieldControlId } from '@/components/ui/field-context'

function Textarea({ className, id, ...props }: React.ComponentProps<'textarea'>) {
  const controlId = useFieldControlId(id)
  return (
    <textarea
      id={controlId}
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full resize-none rounded-chip border border-transparent bg-input/50 px-2.5 py-2 text-sm transition-[color,box-shadow] duration-150 outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
