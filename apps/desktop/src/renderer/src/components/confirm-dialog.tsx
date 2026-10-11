import type { MouseEvent, ReactElement, ReactNode } from 'react'

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

/**
 * The one recipe for a destructive confirmation (plan 174 S0.3, J1-3), over
 * the AlertDialog: a "Verb object?" title, one sentence that names exactly
 * what is lost, a ghost "Cancel" (or "Keep …") that has focus on open, and a
 * destructive button labelled verb + object. No close button: the two
 * answers are the only way out, and Escape is the safe one.
 *
 * Controlled: the owner closes it by dropping `open`, after a synchronous
 * action or once an async one settles (`confirmLabel` can read "Deleting…"
 * meanwhile). `onCancel` fires for the safe button and Escape.
 */
export function ConfirmDialog({
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
}: {
  open: boolean
  /** "Verb object?" */
  title: ReactNode
  /** One sentence naming exactly what is lost. */
  description: ReactNode
  /** The safe answer, focused on open: "Cancel", or "Keep …". */
  cancelLabel?: ReactNode
  cancelDisabled?: boolean
  /** The destructive answer: verb + object. */
  confirmLabel: ReactNode
  /** `default` for a consequential step that destroys nothing (a replace). */
  confirmVariant?: 'destructive' | 'default'
  confirmDisabled?: boolean
  /** Extra body between the sentence and the answers (an Alert, a field). */
  children?: ReactNode
  /** `{testId}-dialog`, `{testId}-cancel` and `{testId}-confirm` for tests. */
  testId?: string
  onCancel: () => void
  onConfirm: () => void
}): ReactElement {
  const hook = (suffix: string): string | undefined => (testId ? `${testId}-${suffix}` : undefined)
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
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
          <AlertDialogAction
            data-testid={hook('confirm')}
            disabled={confirmDisabled}
            variant={confirmVariant}
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              // Radix would close on this click; the owner closes instead,
              // so a pending action keeps the sheet (and its reason) up.
              event.preventDefault()
              onConfirm()
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
