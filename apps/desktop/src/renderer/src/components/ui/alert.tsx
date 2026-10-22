import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import {
  type AppIcon,
  ErrorIcon,
  InfoIcon,
  LockIcon,
  SuccessIcon,
  WarningIcon
} from '@/components/icons'
import { cn } from '@/lib/utils'

// A flush inline status row (plan 050, D5), never a card: a faint tone tint,
// the icon in the tone, and monochrome text. Plan 174 S1.5:
// - The variant is the tone and brings its own icon: one glyph and one weight
//   per tone. `icon` swaps in a subject's own mark (Buddy, the microphone),
//   and `icon={null}` drops it. Callers never pass an icon as a child.
// - Destructive is the one assertive alert (`role="alert"`); every other
//   variant is a polite status line (`role="status"`). An explicit `role`
//   still wins (a card that is a group, a note).
// - `quiet` is a neutral note in secondary text. `locked` says why the
//   controls under it are off (LockAlert and SessionLockAlert,
//   components/lock-alert.tsx).
// - A title alone is a message and reads in regular weight; a title over an
//   AlertDescription is a heading and reads in medium.
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-row px-3 py-2.5 text-left text-sm text-foreground has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-foreground/[0.04] *:[svg]:text-muted-foreground',
        quiet: 'bg-foreground/[0.04] *:[svg]:text-muted-foreground',
        locked: 'bg-foreground/[0.04] *:[svg]:text-muted-foreground',
        destructive: 'bg-destructive/10 *:[svg]:text-destructive',
        warning: 'bg-warning/10 *:[svg]:text-warning',
        success: 'bg-success/10 *:[svg]:text-success'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>['variant']>

/** One glyph per tone, from the icon registry's meanings. */
const ALERT_ICONS: Record<AlertVariant, AppIcon> = {
  default: InfoIcon,
  quiet: InfoIcon,
  locked: LockIcon,
  destructive: ErrorIcon,
  warning: WarningIcon,
  success: SuccessIcon
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
}: React.ComponentProps<'div'> &
  VariantProps<typeof alertVariants> & {
    /** The leading icon: the tone's own when omitted, a subject's mark, or `null` for none. */
    icon?: AppIcon | null
  }) {
  const tone = variant ?? 'default'
  const Icon = icon === undefined ? ALERT_ICONS[tone] : icon
  return (
    <div
      data-slot="alert"
      data-variant={tone}
      role={alertRole(tone)}
      className={cn(alertVariants({ variant: tone }), className)}
      {...props}
    >
      {Icon ? <Icon aria-hidden data-slot="alert-icon" weight="fill" /> : null}
      {children}
    </div>
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        'font-normal group-has-[>svg]/alert:col-start-2 group-has-data-[slot=alert-description]/alert:font-medium group-data-[variant=locked]/alert:text-muted-foreground group-data-[variant=quiet]/alert:text-muted-foreground [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground',
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4',
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-action"
      className={cn('absolute top-2.5 right-3', className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
