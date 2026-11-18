import type { GraphicsContent } from '../../../shared/cloud-graphics'

// Plan 249 S24: kept apart from `cloud-presentation-restore` (loaded lazily
// after a takeover) because the graphics poll applies it on every refresh.

/**
 * Plan 249 S24: this computer's own graphics, with the kept banners filling
 * an orientation where it shows no banner of its own. Its own banners always
 * win; the hook stops filling once its banner list changes.
 */
export function withRestoredBanners(
  local: GraphicsContent,
  restored: GraphicsContent | null
): GraphicsContent {
  if (!restored) return local
  const side = (key: 'h' | 'v') =>
    local[key].some((layer) => layer.kind === 'banner')
      ? local[key]
      : [...restored[key], ...local[key]]
  return { ...local, h: side('h'), v: side('v') }
}
