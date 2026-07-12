import { DownloadSimple, X } from '@phosphor-icons/react'
import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { useStudioCore } from '@/hooks/use-studio'
import { OBS_NUDGE_DISMISSED_KEY, shouldShowObsNudge } from '@/lib/obs-import-nudge'

const ObsImportDialog = lazy(async () => ({
  default: (await import('@/components/obs-import-dialog')).ObsImportDialog
}))

/** Fresh-profile hint (O5): one quiet dismissible row in the Studio — never
 *  shown once any capture source is picked or after a dismissal. */
export function ObsImportNudge(): ReactElement | null {
  const { captureConfig } = useStudioCore()
  const [obsAvailable, setObsAvailable] = useState(false)
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(OBS_NUDGE_DISMISSED_KEY) === '1'
  )
  const [importOpen, setImportOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.videorc?.obsDiscover?.().then((discovery) => {
      if (!cancelled && discovery) {
        setObsAvailable(discovery.available)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (
    !shouldShowObsNudge({ obsAvailable, sources: captureConfig.sources, dismissed }) &&
    !importOpen
  ) {
    return null
  }

  const dismiss = (): void => {
    localStorage.setItem(OBS_NUDGE_DISMISSED_KEY, '1')
    setDismissed(true)
  }

  return (
    <div className="flex items-center gap-2 rounded-row border bg-muted/40 px-3 py-2 text-sm">
      <DownloadSimple className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        Coming from OBS? Bring your scenes and settings across.
      </span>
      <Button size="xs" variant="outline" onClick={() => setImportOpen(true)}>
        Import from OBS…
      </Button>
      <Button aria-label="Dismiss OBS import hint" size="xs" variant="ghost" onClick={dismiss}>
        <X className="size-3.5" />
      </Button>
      {importOpen ? (
        <Suspense fallback={null}>
          <ObsImportDialog open onOpenChange={setImportOpen} />
        </Suspense>
      ) : null}
    </div>
  )
}
