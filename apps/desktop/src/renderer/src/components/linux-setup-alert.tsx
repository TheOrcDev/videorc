import type { ReactElement } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { LinuxSetupIssue } from '@/lib/linux-desktop-check'

/**
 * One thing this Linux desktop is missing and what to install (plan 257
 * S18). Health shows one per issue; Destinations shows the keyring one
 * before any sign-in starts. Selectable, so the command can be copied.
 */
export function LinuxSetupAlert({ issue }: { issue: LinuxSetupIssue }): ReactElement {
  return (
    <Alert
      data-linux-setup-issue={issue.id}
      data-testid={`linux-setup-${issue.id}`}
      variant="warning"
    >
      <AlertTitle>{issue.title}</AlertTitle>
      <AlertDescription className="select-text">{issue.description}</AlertDescription>
    </Alert>
  )
}
