// Main-side palette for surfaces that CANNOT read the renderer's CSS tokens:
// the Preview frame's data-URL document (dark-always, it frames video) and
// every BrowserWindow's opaque base: the chrome-ground windows (plan 208), the
// solid palette with VIDEORC_GLASS=0, and a dark-always window under the
// clear glass that cannot pin its appearance (window-glass.ts). Values are
// the solid equivalents of styles.css (the black-chrome / porcelain columns,
// chroma 0 since plan 208); styles.css is the source of truth.
// window-palette.test.ts pins the glass coats to it.
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

// Black chrome (styles.css .dark): base oklch(0.13 0 0), the chrome's own
// black; panel oklch(0.16 0 0); hairline white-10%; the three text tiers
// (--foreground 0.97, --muted-foreground 0.71, --subtle 0.62) as neutral
// greys. Every value is chroma 0 (plan 208): the old zinc cast is gone.
export const DARK_WINDOW_PALETTE: WindowPalette = {
  base: '#070707',
  panel: '#0D0D0D',
  textPrimary: '#F5F5F5',
  textSecondary: '#A1A1A1',
  textTertiary: '#868686',
  hairline: 'rgba(255,255,255,0.10)',
  controlBg: 'rgba(255,255,255,0.06)',
  controlBorder: 'rgba(255,255,255,0.12)',
  chromeFill: '#F5F5F5',
  chromeFillText: '#070707',
  brandRed: '#E23B3F'
}

// Porcelain (styles.css :root): base oklch(0.985 0 0), ink text (0.17), the
// secondary (0.47) and tertiary (0.54) tiers as neutral greys.
export const LIGHT_WINDOW_PALETTE: WindowPalette = {
  base: '#FAFAFA',
  panel: '#FFFFFF',
  textPrimary: '#0F0F0F',
  textSecondary: '#5B5B5B',
  textTertiary: '#6F6F6F',
  hairline: 'rgba(0,0,0,0.08)',
  controlBg: 'rgba(0,0,0,0.04)',
  controlBorder: 'rgba(0,0,0,0.10)',
  chromeFill: '#0F0F0F',
  chromeFillText: '#FAFAFA',
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
 * How much of the base tone each window region paints over the chrome ground
 * (plan 208, D10; plan 091 D3 for the derivation): styles.css
 * `--glass-cover-sidebar` / `--glass-cover-work` per theme, the same on every
 * platform now that the ground is Videorc's own. The floor under each cover
 * is what chrome-ground-contrast.test.ts computes from the ground's real
 * pixels (about 0.78 dark and 0.83 light for secondary text at 4.5:1).
 * window-palette.test.ts fails when styles.css drifts.
 */
export interface GlassCovers {
  sidebar: number
  work: number
}

export const GLASS_COVERS = Object.freeze({
  dark: { sidebar: 0.88, work: 0.82 },
  light: { sidebar: 0.92, work: 0.86 }
} as const satisfies Record<'dark' | 'light', GlassCovers>)

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

/**
 * styles.css `.dark` `--glass-base`: the dark tone every dark coat is cut
 * from, the OKLCH of DARK_WINDOW_PALETTE.base (#070707, the chrome's own
 * black; plan 208).
 */
export const DARK_GLASS_BASE = '0.13 0 0'

function alphaPercent(alpha: number): string {
  return `${Math.round(alpha * 10_000) / 100}%`
}

/**
 * The dark glass coats for main-side documents that cannot read the
 * stylesheet: the Preview frame paints both over its solid dark base (the
 * clear material under VIDEORC_GLASS=clear), dark because it frames video
 * (plan 050; plan 091 S2; plan 208 D7). Derived from the dark covers like
 * styles.css derives its own: the body paints the work cover (82%) and the
 * content coat is the work delta, 0%, so the frame composites to exactly
 * what the main window's work area does. window-palette.test.ts fails when
 * these drift from styles.css.
 */
export const DARK_GLASS_COATS = Object.freeze(
  (() => {
    const coats = deriveGlassCoats(GLASS_COVERS.dark)
    return {
      window: `oklch(${DARK_GLASS_BASE} / ${alphaPercent(coats.body)})`,
      content: `oklch(${DARK_GLASS_BASE} / ${alphaPercent(coats.content)})`
    }
  })()
)
