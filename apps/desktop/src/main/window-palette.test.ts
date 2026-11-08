import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  compositeCover,
  DARK_GLASS_BASE,
  DARK_GLASS_COATS,
  DARK_WINDOW_PALETTE,
  deriveGlassCoats,
  DOCKED_PREVIEW_CORNER_RADIUS,
  GLASS_COVERS,
  LIGHT_WINDOW_PALETTE
} from './window-palette'

// styles.css is the source of truth; main-side documents mirror it here.
const styles = readFileSync(join(__dirname, '../renderer/src/styles.css'), 'utf8')

/** The first `selector {` block after `from`, without its nested braces. */
function block(selector: string, from = 0): string {
  const start = styles.indexOf(`\n${selector} {`, from)
  if (start < 0) throw new Error(`styles.css has no ${selector} block`)
  return styles.slice(start, styles.indexOf('\n}', start))
}

function token(blockText: string, name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(blockText)?.[1]?.trim()
}

function covers(blockText: string): { sidebar: number; work: number } {
  return {
    sidebar: Number(token(blockText, 'glass-cover-sidebar')),
    work: Number(token(blockText, 'glass-cover-work'))
  }
}

/** The lightness of a neutral `oklch(L 0 0)` token; throws on any chroma. */
function greyLightness(value: string | undefined, name: string): number {
  const match = /^oklch\(([\d.]+) 0 0(?: \/ [^)]+)?\)$/.exec(value ?? '')
  if (!match) throw new Error(`${name} is not a neutral oklch grey: ${value}`)
  return Number(match[1])
}

/** A neutral OKLCH lightness as the `#RRGGBB` Chromium paints (sRGB, gamma-encoded). */
function greyHex(lightness: number): string {
  // For a neutral the OKLab→LMS→linear-sRGB matrices collapse to Y = L³.
  const linear = lightness ** 3
  const gamma = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055
  const channel = Math.round(gamma * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
  return `#${channel}${channel}${channel}`
}

describe('window palette mirrors styles.css', () => {
  it('keeps the glass covers in step with the stylesheet, one set for every platform (plan 208, D10)', () => {
    expect(covers(block(':root'))).toEqual(GLASS_COVERS.light)
    expect(covers(block('.dark'))).toEqual(GLASS_COVERS.dark)
    expect(GLASS_COVERS).toEqual({
      dark: { sidebar: 0.88, work: 0.82 },
      light: { sidebar: 0.92, work: 0.86 }
    })
    // The Windows Mica covers went with Mica: no platform rule sets a cover.
    expect(styles).not.toMatch(/^\s*:root\[data-platform='win32'\]/m)
    // One base per theme, and the solid is that base: the chrome's own black
    // (oklch 0.13, #070707) and the porcelain (0.985, #FAFAFA), chroma 0.
    expect(token(block(':root'), 'glass-base')).toBe('0.985 0 0')
    expect(token(block('.dark'), 'glass-base')).toBe('0.13 0 0')
    expect(token(block(':root'), 'glass-solid')).toBe('oklch(0.985 0 0)')
    expect(token(block('.dark'), 'glass-solid')).toBe('oklch(0.13 0 0)')
  })

  it('is truly neutral: the hue-286 cast is gone from every token (plan 208)', () => {
    expect(styles).not.toMatch(/\b286\b/)
    for (const name of ['foreground', 'muted-foreground', 'subtle', 'primary', 'video-ground']) {
      greyLightness(token(block(':root'), name), `:root --${name}`)
      greyLightness(token(block('.dark'), name), `.dark --${name}`)
    }
  })

  it('mirrors the solids and the text tiers as the hex Chromium paints', () => {
    const light = block(':root')
    const dark = block('.dark')
    expect(LIGHT_WINDOW_PALETTE.base).toBe(greyHex(0.985))
    expect(DARK_WINDOW_PALETTE.base).toBe(greyHex(0.13))
    expect(LIGHT_WINDOW_PALETTE.textPrimary).toBe(
      greyHex(greyLightness(token(light, 'foreground'), '--foreground'))
    )
    expect(LIGHT_WINDOW_PALETTE.textSecondary).toBe(
      greyHex(greyLightness(token(light, 'muted-foreground'), '--muted-foreground'))
    )
    expect(LIGHT_WINDOW_PALETTE.textTertiary).toBe(
      greyHex(greyLightness(token(light, 'subtle'), '--subtle'))
    )
    expect(DARK_WINDOW_PALETTE.textPrimary).toBe(
      greyHex(greyLightness(token(dark, 'foreground'), '--foreground'))
    )
    expect(DARK_WINDOW_PALETTE.textSecondary).toBe(
      greyHex(greyLightness(token(dark, 'muted-foreground'), '--muted-foreground'))
    )
    expect(DARK_WINDOW_PALETTE.textTertiary).toBe(
      greyHex(greyLightness(token(dark, 'subtle'), '--subtle'))
    )
    expect(DARK_WINDOW_PALETTE.chromeFill).toBe(DARK_WINDOW_PALETTE.textPrimary)
    expect(DARK_WINDOW_PALETTE.chromeFillText).toBe(DARK_WINDOW_PALETTE.base)
    expect(LIGHT_WINDOW_PALETTE.chromeFill).toBe(LIGHT_WINDOW_PALETTE.textPrimary)
    expect(LIGHT_WINDOW_PALETTE.chromeFillText).toBe(LIGHT_WINDOW_PALETTE.base)
  })

  it('derives the coats so every region composites to exactly its cover', () => {
    const dark = deriveGlassCoats(GLASS_COVERS.dark)
    expect(dark.body).toBe(0.82)
    expect(dark.content).toBe(0)
    expect(dark.sidebar).toBeCloseTo(1 / 3, 10)
    expect(compositeCover(dark.body, dark.sidebar)).toBeCloseTo(0.88, 10)
    const light = deriveGlassCoats(GLASS_COVERS.light)
    expect(light.body).toBe(0.86)
    expect(light.content).toBe(0)
    expect(light.sidebar).toBeCloseTo(3 / 7, 10)
    expect(compositeCover(light.body, light.sidebar)).toBeCloseTo(0.92, 10)
  })

  it('paints the Preview frame with the dark work cover and a 0% content coat (plan 091 S2)', () => {
    expect(token(block('.dark'), 'glass-base')).toBe(DARK_GLASS_BASE)
    expect(DARK_GLASS_COATS).toEqual({
      window: 'oklch(0.13 0 0 / 82%)',
      content: 'oklch(0.13 0 0 / 0%)'
    })
    const coats = deriveGlassCoats(covers(block('.dark')))
    expect(DARK_GLASS_COATS.window).toBe(`oklch(${DARK_GLASS_BASE} / ${coats.body * 100}%)`)
    expect(DARK_GLASS_COATS.content).toBe(`oklch(${DARK_GLASS_BASE} / ${coats.content * 100}%)`)
  })

  it('reads the Increase Contrast covers at 95% and the reduced-transparency solid', () => {
    const contrast = styles.slice(styles.indexOf('@media (prefers-contrast: more)'))
    expect(contrast.match(/--glass-cover-(?:sidebar|work):\s*0\.95;/g)).toHaveLength(4)
    const reduced = styles.slice(styles.indexOf('@media (prefers-reduced-transparency: reduce)'))
    expect(reduced).toMatch(/--glass-window:\s*var\(--glass-solid\);/)
    expect(reduced).toMatch(/--glass-sidebar:\s*transparent;/)
    expect(reduced).toMatch(/--glass-content:\s*transparent;/)
  })

  it('clips the docked preview to the panel radius the Studio slot draws', () => {
    const radius = Number(/--radius:\s*([\d.]+)rem;/.exec(styles)?.[1]) * 16
    const panelOffset = Number(
      /--radius-panel:\s*calc\(var\(--radius\)\s*\+\s*(\d+)px\)/.exec(styles)?.[1]
    )
    expect(radius + panelOffset).toBe(DOCKED_PREVIEW_CORNER_RADIUS)
  })
})
