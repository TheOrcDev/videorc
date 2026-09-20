// Main-side palette for surfaces that CANNOT read the renderer's CSS tokens:
// the data-URL windows (Notes, Preview — dark-always by design, they frame
// video) and BrowserWindow backgroundColor fallbacks. The detached Chat and
// Captions windows are black glass on macOS (transparent + the renderer's
// wallpaper underlay) and fall back to this solid base off macOS or when glass
// is opted out. Values are the
// solid equivalents of styles.css (the black-glass / porcelain columns) —
// styles.css is the source of truth; change them together.
// (.claude/skills/videorc-design documents both.)

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
