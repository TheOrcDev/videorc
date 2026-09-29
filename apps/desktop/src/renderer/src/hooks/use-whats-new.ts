import { useCallback, useEffect, useState } from 'react'
import type { ChangelogEntry } from '@/lib/whats-new'
import { WHATS_NEW_STORAGE_KEY } from '@/lib/whats-new-storage'

// The optional release-note controller loads after runtime discovery or the
// user's Settings action, leaving its parsing and network code off startup.
export function useWhatsNew(
  version: string | undefined,
  runtimePlatform: string | undefined
): {
  entry: ChangelogEntry | null
  open: boolean
  dismiss: () => void
  showLatest: () => void
} {
  const [entry, setEntry] = useState<ChangelogEntry | null>(null)
  const [open, setOpen] = useState(false)
  const show = useCallback((next: ChangelogEntry) => {
    setEntry(next)
    setOpen(true)
  }, [])

  useEffect(() => {
    if (!version) return
    let cancelled = false
    void import('@/lib/whats-new-controller')
      .then((controller) =>
        controller.checkWhatsNew(version, runtimePlatform, () => cancelled, show)
      )
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [runtimePlatform, show, version])

  const dismiss = useCallback(() => {
    if (version) localStorage.setItem(WHATS_NEW_STORAGE_KEY, version)
    setOpen(false)
  }, [version])

  const showLatest = useCallback(() => {
    void import('@/lib/whats-new-controller')
      .then((controller) => controller.showLatestWhatsNew(runtimePlatform, show))
      .catch(() => undefined)
  }, [runtimePlatform, show])

  return { entry, open, dismiss, showLatest }
}
