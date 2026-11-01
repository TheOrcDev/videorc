// Plan 208 S3: pure checks over controlled, text-free capture patches. Since
// the owner took the chrome ground out (2026-10-29), every window is the solid
// palette: no ground image is mounted and the pixels never move.
import { clampRect, contrastRatio, relativeLuminance } from './image-stats.mjs'
import { parseCssColor } from './glass-parity.mjs'

// Same WCAG ratios and gamma-sRGB -> linear luminance math as
// window-contrast.test.ts; capture pixels already contain the coats.
export const GROUND_CONTRAST = Object.freeze({ foreground: 7, 'muted-foreground': 4.5, subtle: 3 })

// Select the A/B from the request, never from applied state: a product
// regression must fail its requested contract instead of choosing easier gates.
export function isClearGlassRun(env, overrides = {}) {
  return (overrides.VIDEORC_GLASS ?? env.VIDEORC_GLASS)?.trim().toLowerCase() === 'clear'
}

export function backgroundExtremes(image, rect) {
  const area = clampRect(image, rect)
  let low = null
  let high = null
  let min = Infinity
  let max = -Infinity
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      const i = (y * image.width + x) * 4
      const rgb = { r: image.data[i], g: image.data[i + 1], b: image.data[i + 2] }
      const luma = relativeLuminance(rgb)
      if (luma < min) {
        min = luma
        low = rgb
      }
      if (luma > max) {
        max = luma
        high = rgb
      }
    }
  }
  return [low, high]
}

// No tolerance: one changed channel of one pixel fails. Compare every pixel
// in each maintained text-free chrome patch, not means which can hide leaks.
// Exclude live video, clocks, text cursors and rounded transparent corners.
export function pixelStability(images, rect) {
  if (images.length < 2) throw new Error('Opacity needs at least two backdrop captures.')
  const first = images[0]
  const area = clampRect(first, rect)
  let changedPixels = 0
  let maxDelta = 0
  for (const image of images.slice(1)) {
    if (image.width !== first.width || image.height !== first.height) {
      throw new Error('Opacity captures changed dimensions.')
    }
    for (let y = area.y; y < area.y + area.height; y++) {
      for (let x = area.x; x < area.x + area.width; x++) {
        const i = (y * image.width + x) * 4
        let delta = 0
        for (let c = 0; c < 4; c++)
          delta = Math.max(delta, Math.abs(image.data[i + c] - first.data[i + c]))
        if (delta) changedPixels++
        maxDelta = Math.max(maxDelta, delta)
      }
    }
  }
  return { changedPixels, maxDelta, pass: changedPixels === 0 }
}

export function groundDomChecks({ theme, pageDark, ground }) {
  const checks = {}
  checks.followsTheme = pageDark === (theme === 'dark')
  checks.solidRoot = ground?.ground === 'solid'
  checks.noGround = ground?.mounted === false && (ground?.images ?? []).length === 0
  return checks
}

export function evaluateGround({ theme, role, glassState, pageDark, ground, samples, stability }) {
  const preview = role === 'preview'
  const mode = glassState?.applied?.mode
  const checks = {
    mode: mode?.kind === 'solid',
    noVibrancy: Array.isArray(glassState?.effectViews) && glassState.effectViews.length === 0,
    opaquePixels: stability?.pass === true
  }
  const metrics = { glass: mode?.kind ?? 'unknown', ...stability }
  if (preview) {
    metrics.maxLuminance = Math.max(...samples.flatMap((s) => s.extremes).map(relativeLuminance))
    checks.pinnedDark = metrics.maxLuminance <= 0.12
  } else {
    Object.assign(checks, groundDomChecks({ theme, pageDark, ground }))
    for (const [tier, threshold] of Object.entries(GROUND_CONTRAST)) {
      const text = ground?.tiers?.[tier] ? parseCssColor(ground.tiers[tier]) : null
      const ratio = text
        ? Math.min(...samples.flatMap((s) => s.extremes).map((bg) => contrastRatio(text, bg)))
        : 0
      metrics[tier + 'Contrast'] = Number(ratio.toFixed(3))
      checks[tier + 'Contrast'] = !!text && text.a === 1 && ratio >= threshold
    }
  }
  return { metrics, checks, pass: Object.values(checks).every(Boolean) }
}
