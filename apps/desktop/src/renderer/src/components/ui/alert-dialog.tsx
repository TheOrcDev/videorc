'use client'

import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { dialogContentVariants } from '@/components/ui/dialog'
import type { DialogSize } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

// shadcn's alert dialog on the window family: the dialog tier of the float
// glass, the panel radius, p-5, and no close button. Cancel has focus on open
// and Escape closes, so the safe answer is always one key away and a stray
// Space or Enter never destroys anything.

/** The open dialog's Cancel, so the dialog can focus it. */
const AlertDialogCancelContext =
  React.createContext<React.RefObject<HTMLButtonElement | null> | null>(null)

function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
}

function AlertDialogOverlay({ className, ...props }: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Backdrop
      className={cn(
        // No backdrop blur: see the compositor note in ui/dialog.
        'data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate z-50 bg-black/30 duration-100',
        className
      )}
      data-slot="alert-dialog-overlay"
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  size = 'md',
  initialFocus,
  ...props
}: AlertDialogPrimitive.Popup.Props & { size?: DialogSize }) {
  const cancelRef = React.useRef<HTMLButtonElement | null>(null)
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogCancelContext.Provider value={cancelRef}>
        <AlertDialogPrimitive.Popup
          // The dialog anatomy, exactly as DialogContent: flat and opaque, no
          // backdrop-filter, the same widths and height rule.
          className={cn(dialogContentVariants({ size }), className)}
          data-size={size}
          data-slot="alert-dialog-content"
          // Base UI focuses the first tabbable element, which is not Cancel
          // when the body holds a control: Cancel, when there is one, wins.
          initialFocus={initialFocus ?? (() => cancelRef.current ?? true)}
          {...props}
        />
      </AlertDialogCancelContext.Provider>
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex shrink-0 flex-col gap-1.5', className)}
      data-slot="alert-dialog-header"
      {...props}
    />
  )
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      data-slot="alert-dialog-footer"
      {...props}
    />
  )
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      className={cn('font-heading text-base leading-none font-medium', className)}
      data-slot="alert-dialog-title"
      {...props}
    />
  )
}

function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      className={cn(
        'text-muted-foreground *:[a]:hover:text-foreground text-sm *:[a]:underline *:[a]:underline-offset-3',
        className
      )}
      data-slot="alert-dialog-description"
      {...props}
    />
  )
}

// The answer. It doesn't close the dialog: the owner drops `open` once the
// action has run, so an async one keeps the sheet (and "Deleting…") up.
function AlertDialogAction({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(className)}
      data-slot="alert-dialog-action"
      size={size}
      variant={variant}
      {...props}
    />
  )
}

// The safe answer: a ghost button that closes the dialog.
function AlertDialogCancel({
  className,
  variant = 'ghost',
  size = 'default',
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  const cancelRef = React.useContext(AlertDialogCancelContext)
  return (
    <AlertDialogPrimitive.Close
      className={cn(className)}
      data-slot="alert-dialog-cancel"
      render={<Button ref={cancelRef} size={size} variant={variant} />}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger
}
