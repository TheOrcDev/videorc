import { useCallback, useEffect, useState } from 'react'
import type { ChangelogEntry, WhatsNewResult } from '@/lib/whats-new'

// Post-update "What's new": when the app version changed since the last seen
// one, the newest changelog entry published in between opens in a dialog,
// naming the releases skipped on the way (plan 174 A-19). The check itself,
// the fetch and the parser live in lib/whats-new, loaded on demand after the
// shell is up: none of it is in the eager bundle (plan 174 S3.21).
const loadWhatsNew = (): Promise<typeof import('@/lib/whats-new')> => import('@/lib/whats-new')

export function useWhatsNew(
  version: string | undefined,
  runtimePlatform: string | undefined
): {
  entry: ChangelogEntry | null
  /** The releases between the last seen one and `entry`, newest first. */
  skippedVersions: string[]
  open: boolean
  dismiss: () => void
  showLatest: () => void
} {
  const [result, setResult] = useState<WhatsNewResult | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!version) {
      return
    }
    let cancelled = false
    void loadWhatsNew()
      .then((lib) => lib.checkWhatsNew({ version, runtimePlatform }))
      .then((found) => {
        if (cancelled || !found) {
          return
        }
        setResult(found)
        setOpen(true)
      })
    return () => {
      cancelled = true
    }
  }, [runtimePlatform, version])

  const dismiss = useCallback(() => {
    if (version) {
      void loadWhatsNew().then((lib) => lib.markWhatsNewSeen(version))
    }
    setOpen(false)
  }, [version])

  // Manual entry point (Settings → About & updates): always shows the latest
  // release, independent of the last-seen gate.
  const showLatest = useCallback(() => {
    void loadWhatsNew()
      .then((lib) => lib.latestWhatsNew(runtimePlatform))
      .then((found) => {
        if (!found) {
          return
        }
        setResult(found)
        setOpen(true)
      })
  }, [runtimePlatform])

  return {
    entry: result?.entry ?? null,
    skippedVersions: result?.skippedVersions ?? [],
    open,
    dismiss,
    showLatest
  }
}
