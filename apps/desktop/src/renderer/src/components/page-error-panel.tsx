import type { ReactElement } from 'react'

import type { CaughtError } from '@/components/error-boundary'
import { CopyDetailsButton, errorDetails } from '@/components/root-error-panel'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle
} from '@/components/ui/empty'

/**
 * A page's crash panel (plan 174 S3.21, A-7), under the toolbar, loaded only
 * once the page boundary caught something. The sidebar, the status bar and
 * every other page are still there around it.
 */
export function PageErrorPanel({
  error,
  componentStack,
  onReset
}: CaughtError & { onReset: () => void }): ReactElement {
  return (
    <Empty className="flex-1" data-testid="page-error" role="alert">
      <EmptyHeader>
        <EmptyTitle>This page hit a problem</EmptyTitle>
        <EmptyDescription>Other pages still work.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="flex gap-2">
          <Button type="button" onClick={onReset}>
            Reload page
          </Button>
          <CopyDetailsButton details={errorDetails(error, componentStack)} />
        </div>
      </EmptyContent>
    </Empty>
  )
}
