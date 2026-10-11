import type { ReactElement } from 'react'

import { BugIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useStudioCore } from '@/hooks/use-studio'
import { SUPPORT_BUNDLE_LABEL } from '@/lib/toast'

/** The action's one name wherever it appears (plan 174 S1.6b, I-1, V-X11), toasts included. */
export { SUPPORT_BUNDLE_LABEL }

/**
 * Export support bundle (plan 174 S1.6b, I-1): one look in its two homes,
 * Health and Settings → About. Redacted logs and diagnostics; the toast that
 * follows names the file and copies its path.
 */
export function SupportBundleButton({ className }: { className?: string }): ReactElement {
  const { exportSupportBundle, supportBundleExportPending } = useStudioCore()
  return (
    <Button
      className={className}
      data-testid="support-bundle-button"
      disabled={supportBundleExportPending}
      size="sm"
      type="button"
      variant="outline"
      onClick={() => void exportSupportBundle()}
    >
      <BugIcon data-icon="inline-start" />
      {supportBundleExportPending ? 'Exporting…' : SUPPORT_BUNDLE_LABEL}
    </Button>
  )
}
