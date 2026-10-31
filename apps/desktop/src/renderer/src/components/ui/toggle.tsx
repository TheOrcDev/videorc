'use client'

import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

// Pressed is the chrome plate with primary text, as a selected segment and an
// active tab are. Hover stays the flat muted block: the plate means pressed.
const toggleVariants = cva(
  "group/toggle rounded-chip text-muted-foreground hover:bg-muted hover:text-foreground data-pressed:text-foreground data-pressed:chrome-plate focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 inline-flex items-center justify-center gap-1 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      size: 'default',
      variant: 'default'
    },
    variants: {
      size: {
        // The desktop control height: 28 px.
        default:
          'h-control min-w-7 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        // The one compact size: 24 px, for dense rows and filter chips.
        xs: 'h-6 min-w-6 px-1.5 text-xs'
      },
      variant: {
        default: 'bg-transparent',
        outline: 'border-input hover:bg-muted border bg-transparent'
      }
    }
  }
)

function Toggle({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      className={cn(toggleVariants({ className, size, variant }))}
      data-slot="toggle"
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
