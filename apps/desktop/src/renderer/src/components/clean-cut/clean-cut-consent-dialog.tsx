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
import { CLOUD_AI_KEEPS, CLOUD_AI_USES } from '@/lib/buddy-tab-view'

/** What asked for consent: the "every recording" switch, or one cut. */
export type CleanCutConsentAsk =
  | { kind: 'auto' }
  | { kind: 'start'; sessionId: string; mode: CleanCutMode; targetMinutes: number }

export const CLEAN_CUT_CONSENT_DESCRIPTION =
  "Clean cut uploads your recording's audio, never the video, to Videorc's cloud AI."

/**
 * Cloud AI consent, asked where Clean cut needs it (plan 119 decision 3): the
 * same one flag and the same list of uses as Golem Live, so nothing is
 * granted that the list does not name. Declining changes nothing; the safe
 * choice has the focus.
 */
export function CleanCutConsentDialog({
  ask,
  onAnswer
}: {
  ask: CleanCutConsentAsk | null
  onAnswer: (accepted: boolean) => void
}): ReactElement {
  const auto = ask?.kind === 'auto'
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
          <DialogDescription>{CLEAN_CUT_CONSENT_DESCRIPTION}</DialogDescription>
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
            {auto ? 'Allow and turn on' : 'Allow and make it'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
