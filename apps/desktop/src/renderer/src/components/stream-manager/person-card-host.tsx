import { useState, type ReactElement } from 'react'

import { PersonCardBody, type PersonCardTarget } from '@/components/community/person-card-body'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Popover, PopoverContent } from '@/components/ui/popover'
import type { CommunityPerson } from '@/lib/backend'
import { forgetCopy } from '@/lib/community-view'
import { toastUserError } from '@/lib/user-error'
import type { CommunityRelayCall } from '../../../../shared/community-relay'

/** What the Stream Manager asked to open: whose card, from which row. */
export interface PersonCardRequest {
  target: PersonCardTarget
  /** The chat row it came from: the popover lines up with it. */
  messageId?: string
  /** A right-click's "Same person as…" opens on the search. */
  startIn?: 'card' | 'link'
  /** Bumped per ask, so the same row asked twice opens again. */
  seq: number
}

/** Under this window width the card is a dialog (D11: Narrow). */
export const PERSON_CARD_DIALOG_BELOW_PX = 640

/**
 * The Stream Manager's person card (plan 225 C2), its own chunk: a popover
 * on the float glass lined up with the chat row at Wide and Medium, a small
 * dialog under 640 px. "Forget …" asks here, outside the popover, so the
 * question outlives it.
 */
export default function PersonCardHost({
  request,
  call,
  memoryLock,
  onClose
}: {
  request: PersonCardRequest | null
  call: CommunityRelayCall
  /** Why "Buddy remembers" is locked, and the upgrade link; null when unlocked. */
  memoryLock: { reason: string; upgradeUrl?: string; onUpgrade?: (url: string) => void } | null
  onClose: () => void
}): ReactElement {
  const [forgetting, setForgetting] = useState<CommunityPerson | null>(null)
  const [busy, setBusy] = useState(false)
  const open = request !== null
  const narrow = typeof window !== 'undefined' && window.innerWidth < PERSON_CARD_DIALOG_BELOW_PX
  const anchor =
    request?.messageId && typeof document !== 'undefined'
      ? document.querySelector(
          `[data-pane="chat"] [data-message-id="${CSS.escape(request.messageId)}"]`
        )
      : null

  // The Buddy pane's own locked notice, one reason and View Premium (plan
  // 174 F-14), so the card stays in the Stream Manager's chunks.
  const lock = memoryLock ? (
    <Alert variant="locked">
      <AlertTitle>{memoryLock.reason}</AlertTitle>
      {memoryLock.upgradeUrl && memoryLock.onUpgrade ? (
        <AlertAction>
          <Button
            size="xs"
            type="button"
            variant="outline"
            onClick={() => memoryLock.onUpgrade?.(memoryLock.upgradeUrl as string)}
          >
            View Premium
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  ) : null
  const body = request ? (
    <PersonCardBody
      key={request.seq}
      call={call}
      memoryLock={lock}
      startIn={request.startIn}
      target={request.target}
      onClose={onClose}
      onForgetRequest={(person) => {
        setForgetting(person)
        onClose()
      }}
    />
  ) : null
  const forget = forgetting ? forgetCopy(forgetting.name) : null

  return (
    <>
      {narrow ? (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
          <DialogContent data-testid="person-card-dialog" size="sm">
            <DialogHeader>
              <DialogTitle>About {request?.target.name}</DialogTitle>
            </DialogHeader>
            <DialogBody>{body}</DialogBody>
          </DialogContent>
        </Dialog>
      ) : (
        <Popover open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
          <PopoverContent
            align="start"
            anchor={anchor ?? undefined}
            aria-label={`About ${request?.target.name ?? ''}`}
            // Never taller than the room the window leaves: the card scrolls.
            // (less the collision padding Base UI keeps from the edge).
            className="max-h-[calc(var(--available-height)-0.75rem)] w-80 overflow-y-auto"
            data-testid="person-card-popover"
            side="bottom"
          >
            {body}
          </PopoverContent>
        </Popover>
      )}
      <ConfirmDialog
        confirmDisabled={busy}
        confirmLabel={busy ? 'Forgetting…' : (forget?.confirm ?? 'Forget')}
        description={forget?.description ?? ''}
        open={forgetting !== null}
        testId="person-forget"
        title={forget?.title ?? ''}
        onCancel={() => setForgetting(null)}
        onConfirm={() => {
          if (!forgetting) return
          setBusy(true)
          call('cohost.community.forget', { personId: forgetting.id })
            .then(
              () => setForgetting(null),
              (error: unknown) =>
                toastUserError(
                  error,
                  { action: 'forget', object: forgetting.name },
                  { id: 'community-card' }
                )
            )
            .finally(() => setBusy(false))
        }}
      />
    </>
  )
}
