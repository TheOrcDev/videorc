// Floating-glass checks for `probe:ui-glass --surfaces` (plan 072; plan 091
// S3 for the tone check).
//
// A floating surface (menu, popover, hover card, tooltip, dialog, toast) is a
// flat, opaque tier of the window's solid tone (plan 091 D6, Ghostex's web
// modals). The probe paints the real utilities over a text-free patch of the
// window and over app text, region-captures both states, and these pure
// helpers score the samples. Calibration and the populations:
// docs/acceptance/2026-09-28-glass-floating-surfaces.md (plan 072) and
// docs/acceptance/2026-10-02-clear-glass-calibration.md (plan 091).
//
//   tone         the surface reads its own token: the RGB distance between
//                the capture and the computed background colour the page
//                reports for it (getComputedStyle through CDP), per backdrop.
//                Plan 072's "lift over the window glass" band is gone: the
//                dark floats are now deliberately darker than the glass over
//                a bright desktop, so a fixed tone, whatever is behind, is
//                the contract.
//   contrast     the text tokens against the surface over white and black
//                backdrops (the plan 050 thresholds)
//   opaque       the surface reads the same over every backdrop. It fails
//                closed on a capture something else obscured (a backdrop
//                stacked over the window washed the whole frame once) and on
//                a coat that went translucent.
//   bleed        app text under the surface must not read through it:
//                sharpness with the surface stays under the window glass
//                ceiling, while the same rect without it proves there was
//                text to hide. (A CSS frost cannot do this job: it never
//                reaches the screen on the vibrancy windows.)

import { colorDistance, contrastRatio, oklchLightness } from './image-stats.mjs'

export const FLOAT_GLASS_THRESHOLDS = Object.freeze({
  // A neutral opaque tone reaches the display unchanged (plan 091 S1 proved
  // the sRGB prediction of the neutral coats within 1.5 steps), so the
  // capture is compared with the token directly; 4 keeps 2.6x the plan 091
  // population and fails a tier off by one 3% step (about 7 RGB steps).
  maxToneDistance: 4,
  maxSurfaceSpread: 0.01,
  minTextUnder: 20,
  maxSharpnessThrough: 0.5,
  minPrimaryContrast: 7,
  minSecondaryContrast: 4.5
})

const round = (value, digits = 3) => Number(value.toFixed(digits))

/** Grows a rect (window points) on every side, clamped to the window. */
export function growRect(rect, by, bounds) {
  const x = Math.max(0, rect.x - by)
  const y = Math.max(0, rect.y - by)
  const right = Math.min(bounds.width, rect.x + rect.width + by)
  const bottom = Math.min(bounds.height, rect.y + rect.height + by)
  return { x, y, width: right - x, height: bottom - y }
}

/** A centred sub-rect of at most `width` × `height` inside `rect`. */
export function centredRect(rect, width, height) {
  const w = Math.min(width, rect.width)
  const h = Math.min(height, rect.height)
  return {
    x: rect.x + (rect.width - w) / 2,
    y: rect.y + (rect.height - h) / 2,
    width: w,
    height: h
  }
}

// The bleed sample skips the top band of the surface. Plan 072's sheen
// gradient lived there (its 8-bit banding read as detail); plan 091 S3 made
// the floats flat, and the band stays as a margin from the rim and the
// shadow's edge.
export const SHEEN_FRACTION = 0.35

/** The part of `rect` below the top band of a surface painted at `surface`. */
export function belowSheen(rect, surface) {
  const top = Math.max(rect.y, surface.y + surface.height * SHEEN_FRACTION + 2)
  const bottom = rect.y + rect.height
  if (bottom - top < 6) throw new Error('The text sample sits inside the surface sheen.')
  return { x: rect.x, y: top, width: rect.width, height: bottom - top }
}

/**
 * Scores one patch: `surfaceMeans` maps a backdrop variant (red, blue,
 * white, black, text) to the mean sRGB colour of the rect with the surface
 * painted, `expected` is the surface's computed background colour (sRGB)
 * and `text` holds the theme's primary and secondary text colours.
 */
export function evaluateFloatPatch({ surfaceMeans, text, expected }) {
  const variants = Object.keys(surfaceMeans ?? {})
  if (!variants.length) throw new Error('No backdrop variant was measured with the surface.')
  if (!expected) throw new Error('The surface needs its computed colour for the tone check.')
  const surfaceLightness = variants.map((variant) => oklchLightness(surfaceMeans[variant]))
  const toneBy = Object.fromEntries(
    variants.map((variant) => [variant, round(colorDistance(surfaceMeans[variant], expected), 2)])
  )
  const tone = Math.max(...Object.values(toneBy))
  const surfaceSpread = Math.max(...surfaceLightness) - Math.min(...surfaceLightness)
  const contrastBackdrops = ['white', 'black'].filter((variant) => surfaceMeans[variant])
  if (!contrastBackdrops.length) throw new Error('Contrast needs the white or black backdrop.')
  const primaryContrast = Math.min(
    ...contrastBackdrops.map((variant) => contrastRatio(text.primary, surfaceMeans[variant]))
  )
  const secondaryContrast = Math.min(
    ...contrastBackdrops.map((variant) => contrastRatio(text.secondary, surfaceMeans[variant]))
  )
  const checks = {
    tone: tone <= FLOAT_GLASS_THRESHOLDS.maxToneDistance,
    opaque: surfaceSpread <= FLOAT_GLASS_THRESHOLDS.maxSurfaceSpread,
    primaryContrast: primaryContrast >= FLOAT_GLASS_THRESHOLDS.minPrimaryContrast,
    secondaryContrast: secondaryContrast >= FLOAT_GLASS_THRESHOLDS.minSecondaryContrast
  }
  return {
    metrics: {
      tone,
      toneBy,
      surfaceLightness: round(
        surfaceLightness.reduce((sum, value) => sum + value, 0) / surfaceLightness.length
      ),
      expectedLightness: round(oklchLightness(expected)),
      surfaceSpread: round(surfaceSpread),
      primaryContrast: round(primaryContrast, 2),
      secondaryContrast: round(secondaryContrast, 2)
    },
    checks,
    pass: Object.values(checks).every(Boolean)
  }
}

/** Scores the bleed: app text under the surface must not stay legible. */
export function evaluateFloatBleed({ sharpnessUnder, sharpnessThrough }) {
  const checks = {
    textPresent: sharpnessUnder >= FLOAT_GLASS_THRESHOLDS.minTextUnder,
    noBleed: sharpnessThrough <= FLOAT_GLASS_THRESHOLDS.maxSharpnessThrough
  }
  return {
    metrics: {
      sharpnessUnder: round(sharpnessUnder, 2),
      sharpnessThrough: round(sharpnessThrough, 2)
    },
    checks,
    pass: Object.values(checks).every(Boolean)
  }
}
