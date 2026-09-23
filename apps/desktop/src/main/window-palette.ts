// Main-side palette for surfaces that CANNOT read the renderer's CSS tokens:
// the Preview frame's data-URL document (dark-always, it frames video) and the
// BrowserWindow solid bases used off macOS, with VIDEORC_GLASS=0, or when a
// dark-always window cannot pin its appearance (window-glass.ts). Values are
// the solid equivalents of styles.css (the black-glass / porcelain columns);
// styles.css is the source of truth. window-palette.test.ts pins the glass
// coats to it. (.claude/skills/videorc-design documents both.)

export interface WindowPalette {
  /** Window/body background — solid fallback of the theme's glass base. */
  base: string
  /** Bars/panels one step above the base (the card tier). */
  panel: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  hairline: string
  controlBg: string
  controlBorder: string
  /** Pressed/selected chrome fill + its ink. */
  chromeFill: string
  chromeFillText: string
  /** The brand red (the logo's LED-glow eyes) — record/live only, never chrome. */
  brandRed: string
}

// Black glass (styles.css .dark): base oklch(0.13 0.003 286), panel oklch(0.16),
// hairline white-10%, chrome text tiers.
export const DARK_WINDOW_PALETTE: WindowPalette = {
  base: '#0D0D0F',
  panel: '#141417',
  textPrimary: '#F4F4F5',
  textSecondary: '#A1A1AA',
  textTertiary: '#71717A',
  hairline: 'rgba(255,255,255,0.10)',
  controlBg: 'rgba(255,255,255,0.06)',
  controlBorder: 'rgba(255,255,255,0.12)',
  chromeFill: '#F4F4F5',
  chromeFillText: '#141417',
  brandRed: '#E23B3F'
}

// Porcelain (styles.css :root): base oklch(0.985), ink text.
export const LIGHT_WINDOW_PALETTE: WindowPalette = {
  base: '#FAFAFB',
  panel: '#FFFFFF',
  textPrimary: '#1C1C1E',
  textSecondary: '#6E6E73',
  textTertiary: '#98989D',
  hairline: 'rgba(0,0,0,0.08)',
  controlBg: 'rgba(0,0,0,0.04)',
  controlBorder: 'rgba(0,0,0,0.10)',
  chromeFill: '#1C1C1E',
  chromeFillText: '#FAFAFB',
  brandRed: '#D02A30'
}

export function windowPalette(dark: boolean): WindowPalette {
  return dark ? DARK_WINDOW_PALETTE : LIGHT_WINDOW_PALETTE
}

/**
 * The docked preview's corner radius, in points: the Studio slot's
 * `rounded-panel` (styles.css --radius-panel, 12px). The native CAMetalLayer
 * clips to it so the video and its CSS ground agree; window-palette.test.ts
 * fails when the two drift.
 */
export const DOCKED_PREVIEW_CORNER_RADIUS = 12

/**
 * The dark glass coats (styles.css `.dark` --glass-window / --glass-content)
 * for main-side documents that cannot read the stylesheet: the Preview frame
 * paints both over the OS material (plan 050). window-palette.test.ts fails
 * when these drift from styles.css.
 */
export const DARK_GLASS_COATS = Object.freeze({
  window: 'oklch(0.13 0.003 286 / 42%)',
  content: 'oklch(0.13 0.003 286 / 34%)'
})
