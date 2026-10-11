import { cn } from '@/lib/utils'

// An empty state (videorc-design; plan 174 S1.5, D11): short muted text,
// centred, with an optional 14 px / 500 title above it. No media tile, no
// illustration, no dashed box. The pane or list it sits in sets the space
// around it; an action, when there is one, goes in EmptyContent.

function Empty({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty"
      className={cn(
        'flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-balance',
        className
      )}
      {...props}
    />
  )
}

function EmptyHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-header"
      className={cn('flex max-w-sm flex-col items-center gap-1', className)}
      {...props}
    />
  )
}

function EmptyTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-title"
      className={cn('text-sm font-medium text-foreground', className)}
      {...props}
    />
  )
}

function EmptyDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-description"
      className={cn(
        'text-sm text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-foreground',
        className
      )}
      {...props}
    />
  )
}

function EmptyContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        'flex w-full max-w-sm min-w-0 flex-col items-center gap-3 text-sm text-balance',
        className
      )}
      {...props}
    />
  )
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent }
