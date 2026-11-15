import { useCallback, useEffect, useRef, useState } from 'react'

import { BackendRequestError } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'
import type { AppPreview } from '@/lib/backend'
import { capturePickerDevices } from '@/lib/capture'
import {
  appChoicesFromDevices,
  appChoicesFromPreviews,
  type AppChoice
} from '@/lib/scene-app-picker'

/** Pictures at most this wide; the cards are about 170 px. */
const PICTURE_MAX_WIDTH = 320

let loggedFallback = false

/**
 * Add scene…'s and Change screen…'s apps (plan 210 S5, plan 231 D6).
 * `sources.app_previews` brings a picture of each app's front window, only
 * while the picker is open. When
 * Videorc doesn't know that request yet (or it fails), the device list
 * stands in: windows grouped by app, no pictures. The fallback is quiet,
 * logged once.
 */
export function useAppChoices(open: boolean): {
  apps: AppChoice[]
  loading: boolean
  /** Whether the cards can show pictures (the pictures request answered). */
  pictures: boolean
  /** Videorc's own apps, never offered (its windows included). */
  selfBundleIds: readonly string[]
  /** Every screen and window waits on Screen Recording. */
  grantMissing: boolean
  refresh: () => void
} {
  const { deviceList, sceneLibraryActions, refreshDevices } = useStudioCore()
  const listAppPreviews = useRef(sceneLibraryActions.listAppPreviews)
  listAppPreviews.current = sceneLibraryActions.listAppPreviews
  const [previews, setPreviews] = useState<AppPreview[] | null>(null)
  const [selfBundleIds, setSelfBundleIds] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!open) {
      setPreviews(null)
      return
    }
    let live = true
    setLoading(true)
    const previewsRequest = listAppPreviews
      .current({ maxWidth: PICTURE_MAX_WIDTH })
      .then((result) => result.apps)
      .catch((error: unknown) => {
        if (!loggedFallback) {
          loggedFallback = true
          if (error instanceof BackendRequestError && error.code === 'unknown-method')
            console.info('[scenes] app pictures need a newer Videorc; listing windows instead')
          else console.warn('[scenes] app pictures unavailable; listing windows instead', error)
        }
        void refreshDevices()
        return null
      })
    const selfRequest = (window.videorc?.getSelfBundleIds?.() ?? Promise.resolve([])).catch(
      () => [] as string[]
    )
    void Promise.all([previewsRequest, selfRequest]).then(([apps, self]) => {
      if (!live) return
      setPreviews(apps)
      setSelfBundleIds(self)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [open, generation, refreshDevices])

  const refresh = useCallback(() => setGeneration((value) => value + 1), [])
  const captureDevices = capturePickerDevices(deviceList.devices)
  return {
    apps: previews
      ? appChoicesFromPreviews(previews, selfBundleIds)
      : appChoicesFromDevices(deviceList.devices, selfBundleIds),
    loading,
    pictures: previews !== null,
    selfBundleIds,
    grantMissing:
      captureDevices.length > 0 &&
      captureDevices.every((device) => device.status === 'permission-required'),
    refresh
  }
}
