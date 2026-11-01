'use client'

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import * as React from 'react'

import { CloseIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The dialog anatomy, shared with AlertDialog: the dialog tier of the float
 * glass, flat and opaque, the panel radius, p-5, fading and scaling from 0.98
 * in 100 ms. No backdrop-filter, here or on the overlay: CSS backdrop blur
 * wedged the renderer's compositor on a vibrancy window (a blank app until
 * restart).
 *
 * Four widths, never an ad-hoc max-w: sm 384 px (a rename, one question),
 * md 448 px (the default: confirmations, short forms), lg 576 px (forms,
 * pickers, setup), xl 768 px (review and media: Go Live, markers, galleries).
 * One height rule: a dialog is never taller than the window less 16 px on
 * each side. It is a column, so a DialogBody between the header and the
 * footer takes what is left and scrolls; a dialog without one scrolls whole.
 */

/**
 * The dialog tier's surface and widths on their own, for a surface on that
 * tier which is not a dialog (a first-run setup card). Everything else takes
 * them through DialogContent.
 */
const DIALOG_SURFACE_CLASS =
  'rounded-panel border glass-float-dialog p-5 text-sm text-popover-foreground'

const DIALOG_SIZE_CLASS = {
  lg: 'sm:max-w-xl',
  md: 'sm:max-w-md',
  sm: 'sm:max-w-sm',
  xl: 'sm:max-w-3xl'
} as const

const dialogContentVariants = cva(
  `fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto ${DIALOG_SURFACE_CLASS} data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] duration-100 outline-none`,
  {
    defaultVariants: { size: 'md' },
    variants: {
      size: DIALOG_SIZE_CLASS
    }
  }
)

type DialogSize = NonNullable<VariantProps<typeof dialogContentVariants>['size']>

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        // No backdrop blur: see the compositor note above.
        'data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate z-50 bg-black/30 duration-100',
        className
      )}
      data-slot="dialog-overlay"
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
}: DialogPrimitive.Popup.Props & {
  size?: DialogSize
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        className={cn(dialogContentVariants({ size }), className)}
        data-size={size}
        data-slot="dialog-content"
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button className="absolute top-3 right-3" size="icon" variant="ghost" />}
          >
            <CloseIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex shrink-0 flex-col gap-1.5', className)}
      data-slot="dialog-header"
      {...props}
    />
  )
}

/**
 * The part of a dialog that scrolls: it takes the height the header and the
 * footer leave, so they stay in view. Its scroll reaches the dialog's edges,
 * and its padding keeps focus rings unclipped.
 */
function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        '-mx-5 -my-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-1',
        className
      )}
      data-slot="dialog-body"
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
      className={cn('flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      data-slot="dialog-footer"
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn('font-heading text-base leading-none font-medium', className)}
      data-slot="dialog-title"
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn(
        'text-muted-foreground *:[a]:hover:text-foreground text-sm *:[a]:underline *:[a]:underline-offset-3',
        className
      )}
      data-slot="dialog-description"
      {...props}
    />
  )
}

export {
  DIALOG_SIZE_CLASS,
  DIALOG_SURFACE_CLASS,
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
  DialogTrigger,
  dialogContentVariants,
  type DialogSize
}
