import type { ReactElement } from 'react'

import { BuddyEmblem } from '@/components/buddy-emblem'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { CLOUD_AI_KEEPS, CLOUD_AI_USES } from '@/lib/buddy-tab-view'

/**
 * The cloud-AI consent Buddy asks for before it runs (plan 119 decision 3):
 * the one list of uses, in the Buddy tab and in the Stream Manager alike, so
 * nothing is granted that the list does not name. Accepting grants consent
 * and turns Buddy on; listening is its own choice afterwards (plan 174 S0.2).
 * Declining changes nothing, and the safe choice has the focus.
 */
export function BuddyConsentDialog({
  open,
  onAnswer
}: {
  open: boolean
  onAnswer: (accepted: boolean) => void
}): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onAnswer(false)
      }}
    >
      <DialogContent data-testid="buddy-consent-dialog" showCloseButton={false}>
        <DialogHeader>
          {/* Buddy's emblem leads, the way the Videorc logo leads
              permissions onboarding (plan 149). */}
          <div className="flex items-center gap-3">
            <BuddyEmblem size="lg" />
            <div className="flex flex-col gap-1">
              <DialogTitle>Turn on Buddy Live?</DialogTitle>
              <DialogDescription>
                Buddy uses Videorc&apos;s cloud AI while you&apos;re live.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
          {CLOUD_AI_USES.map((use) => (
            <li key={use}>{use}</li>
          ))}
        </ul>
        <p className="text-xs text-subtle">{CLOUD_AI_KEEPS}</p>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onAnswer(false)}>
            Not now
          </Button>
          <Button type="button" onClick={() => onAnswer(true)}>
            Allow and turn on
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
