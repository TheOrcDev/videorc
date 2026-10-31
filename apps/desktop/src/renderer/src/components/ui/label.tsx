'use client'

import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

// No not-allowed cursor on a disabled peer: desktop controls keep the arrow.
// Base UI's Checkbox and Switch are spans, never :disabled, so their
// data-disabled dims the label too.
function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    // oxlint-disable-next-line jsx-a11y/label-has-associated-control -- The caller associates it, through htmlFor or a FieldLabel's Field.
    <label
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:opacity-50 peer-data-disabled:opacity-50',
        className
      )}
      data-slot="label"
      {...props}
    />
  )
}

export { Label }
