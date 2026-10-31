import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

// Glass chips: every badge is a small piece of the window glass (the
// glass-chip utilities in the theme). The text stays monochrome. A status chip
// carries its tone in a glowing dot, or in its leading icon when it has one,
// and an emphasis chip (failed, on air) tints the glass itself.
const STATUS_DOT =
  'gap-1.5 before:size-1.5 before:shrink-0 before:rounded-full before:glass-dot has-data-[icon=inline-start]:before:hidden [&>[data-icon=inline-start]]:text-(--chip-tone)'

const badgeVariants = cva(
  // 11 px at weight 500: a tag, not the 600 section label (text-label).
  'group/badge rounded-tag focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden border px-1.5 text-[11px] leading-none font-medium whitespace-nowrap focus-visible:ring-3 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    defaultVariants: {
      variant: 'default'
    },
    variants: {
      variant: {
        // Chrome: a highlight's On stream is a polished chrome chip that keeps
        // its green status dot. No border, so the light and shade reach the
        // edge.
        chrome: `chrome-fill tone-success border-transparent ${STATUS_DOT}`,
        // Neutral glass.
        default: 'glass-chip text-foreground',
        // Emphasis: tinted glass for what must interrupt.
        destructive: 'glass-chip-tinted tone-destructive',
        ghost: 'text-muted-foreground border-transparent',
        live: 'glass-chip-tinted tone-live',
        neutral: `glass-chip tone-neutral text-muted-foreground ${STATUS_DOT}`,
        // Tag: the same glass with secondary text (9:16, beta, counts, Idle).
        outline: 'glass-chip text-muted-foreground',
        // A member's chip: a chrome plate, borderless like `chrome`.
        plate: 'chrome-plate text-foreground border-transparent',
        // Status: the tone lives in the dot, never in the text.
        success: `glass-chip tone-success text-foreground ${STATUS_DOT}`,
        warning: `glass-chip tone-warning text-foreground ${STATUS_DOT}`
      }
    }
  }
)

function Badge({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      {
        className: cn(badgeVariants({ variant }), className)
      },
      props
    ),
    render,
    state: {
      slot: 'badge',
      variant
    }
  })
}

export { Badge, badgeVariants }
