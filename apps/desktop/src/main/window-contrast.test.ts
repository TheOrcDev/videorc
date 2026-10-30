import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Text contrast over the window's solid (plan 208 S2, kept when the chrome
// ground under the coats was removed on 2026-10-29). Every region of a window
// composites to the theme's solid, so the three text tiers must keep WCAG
// AA/AAA ratios over it, also at Increase Contrast. The tokens are parsed from
// styles.css, so an edit there cannot bypass this test.

const styles = readFileSync(join(__dirname, '../renderer/src/styles.css'), 'utf8')

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

interface Theme {
  name: 'dark' | 'light'
  /** The solid's linear luminance. */
  solid: number
  tiers: Tiers
}

function theme(name: 'dark' | 'light'): Theme {
  const text = block(name === 'dark' ? '.dark' : ':root')
  return {
    name,
    solid: oklchGreyToLinear(greyLightness(token(text, 'glass-solid'))),
    tiers: tiersOf(text)
  }
}

const THEMES = [theme('dark'), theme('light')]

function expectReadable(tiers: Tiers, luminance: number, label: string): void {
  const ratios = ratiosOver(tiers, luminance)
  for (const tier of Object.keys(THRESHOLDS) as (keyof Tiers)[]) {
    expect(ratios[tier], `${label}: ${tier} ${ratios[tier].toFixed(2)}:1`).toBeGreaterThanOrEqual(
      THRESHOLDS[tier]
    )
  }
}

describe("the window's solid keeps the text tiers readable", () => {
  it.each(THEMES)('$name: every text tier passes over the solid', ({ name, solid, tiers }) => {
    expectReadable(tiers, solid, `${name} solid`)
  })

  it('the Increase Contrast tiers pass over the solid too', () => {
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
      expectReadable(tiers, base.solid, `${name} Increase Contrast`)
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
// hover a lift, over the theme's solid (the utilities' bottom layer). Plate and lift composited over the solid must
// keep every text tier readable, in both themes and at Increase Contrast.
describe('the chrome rows keep the text tiers readable (plan 0011)', () => {
  const over = (gamma: number, layer: string): number => {
    const { gamma: top, alpha } = neutralWithAlpha(layer)
    return alpha * top + (1 - alpha) * gamma
  }

  it.each(THEMES)('$name: on-stream and member plates, at rest and on hover', (current) => {
    const text = block(current.name === 'dark' ? '.dark' : ':root')
    const solid = linearToGamma(current.solid)
    for (const plate of ['chrome-row-live-top', 'chrome-row-member-top']) {
      const rest = over(solid, token(text, plate))
      const hover = over(rest, token(text, 'chrome-row-lift'))
      for (const [state, gamma] of [
        ['rest', rest],
        ['hover', hover]
      ] as const) {
        expectReadable(current.tiers, gammaToLinear(gamma), `${plate} (${state})`)
      }
    }
  })
})
