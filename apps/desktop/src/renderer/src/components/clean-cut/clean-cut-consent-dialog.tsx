import type { ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { CleanCutMode } from '@/lib/backend'
import { CLOUD_AI_CLEAN_CUT_USE, CLOUD_AI_KEEPS, cloudAiUsesLedBy } from '@/lib/buddy-tab-view'

/** What asked for consent: the "every recording" switch, or one cut. */
export type CleanCutConsentAsk =
  | { kind: 'auto' }
  | { kind: 'start'; sessionId: string; mode: CleanCutMode; targetMinutes: number }

/** The heading over the rest of the list: what the same switch also allows. */
export const CLEAN_CUT_CONSENT_ALSO = 'Allowing cloud AI also covers Buddy:'

/**
 * Cloud AI consent, asked where Clean cut needs it (plan 119 decision 3): the
 * same one flag and the same list of uses as Buddy Live, so nothing is
 * granted that the list does not name. Clean cut's own line leads, with its
 * retention, and the uses the same switch also allows follow (plan 174
 * E-13). Declining changes nothing; the safe choice has the focus.
 */
export function CleanCutConsentDialog({
  ask,
  onAnswer
}: {
  ask: CleanCutConsentAsk | null
  onAnswer: (accepted: boolean) => void
}): ReactElement {
  const auto = ask?.kind === 'auto'
  const uses = cloudAiUsesLedBy(CLOUD_AI_CLEAN_CUT_USE)
  return (
    <Dialog
      open={ask !== null}
      onOpenChange={(open) => {
        if (!open) onAnswer(false)
      }}
    >
      <DialogContent data-clean-cut="consent" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{auto ? 'Turn on Clean cut?' : 'Make a clean cut?'}</DialogTitle>
          <DialogDescription>{uses.lead}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p>{CLEAN_CUT_CONSENT_ALSO}</p>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {uses.others.map((use) => (
              <li key={use}>{use}</li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">{CLOUD_AI_KEEPS}</p>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onAnswer(false)}>
            Not now
          </Button>
          <Button type="button" onClick={() => onAnswer(true)}>
            {auto ? 'Allow and turn on' : 'Allow and make it'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
