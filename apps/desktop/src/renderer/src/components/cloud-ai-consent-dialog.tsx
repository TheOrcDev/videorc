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
import { CLOUD_AI_KEEPS, CLOUD_AI_USES } from '@/lib/buddy-tab-view'

/** The Cloud AI switch's own label (Buddy tab, Cloud AI section), and the gate action's. */
export const ALLOW_CLOUD_AI_LABEL = 'Allow cloud AI'

/**
 * Cloud AI consent where creating needs it (plan 119 decision 3; one dialog
 * for every creating surface, plan 174 S3.15a): the same one flag and the
 * same list of uses as the Buddy tab's Cloud AI switch, so nothing is
 * granted that the list does not name. The safe choice has the focus.
 * Accepting is the caller's `setAiConsent(true)`; declining changes nothing.
 */
export function CloudAiConsentDialog({
  open,
  onAnswer,
  testId = 'cloud-ai-consent'
}: {
  open: boolean
  onAnswer: (accepted: boolean) => void
  testId?: string
}): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onAnswer(false)
      }}
    >
      <DialogContent data-testid={testId} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{ALLOW_CLOUD_AI_LABEL}</DialogTitle>
          <DialogDescription>{CLOUD_AI_KEEPS}</DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
          {CLOUD_AI_USES.map((use) => (
            <li key={use}>{use}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button autoFocus type="button" variant="ghost" onClick={() => onAnswer(false)}>
            Not now
          </Button>
          <Button type="button" onClick={() => onAnswer(true)}>
            {ALLOW_CLOUD_AI_LABEL}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
