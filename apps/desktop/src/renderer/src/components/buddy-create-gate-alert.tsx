import type { ComponentProps, ReactElement } from 'react'

import { ALLOW_CLOUD_AI_LABEL } from '@/components/cloud-ai-consent-dialog'
import { LockAlert } from '@/components/lock-alert'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { BuddyCreateGate } from '@/lib/buddy-create-gate'
import { lockAlertAction } from '@/lib/lock-view'

/**
 * The one way a creating surface says why creating is off (plan 174 S3.15a,
 * G-5): a lock with its one line and at most one action. Sign-in and Premium
 * locks are the app's `LockAlert`; the cloud AI lock offers "Allow cloud AI",
 * which opens the one consent dialog (`CloudAiConsentDialog`); the rest lock
 * alone. Everything under it is disabled, and nothing live-looking sits
 * beside it.
 */
export function BuddyCreateGateAlert({
  gate,
  onAllowCloudAi,
  ...props
}: Omit<ComponentProps<typeof Alert>, 'variant' | 'icon' | 'children'> & {
  gate: BuddyCreateGate
  /** Opens the cloud AI consent; without it the cloud AI lock has no action. */
  onAllowCloudAi?: () => void
}): ReactElement {
  const action = gate.action
  if (action?.kind === 'allow-cloud-ai') {
    return (
      <Alert variant="locked" data-gate={gate.kind} {...props}>
        <AlertTitle>{gate.reason}</AlertTitle>
        {onAllowCloudAi ? (
          <AlertAction>
            <Button
              data-action="allow-cloud-ai"
              size="xs"
              type="button"
              variant="outline"
              onClick={onAllowCloudAi}
            >
              {ALLOW_CLOUD_AI_LABEL}
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    )
  }
  return (
    <LockAlert
      action={lockAlertAction(action)}
      data-gate={gate.kind}
      reason={gate.reason}
      {...props}
    />
  )
}
