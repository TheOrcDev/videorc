import { useState, type ReactElement } from 'react'

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useStudioCore } from '@/hooks/use-studio'
import {
  DEFAULT_COMMUNITY_SETTINGS,
  REMEMBER_OFFER_DESCRIPTION,
  REMEMBER_OFFER_TITLE
} from '@/components/community/community-copy'
import { toastUserError } from '@/lib/user-error'

/**
 * "Let Buddy remember what your regulars tell it?" (plan 225 D10): offered
 * once, after a stream regulars came to, on Reports and in Community, to a
 * streamer who can turn it on (Buddy Live with Cloud AI consent; without
 * them the locked "Buddy remembers" row says why). Turn on flips the
 * switch; Not now only keeps the answer. Never offered twice.
 */
export function RememberOffer({ regularsCame }: { regularsCame: boolean }): ReactElement | null {
  const { cohostGate, cohostSettings, patchCohostSettings } = useStudioCore()
  const [busy, setBusy] = useState(false)
  const settings = cohostSettings?.community ?? DEFAULT_COMMUNITY_SETTINGS
  if (
    !regularsCame ||
    !cohostGate.allowed ||
    !settings.enabled ||
    settings.remember ||
    settings.rememberOffered
  ) {
    return null
  }
  const answer = (remember: boolean): void => {
    setBusy(true)
    patchCohostSettings({ community: { ...settings, remember, rememberOffered: true } })
      .catch((error: unknown) =>
        toastUserError(error, { action: 'save', object: 'Buddy remembers' }, { id: 'community' })
      )
      .finally(() => setBusy(false))
  }
  return (
    <Alert data-testid="community-remember-offer" role="note">
      <AlertTitle>{REMEMBER_OFFER_TITLE}</AlertTitle>
      <AlertDescription className="text-xs">{REMEMBER_OFFER_DESCRIPTION}</AlertDescription>
      <AlertAction className="flex gap-1.5">
        <Button
          data-testid="community-remember-on"
          disabled={busy}
          size="xs"
          type="button"
          onClick={() => answer(true)}
        >
          Turn on
        </Button>
        <Button
          data-testid="community-remember-later"
          disabled={busy}
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => answer(false)}
        >
          Not now
        </Button>
      </AlertAction>
    </Alert>
  )
}

export default RememberOffer
