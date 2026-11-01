import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "group/button rounded-chip focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 inline-flex shrink-0 items-center justify-center border bg-clip-padding text-sm font-medium whitespace-nowrap transition-colors duration-100 outline-none select-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      size: 'default',
      variant: 'default'
    },
    variants: {
      size: {
        // The desktop control height: 28 px everywhere. The one compact size
        // is `xs` / `icon-xs` (24 px), for dense rows only.
        default:
          'h-control gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5',
        icon: 'size-control',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        lg: 'h-8 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3',
        xs: "h-6 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3"
      },
      variant: {
        // A face of the theme's solid in a ring of liquid chrome that flows
        // around it and surges on hover. It always moves: one per screen.
        chromatic: 'chrome-chromatic',
        // Polished chrome: no border, so its light and shade reach the edge;
        // the focus ring still draws.
        default: 'chrome-fill border-0',
        destructive:
          'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40 border-transparent',
        ghost:
          'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50 border-transparent',
        link: 'text-primary border-transparent underline-offset-4 hover:underline',
        outline:
          'border-border hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-input/30 bg-transparent',
        // Record and its stop button only: a red LED, lit with `data-lit`
        // while a recording or livestream runs. Delete and every other
        // destructive action stay `destructive`.
        record: 'chrome-led border-0',
        // The chip recipe: the same glass as a badge, with the secondary
        // tone under it on hover.
        secondary:
          'glass-chip text-secondary-foreground hover:bg-secondary aria-expanded:bg-secondary',
        // The regular button: a flat fill in the primary ink, no chrome.
        solid:
          'bg-primary text-primary-foreground hover:bg-primary/85 active:bg-primary/75 aria-expanded:bg-primary/85 border-transparent'
      }
    }
  }
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      className={cn(buttonVariants({ className, size, variant }))}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      {...props}
    />
  )
}

export { Button, buttonVariants }
