import { useEffect, useSyncExternalStore } from 'react'

import { APP_ICONS_MAX_IDS } from '../../../shared/app-icons'

// Plan 210 S5: app icons come from main (`getAppIcons`, filled in by S4),
// once per bundle id for the whole window: the scene list, the Studio
// gallery and New scene… share them. An app main leaves out keeps the
// generic glyph; it is not asked again this launch.

const icons = new Map<string, string | null>()
const asking = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function publish(): void {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Only an image data URL is drawn: anything else falls back to the glyph. */
function iconUrl(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('data:image/') ? value : null
}

/** The icon for each bundle id that has one; asks main for the ones not yet known. */
export function useAppIcons(bundleIds: readonly string[]): ReadonlyMap<string, string | null> {
  useSyncExternalStore(subscribe, () => version)
  const key = [...new Set(bundleIds.filter(Boolean))].sort().join('\n')
  useEffect(() => {
    const getAppIcons = window.videorc?.getAppIcons
    const missing = key.split('\n').filter((id) => id && !icons.has(id) && !asking.has(id))
    if (!getAppIcons || missing.length === 0) return
    for (const id of missing) asking.add(id)
    const batches = Array.from({ length: Math.ceil(missing.length / APP_ICONS_MAX_IDS) }, (_, i) =>
      missing.slice(i * APP_ICONS_MAX_IDS, (i + 1) * APP_ICONS_MAX_IDS)
    )
    void Promise.all(batches.map((ids) => getAppIcons(ids)))
      .then((results) => {
        const found = Object.fromEntries(results.flatMap((result) => Object.entries(result)))
        for (const id of missing) icons.set(id, iconUrl(found[id]))
      })
      .catch((error: unknown) => {
        console.warn('[scenes] app icons unavailable', error)
        for (const id of missing) icons.set(id, null)
      })
      .finally(() => {
        for (const id of missing) asking.delete(id)
        publish()
      })
  }, [key])
  return icons
}

/** Tests start from an empty cache. */
export function resetAppIconsForTest(): void {
  icons.clear()
  asking.clear()
  publish()
}
