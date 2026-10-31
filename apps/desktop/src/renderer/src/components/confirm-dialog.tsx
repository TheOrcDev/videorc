'use client'

import type { ReactElement, ReactNode } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

interface ConfirmDialogProps {
  open: boolean
  /** "Verb object?": "Delete saved scene?" */
  title: ReactNode
  /** One sentence naming exactly what is lost. */
  description: ReactNode
  /** The safe answer, focused on open: "Cancel", or "Keep …". */
  cancelLabel?: ReactNode
  cancelDisabled?: boolean
  /** The destructive answer: verb + object ("Delete scene"), or "Deleting…" while it runs. */
  confirmLabel: ReactNode
  /** `default` for a consequential step that destroys nothing (a replace). */
  confirmVariant?: 'destructive' | 'default'
  confirmDisabled?: boolean
  /** Extra body between the sentence and the answers (an Alert, a field). */
  children?: ReactNode
  /** `{testId}-dialog`, `{testId}-cancel` and `{testId}-confirm`, for tests. */
  testId?: string
  /** The safe button and Escape. */
  onCancel: () => void
  onConfirm: () => void
}

/**
 * The one recipe for a destructive confirmation, over the AlertDialog: a
 * "Verb object?" title, one sentence that names exactly what is lost, a ghost
 * "Cancel" (or "Keep …") that has focus on open, and a destructive button
 * labelled verb + object. No close button: the two answers are the only way
 * out, and Escape is the safe one.
 *
 * Controlled: the owner closes it by dropping `open`, after a synchronous
 * action or once an async one settles (`confirmLabel` can read "Deleting…"
 * meanwhile). `onCancel` fires for the safe button and Escape.
 */
function ConfirmDialog({
  open,
  title,
  description,
  cancelLabel = 'Cancel',
  cancelDisabled = false,
  confirmLabel,
  confirmVariant = 'destructive',
  confirmDisabled = false,
  children,
  testId,
  onCancel,
  onConfirm
}: ConfirmDialogProps): ReactElement {
  const hook = (suffix: string): string | undefined => (testId ? `${testId}-${suffix}` : undefined)
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          onCancel()
        }
      }}
      open={open}
    >
      <AlertDialogContent data-testid={hook('dialog')}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid={hook('cancel')} disabled={cancelDisabled}>
            {cancelLabel}
          </AlertDialogCancel>
          {/* The action doesn't close the dialog: the owner drops `open`, so a
              pending action keeps the sheet (and its reason) up. */}
          <AlertDialogAction
            data-testid={hook('confirm')}
            disabled={confirmDisabled}
            onClick={onConfirm}
            variant={confirmVariant}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export { ConfirmDialog }
export type { ConfirmDialogProps }
