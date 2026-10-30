import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Plan 208 S2: contrast over the chrome ground is a test, not a probe. For
// each theme and window region the coat is composited over the ground's
// extreme pixels (assets/backgrounds/chrome-ground.stats.json, measured from
// the shipping WebPs by the S1 generator; a Rust test keeps the stats
// honest) the way Chromium blends: coat over ground in gamma-encoded sRGB.
// The three text tiers must keep WCAG AA/AAA ratios over the worst pixel, and
// every cover must sit above the floor the worst pixel derives. A token,
// cover or asset change that breaks a ratio fails here. The tokens are
// parsed from styles.css, so an edit there cannot bypass this test.

const styles = readFileSync(join(__dirname, '../renderer/src/styles.css'), 'utf8')

interface GreyStats {
  min: number
  max: number
  mean: number
}
interface GroundStats {
  width: number
  height: number
  sigma: number
  grey: string
  dark: GreyStats
  light: GreyStats
}
const stats: GroundStats = JSON.parse(
  readFileSync(join(__dirname, '../../../../assets/backgrounds/chrome-ground.stats.json'), 'utf8')
)

function block(selector: string): string {
  const start = styles.indexOf(`\n${selector} {`)
  if (start < 0) throw new Error(`styles.css has no ${selector} block`)
  return styles.slice(start, styles.indexOf('\n}', start))
}

function token(blockText: string, name: string): string {
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(blockText)?.[1]?.trim()
  if (!value) throw new Error(`no --${name} in block`)
  return value
}

/** The lightness of a neutral `oklch(L 0 0)` token or `L 0 0` components. */
function greyLightness(value: string): number {
  const match = /^(?:oklch\()?([\d.]+) 0 0\)?$/.exec(value)
  if (!match) throw new Error(`not a neutral oklch grey: ${value}`)
  return Number(match[1])
}

/** Neutral OKLCH lightness → linear luminance: the OKLab matrices collapse to L³ for greys. */
const oklchGreyToLinear = (lightness: number): number => lightness ** 3

const linearToGamma = (linear: number): number =>
  linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055

const gammaToLinear = (gamma: number): number =>
  gamma <= 0.04045 ? gamma / 12.92 : ((gamma + 0.055) / 1.055) ** 2.4

/** WCAG contrast between two relative luminances. */
function contrastRatio(a: number, b: number): number {
  const [high, low] = a > b ? [a, b] : [b, a]
  return (high + 0.05) / (low + 0.05)
}

/** The coat over a ground pixel, blended in gamma sRGB like Chromium, as linear luminance. */
function compositeLuminance(baseLightness: number, cover: number, groundGrey: number): number {
  const baseGamma = linearToGamma(oklchGreyToLinear(baseLightness))
  return gammaToLinear(cover * baseGamma + (1 - cover) * groundGrey)
}

interface Tiers {
  foreground: number
  mutedForeground: number
  subtle: number
}

const THRESHOLDS: Record<keyof Tiers, number> = {
  foreground: 7,
  mutedForeground: 4.5,
  subtle: 3
}

function tiersOf(blockText: string): Tiers {
  return {
    foreground: oklchGreyToLinear(greyLightness(token(blockText, 'foreground'))),
    mutedForeground: oklchGreyToLinear(greyLightness(token(blockText, 'muted-foreground'))),
    subtle: oklchGreyToLinear(greyLightness(token(blockText, 'subtle')))
  }
}

function ratiosOver(tiers: Tiers, luminance: number): Record<keyof Tiers, number> {
  return {
    foreground: contrastRatio(tiers.foreground, luminance),
    mutedForeground: contrastRatio(tiers.mutedForeground, luminance),
    subtle: contrastRatio(tiers.subtle, luminance)
  }
}

/** The smallest cover (to 0.0005) at which every tier passes over this pixel. */
function coverFloor(baseLightness: number, tiers: Tiers, groundGrey: number): number {
  for (let cover = 0; cover <= 1; cover += 0.0005) {
    const ratios = ratiosOver(tiers, compositeLuminance(baseLightness, cover, groundGrey))
    if (
      ratios.foreground >= THRESHOLDS.foreground &&
      ratios.mutedForeground >= THRESHOLDS.mutedForeground &&
      ratios.subtle >= THRESHOLDS.subtle
    ) {
      return Number(cover.toFixed(4))
    }
  }
  return 1
}

interface Theme {
  name: 'dark' | 'light'
  base: number
  tiers: Tiers
  covers: { sidebar: number; work: number }
  /** The ground's extreme pixels, sRGB grey 0–1. */
  extremes: number[]
}

function theme(name: 'dark' | 'light'): Theme {
  const text = block(name === 'dark' ? '.dark' : ':root')
  return {
    name,
    base: greyLightness(token(text, 'glass-base')),
    tiers: tiersOf(text),
    covers: {
      sidebar: Number(token(text, 'glass-cover-sidebar')),
      work: Number(token(text, 'glass-cover-work'))
    },
    extremes: [stats[name].min, stats[name].max]
  }
}

const THEMES = [theme('dark'), theme('light')]

describe('the chrome ground keeps the text tiers readable (plan 208, S2)', () => {
  it('reads the S1 stats: gamma-encoded sRGB grey of the shipping pixels', () => {
    expect(stats.width).toBe(1280)
    expect(stats.height).toBe(720)
    expect(stats.grey).toMatch(/gamma-encoded sRGB/)
    for (const name of ['dark', 'light'] as const) {
      expect(stats[name].min).toBeGreaterThanOrEqual(0)
      expect(stats[name].min).toBeLessThan(stats[name].mean)
      expect(stats[name].mean).toBeLessThan(stats[name].max)
      expect(stats[name].max).toBeLessThanOrEqual(1)
    }
  })

  it.each(THEMES)(
    '$name: every text tier passes over both extreme pixels in the sidebar and the work area',
    ({ base, tiers, covers, extremes }) => {
      for (const [region, cover] of Object.entries(covers)) {
        for (const grey of extremes) {
          const ratios = ratiosOver(tiers, compositeLuminance(base, cover, grey))
          for (const tier of Object.keys(THRESHOLDS) as (keyof Tiers)[]) {
            expect(
              ratios[tier],
              `${region} cover ${cover} over ground ${grey.toFixed(3)}: ${tier} ${ratios[tier].toFixed(2)}:1`
            ).toBeGreaterThanOrEqual(THRESHOLDS[tier])
          }
        }
      }
    }
  )

  it.each(THEMES)('$name: every cover sits above the floor its worst pixel derives', (current) => {
    const floor = Math.max(
      ...current.extremes.map((grey) => coverFloor(current.base, current.tiers, grey))
    )
    expect(current.covers.work, `${current.name} work floor ${floor}`).toBeGreaterThanOrEqual(floor)
    expect(current.covers.sidebar, `${current.name} sidebar floor ${floor}`).toBeGreaterThanOrEqual(
      floor
    )
    // The sidebar is the heavier region: it never shows more chrome than the work area.
    expect(current.covers.sidebar).toBeGreaterThanOrEqual(current.covers.work)
  })

  it('derives the floors the plan recorded: about 0.78 dark and 0.83 light (D10)', () => {
    const [dark, light] = THEMES
    const darkFloor = Math.max(
      ...dark.extremes.map((grey) => coverFloor(dark.base, dark.tiers, grey))
    )
    const lightFloor = Math.max(
      ...light.extremes.map((grey) => coverFloor(light.base, light.tiers, grey))
    )
    // Pinned to the measured ground: a new asset or σ moves these, and the
    // covers above must then be re-checked by eye (plan 208 D10, STOP at 0.95).
    expect(darkFloor).toBeCloseTo(0.7825, 2)
    expect(lightFloor).toBeCloseTo(0.825, 2)
    expect(darkFloor).toBeLessThan(0.95)
    expect(lightFloor).toBeLessThan(0.95)
  })

  it('the Increase Contrast tiers pass at the 95% covers too (D12)', () => {
    const contrast = styles.slice(styles.indexOf('@media (prefers-contrast: more)'))
    const end = contrast.indexOf('\n}\n')
    const text = contrast.slice(0, end)
    const light = text.slice(0, text.indexOf('.dark {'))
    const dark = text.slice(text.indexOf('.dark {'))
    for (const [name, blockText] of [
      ['light', light],
      ['dark', dark]
    ] as const) {
      const base = THEMES.find((entry) => entry.name === name)!
      const tiers: Tiers = {
        foreground: base.tiers.foreground,
        mutedForeground: oklchGreyToLinear(greyLightness(token(blockText, 'muted-foreground'))),
        subtle: oklchGreyToLinear(greyLightness(token(blockText, 'subtle')))
      }
      expect(Number(token(blockText, 'glass-cover-sidebar'))).toBe(0.95)
      expect(Number(token(blockText, 'glass-cover-work'))).toBe(0.95)
      for (const grey of base.extremes) {
        const ratios = ratiosOver(tiers, compositeLuminance(base.base, 0.95, grey))
        expect(ratios.foreground).toBeGreaterThanOrEqual(THRESHOLDS.foreground)
        expect(ratios.mutedForeground).toBeGreaterThanOrEqual(THRESHOLDS.mutedForeground)
        expect(ratios.subtle).toBeGreaterThanOrEqual(THRESHOLDS.subtle)
      }
    }
  })
})

/** A neutral `oklch(L 0 0 / A%)` token as gamma grey and alpha. */
function neutralWithAlpha(value: string): { gamma: number; alpha: number } {
  const match = /^oklch\(([\d.]+) 0 0 \/ ([\d.]+)%\)$/.exec(value)
  if (!match) throw new Error(`not a translucent neutral oklch: ${value}`)
  return {
    gamma: linearToGamma(oklchGreyToLinear(Number(match[1]))),
    alpha: Number(match[2]) / 100
  }
}

// Plan 0011: the Stream Manager's chrome rows lay a translucent plate, and on
// hover a lift, over the theme's solid (the utilities' bottom layer, so the
// ground never shows through). Plate and lift composited over the solid must
// keep every text tier readable, in both themes and at Increase Contrast.
describe('the chrome rows keep the text tiers readable (plan 0011)', () => {
  const over = (gamma: number, layer: string): number => {
    const { gamma: top, alpha } = neutralWithAlpha(layer)
    return alpha * top + (1 - alpha) * gamma
  }

  it.each(THEMES)('$name: on-stream and member plates, at rest and on hover', (current) => {
    const text = block(current.name === 'dark' ? '.dark' : ':root')
    const solid = linearToGamma(oklchGreyToLinear(greyLightness(token(text, 'glass-solid'))))
    expect(greyLightness(token(text, 'glass-solid'))).toBe(current.base)
    for (const plate of ['chrome-row-live-top', 'chrome-row-member-top']) {
      const rest = over(solid, token(text, plate))
      const hover = over(rest, token(text, 'chrome-row-lift'))
      for (const [state, gamma] of [
        ['rest', rest],
        ['hover', hover]
      ] as const) {
        const ratios = ratiosOver(current.tiers, gammaToLinear(gamma))
        for (const tier of Object.keys(THRESHOLDS) as (keyof Tiers)[]) {
          expect(
            ratios[tier],
            `${plate} (${state}): ${tier} ${ratios[tier].toFixed(2)}:1`
          ).toBeGreaterThanOrEqual(THRESHOLDS[tier])
        }
      }
    }
  })
})
