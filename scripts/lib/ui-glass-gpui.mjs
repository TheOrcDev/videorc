// probe:ui-glass on the GPUI app: the pure checks over window-only captures
// (`screencapture -l <window id>`, which returns the window's own pixels and
// alpha, never the screen). See `ui-glass-probe-gpui.mjs` for what each check
// stands for against Electron's desktop-backdrop probe.
import { backgroundExtremes, pixelStability } from './window-ground-checks.mjs'
import { clampRect, contrastRatio, regionMean, relativeLuminance } from './image-stats.mjs'

// WCAG ratios per text tier, as `GROUND_CONTRAST` (window-ground-checks.mjs).
export const GPUI_CONTRAST = Object.freeze({ foreground: 7, 'muted-foreground': 4.5, subtle: 3 })

// Where each theme's ground must sit (relative luminance of the sample's mean).
export const GPUI_GROUND_LUMINANCE = Object.freeze({ darkMax: 0.2, lightMin: 0.6 })
// The Preview stays dark in both themes (the dark-always video chrome).
export const GPUI_PINNED_DARK_MAX = 0.12
const PINNED_DARK_ROLES = new Set(['preview'])

// Sample rects in window points (the window's own size), text-free in the
// layout the gallery shoots at 1100x700: the middle of the title row, the
// empty run of the sidebar between its pages and Library, the Stream Manager's
// empty right pane under its filters, and so on. Functions of the size.
export const GPUI_GROUND_SAMPLES = Object.freeze({
  main: [
    {
      name: 'content-toolbar',
      rect: (w) => ({ x: w.width * 0.45, y: 8, width: w.width * 0.15, height: 18 })
    },
    { name: 'sidebar-gap', rect: (w) => ({ x: 20, y: 470, width: 150, height: 100 }) }
  ],
  chat: [
    {
      name: 'right-pane',
      rect: (w) => ({ x: w.width * 0.66, y: 160, width: w.width * 0.3, height: 100 })
    }
  ],
  captions: [{ name: 'body', rect: (w) => ({ x: 40, y: 52, width: w.width - 80, height: 40 }) }],
  notes: [
    {
      name: 'textarea',
      rect: (w) => ({ x: w.width * 0.4, y: 150, width: w.width * 0.5, height: 120 })
    }
  ],
  preview: [
    { name: 'strip', rect: (w) => ({ x: w.width * 0.55, y: 6, width: w.width * 0.4, height: 14 }) }
  ]
})

/** The lowest alpha (0..255) in the rect (image pixels). */
export function minAlpha(image, rect) {
  const area = clampRect(image, rect)
  let min = 255
  for (let y = area.y; y < area.y + area.height; y += 1) {
    for (let x = area.x; x < area.x + area.width; x += 1) {
      min = Math.min(min, image.data[(y * image.width + x) * 4 + 3])
    }
  }
  return min
}

/**
 * One sample of one window under one theme. `images` are two or more decoded
 * captures of the same window moments apart (RGBA); `rect` is in image
 * pixels; `text` maps each contrast tier to the app's own token colour.
 */
export function evaluateGpuiGround({ theme, role, images, rect, text }) {
  const stability = pixelStability(images, rect)
  const alpha = Math.min(...images.map((image) => minAlpha(image, rect)))
  const extremes = backgroundExtremes(images[0], rect)
  const mean = regionMean(images[0], rect)
  const luminance = relativeLuminance(mean)
  const checks = {
    // Nothing shows through: every pixel is fully opaque.
    opaqueAlpha: alpha === 255,
    // Nothing moves between two captures: not tracking what is behind.
    stableCapture: stability.pass === true
  }
  const metrics = {
    minAlpha: alpha,
    changedPixels: stability.changedPixels,
    maxDelta: stability.maxDelta,
    luminance: Number(luminance.toFixed(4))
  }
  if (PINNED_DARK_ROLES.has(role)) {
    metrics.maxLuminance = Number(Math.max(...extremes.map(relativeLuminance)).toFixed(4))
    checks.pinnedDark = metrics.maxLuminance <= GPUI_PINNED_DARK_MAX
  } else {
    checks.followsTheme =
      theme === 'dark'
        ? luminance <= GPUI_GROUND_LUMINANCE.darkMax
        : luminance >= GPUI_GROUND_LUMINANCE.lightMin
    for (const [tier, threshold] of Object.entries(GPUI_CONTRAST)) {
      const token = text?.[tier]
      const ratio = token ? Math.min(...extremes.map((bg) => contrastRatio(token, bg))) : 0
      metrics[`${tier}Contrast`] = Number(ratio.toFixed(3))
      checks[`${tier}Contrast`] = !!token && ratio >= threshold
    }
  }
  return { metrics, checks, pass: Object.values(checks).every(Boolean) }
}
