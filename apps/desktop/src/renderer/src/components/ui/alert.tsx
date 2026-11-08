import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { ErrorIcon, InfoIcon, LockIcon, SuccessIcon, WarningIcon } from '@/components/icons'
import type { AppIcon } from '@/components/icons'
import { cn } from '@/lib/utils'

// A flush inline status row, never a card: a faint tone tint, the icon in the
// tone, and monochrome text.
// - The variant is the tone and brings its own icon: one glyph and one weight
//   per tone. `icon` swaps in a subject's own mark (the microphone, a
//   platform), and `icon={null}` drops it. Callers never pass an icon as a
//   child.
// - Destructive is the one assertive alert (`role="alert"`); every other
//   variant is a polite status line (`role="status"`). An explicit `role`
//   still wins (a card that is a group, a note).
// - `quiet` is a neutral note in secondary text. `locked` says why the
//   controls under it are off.
// - A title alone is a message and reads in regular weight; a title over an
//   AlertDescription is a heading and reads in medium.
const alertVariants = cva(
  "group/alert rounded-row text-foreground relative grid w-full gap-0.5 px-3 py-2.5 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      variant: 'default'
    },
    variants: {
      variant: {
        default: 'bg-foreground/4 *:[svg]:text-muted-foreground',
        destructive: 'bg-destructive/10 *:[svg]:text-destructive',
        locked: 'bg-foreground/4 *:[svg]:text-muted-foreground',
        quiet: 'bg-foreground/4 *:[svg]:text-muted-foreground',
        success: 'bg-success/10 *:[svg]:text-success',
        warning: 'bg-warning/10 *:[svg]:text-warning'
      }
    }
  }
)

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>['variant']>

/** One glyph per tone, from the icon registry's meanings. */
const ALERT_ICONS: Record<AlertVariant, AppIcon> = {
  default: InfoIcon,
  destructive: ErrorIcon,
  locked: LockIcon,
  quiet: InfoIcon,
  success: SuccessIcon,
  warning: WarningIcon
}

/** The live-region role an alert of this tone announces with. */
function alertRole(variant: AlertVariant): 'alert' | 'status' {
  return variant === 'destructive' ? 'alert' : 'status'
}

function Alert({
  className,
  variant,
  icon,
  children,
  ...props
}: ComponentProps<'div'> &
  VariantProps<typeof alertVariants> & {
    /** The leading icon: the tone's own when omitted, a subject's mark, or `null` for none. */
    icon?: AppIcon | null
  }) {
  const tone = variant ?? 'default'
  const Icon = icon === undefined ? ALERT_ICONS[tone] : icon
  return (
    <div
      className={cn(alertVariants({ variant: tone }), className)}
      data-slot="alert"
      data-variant={tone}
      role={alertRole(tone)}
      {...props}
    >
      {Icon ? <Icon aria-hidden data-slot="alert-icon" weight="fill" /> : null}
      {children}
    </div>
  )
}

function AlertTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        '[&_a]:hover:text-foreground group-data-[variant=locked]/alert:text-muted-foreground group-data-[variant=quiet]/alert:text-muted-foreground font-normal group-has-data-[slot=alert-description]/alert:font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3',
        className
      )}
      data-slot="alert-title"
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'text-muted-foreground [&_a]:hover:text-foreground text-sm text-balance md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_p:not(:last-child)]:mb-4',
        className
      )}
      data-slot="alert-description"
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('absolute top-2.5 right-3', className)}
      data-slot="alert-action"
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
