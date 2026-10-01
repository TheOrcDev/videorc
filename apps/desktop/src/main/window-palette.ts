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
 * How much of the base tone each window region paints over the clear blur
 * (plan 091, D3 and D5): styles.css `--glass-cover-sidebar` /
 * `--glass-cover-work` per platform and theme. The macOS numbers are
 * Ghostex's (dark work 83%, the smallest cover that keeps secondary text at
 * 4.5:1 over white); the Windows numbers reproduce the plan 050 Mica
 * composite exactly. window-palette.test.ts fails when styles.css drifts.
 */
export interface GlassCovers {
  sidebar: number
  work: number
}

export const GLASS_COVERS = Object.freeze({
  darwin: {
    dark: { sidebar: 0.88, work: 0.83 },
    light: { sidebar: 0.93, work: 0.86 }
  },
  win32: {
    dark: { sidebar: 0.34, work: 0.5116 },
    light: { sidebar: 0.5, work: 0.62 }
  }
} as const satisfies Record<string, Record<'dark' | 'light', GlassCovers>>)

export interface GlassCoats {
  /** The body coat's alpha: the lighter cover, so first paint is already tinted. */
  body: number
  /** What the sidebar adds over the body to composite to its cover. */
  sidebar: number
  /** What a content pane adds over the body to composite to its cover. */
  content: number
}

/**
 * styles.css's D4 derivation, in numbers: the body paints
 * `min(sidebar, work)` and each region adds `1 - (1 - cover) / (1 - body)`,
 * so coat over body composites to exactly the region's cover.
 */
export function deriveGlassCoats(covers: GlassCovers): GlassCoats {
  const body = Math.min(covers.sidebar, covers.work)
  const delta = (cover: number): number =>
    body >= 1 ? 0 : 1 - (1 - cover) / Math.max(1 - body, 0.001)
  return { body, sidebar: delta(covers.sidebar), content: delta(covers.work) }
}

/** The cover a coat over the body composites to: the inverse of `deriveGlassCoats`. */
export function compositeCover(body: number, coat: number): number {
  return 1 - (1 - body) * (1 - coat)
}

/** styles.css `.dark` `--glass-base`: the dark tone every dark coat is cut from. */
export const DARK_GLASS_BASE = '0.13 0.003 286'

function alphaPercent(alpha: number): string {
  return `${Math.round(alpha * 10_000) / 100}%`
}

/**
 * The dark glass coats for main-side documents that cannot read the
 * stylesheet: the Preview frame paints both over the clear material, pinned
 * dark because it frames video (plan 050; plan 091 S2). Derived from the
 * dark covers like styles.css derives its own: the body paints the work
 * cover (83%) and the content coat is the work delta, 0% on macOS, so the
 * frame composites to exactly what the main window's work area does.
 * window-palette.test.ts fails when these drift from styles.css.
 */
export const DARK_GLASS_COATS = Object.freeze(
  (() => {
    const coats = deriveGlassCoats(GLASS_COVERS.darwin.dark)
    return {
      window: `oklch(${DARK_GLASS_BASE} / ${alphaPercent(coats.body)})`,
      content: `oklch(${DARK_GLASS_BASE} / ${alphaPercent(coats.content)})`
    }
  })()
)
