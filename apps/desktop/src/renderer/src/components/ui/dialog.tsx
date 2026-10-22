import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Dialog as DialogPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CloseIcon } from '@/components/icons'

/**
 * The dialog anatomy (plan 174 S1.6b, J1-20), shared with AlertDialog: the
 * dialog tier of the float glass (videorc-design, plan 091 D6), flat and
 * opaque, the panel radius, p-5, fading and scaling from 0.98 in ~100 ms. NO
 * backdrop-filter: CSS backdrop blur wedges the renderer compositor on the
 * vibrancy window (blank app until restart; bisected 2026-06-12).
 *
 * Four widths, never an ad-hoc max-w: sm 384 px (a rename, one question),
 * md 448 px (the default: confirmations, short forms), lg 576 px (forms,
 * pickers, setup), xl 768 px (review and media: Go Live, markers, galleries).
 * One height rule: a dialog is never taller than the window less 16 px on
 * each side. It is a column, so a DialogBody between the header and the
 * footer takes what is left and scrolls; a dialog without one scrolls whole.
 */
export const dialogContentVariants = cva(
  'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-panel border glass-float-dialog p-5 text-sm text-popover-foreground duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98]',
  {
    variants: {
      size: {
        sm: 'sm:max-w-sm',
        md: 'sm:max-w-md',
        lg: 'sm:max-w-xl',
        xl: 'sm:max-w-3xl'
      }
    },
    defaultVariants: { size: 'md' }
  }
)

export type DialogSize = NonNullable<VariantProps<typeof dialogContentVariants>['size']>

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // No backdrop blur: see DialogContent's compositor-wedge note.
        'fixed inset-0 isolate z-50 bg-black/30 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  size = 'md',
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  size?: DialogSize
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-size={size}
        className={cn(dialogContentVariants({ size }), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button variant="ghost" className="absolute top-3 right-3" size="icon">
              <CloseIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex shrink-0 flex-col gap-1.5', className)}
      {...props}
    />
  )
}

/**
 * The part of a dialog that scrolls (plan 174 S1.6b, J1-20): it takes the
 * height the header and the footer leave, so they stay in view. Its scroll
 * reaches the dialog's edges, and its padding keeps focus rings unclipped.
 */
function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        '-mx-5 -my-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-1',
        className
      )}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('font-heading text-base leading-none font-medium', className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger
}
