import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

// An empty state: short muted text, centred, with an optional 14 px / 500
// title above it. No media tile, no illustration, no dashed box and no radius
// of its own. The pane or list it sits in sets the space around it; an action,
// when there is one, goes in EmptyContent.

function Empty({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-balance',
        className
      )}
      data-slot="empty"
      {...props}
    />
  )
}

function EmptyHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex max-w-sm flex-col items-center gap-1', className)}
      data-slot="empty-header"
      {...props}
    />
  )
}

function EmptyTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('text-foreground text-sm font-medium', className)}
      data-slot="empty-title"
      {...props}
    />
  )
}

function EmptyDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'text-muted-foreground [&>a:hover]:text-foreground text-sm [&>a]:underline [&>a]:underline-offset-4',
        className
      )}
      data-slot="empty-description"
      {...props}
    />
  )
}

function EmptyContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex w-full max-w-sm min-w-0 flex-col items-center gap-3 text-sm text-balance',
        className
      )}
      data-slot="empty-content"
      {...props}
    />
  )
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent }
