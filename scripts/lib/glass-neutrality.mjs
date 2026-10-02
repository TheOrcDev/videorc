// Plan 091 helpers for probe:ui-glass.
//
// `neutrality`: with the renderer's coats zeroed, a stripped material (the
// clear glass) passes the backdrop colour through unchanged, so the window
// sample must sit within a few RGB steps of the backdrop. AppKit's own
// material tints it grey or white and sits hundreds of steps away.
//
// `nativeClear`: what the native addon reads back from every behind-window
// effect view: the clear-glass class, the Ghostex blur radius, no visible
// wallpaper-tinting layer and no saturation filter.

import { colorDistance } from './image-stats.mjs'

export const NEUTRALITY_BACKDROPS = Object.freeze(['white', 'black', 'red', 'blue'])

/** AppKit's `NSVisualEffectBlendingModeBehindWindow`. */
const BEHIND_WINDOW = 0

/**
 * A patch of bare backdrop beside the window, outside its shadow, that the
 * probe captures as the colour reference. Comparing a capture with a capture
 * cancels the display's colour pipeline: a P3 panel never shows `#ff0000`
 * as 255,0,0. Right of the window when the work area has room, else below
 * it; null when neither fits.
 */
export function backdropReferenceRect(windowBounds, workArea, { gap = 80, size = 40 } = {}) {
  const right = windowBounds.x + windowBounds.width + gap
  if (right + size <= workArea.x + workArea.width - 8) {
    return {
      x: right,
      y: windowBounds.y + Math.min(120, Math.floor(windowBounds.height / 2)),
      width: size,
      height: size
    }
  }
  const below = windowBounds.y + windowBounds.height + gap
  if (below + size <= workArea.y + workArea.height - 8) {
    return {
      x: windowBounds.x + Math.min(120, Math.floor(windowBounds.width / 2)),
      y: below,
      width: size,
      height: size
    }
  }
  return null
}

/**
 * The RGB distance between the coat-free window sample and the backdrop
 * reference, per backdrop and at worst.
 */
export function neutralityOf(sampleMeans, referenceMeans, backdrops = NEUTRALITY_BACKDROPS) {
  const byBackdrop = {}
  for (const variant of backdrops) {
    if (!sampleMeans[variant] || !referenceMeans[variant]) {
      throw new Error(`neutrality: no ${variant} sample or reference.`)
    }
    byBackdrop[variant] = colorDistance(sampleMeans[variant], referenceMeans[variant])
  }
  return { max: Math.max(...Object.values(byBackdrop)), byBackdrop }
}

/**
 * Scores the addon's effect-view read-back. Only behind-window views are the
 * window material; a view without a blending mode (an older addon) counts.
 */
export function nativeClearCheck(effectViews, { blurRadius = 60 } = {}) {
  const views = (Array.isArray(effectViews) ? effectViews : []).filter(
    (view) => typeof view.blendingMode !== 'number' || view.blendingMode === BEHIND_WINDOW
  )
  const failures = new Set()
  for (const view of views) {
    if (view.clear !== true) failures.add('class')
    if (view.blurRadius !== blurRadius) failures.add('radius')
    if (view.chameleonVisible === true) failures.add('chameleon')
    if (view.saturatePresent !== false) failures.add('saturate')
  }
  if (views.length === 0) failures.add('no-effect-views')
  return {
    pass: failures.size === 0,
    views: views.length,
    clear: views.length > 0 && views.every((view) => view.clear === true),
    blurRadius: views[0]?.blurRadius ?? null,
    chameleonVisible: views[0]?.chameleonVisible ?? null,
    saturatePresent: views[0]?.saturatePresent ?? null,
    rootBackground: views[0]?.rootBackground ?? null,
    failures: [...failures]
  }
}
