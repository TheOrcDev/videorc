import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '@/lib/utils'

// Glass chips (plan 050, D9): every badge is a small piece of the window glass
// (the glass-chip utilities in styles.css). The text stays monochrome. A status
// chip carries its tone in a glowing dot, or in its leading icon when it has
// one, and an emphasis chip (failed, on air) tints the glass itself.
const STATUS_DOT =
  'gap-1.5 before:size-1.5 before:shrink-0 before:rounded-full before:glass-dot has-data-[icon=inline-start]:before:hidden [&>[data-icon=inline-start]]:text-(--chip-tone)'

const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[7px] border px-1.5 text-[11px] leading-none font-medium whitespace-nowrap focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        // Neutral glass.
        default: 'glass-chip text-foreground',
        secondary: 'glass-chip text-foreground',
        // Tag: the same glass with secondary text (9:16, beta, counts, Idle).
        outline: 'glass-chip text-muted-foreground',
        // Status: the tone lives in the dot, never in the text.
        success: `glass-chip tone-success text-foreground ${STATUS_DOT}`,
        warning: `glass-chip tone-warning text-foreground ${STATUS_DOT}`,
        neutral: `glass-chip tone-neutral text-muted-foreground ${STATUS_DOT}`,
        // Emphasis: tinted glass for what must interrupt.
        destructive: 'glass-chip-tinted tone-destructive',
        live: 'glass-chip-tinted tone-live',
        ghost: 'border-transparent text-muted-foreground',
        link: 'border-transparent text-foreground underline-offset-4 hover:underline'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span'

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
