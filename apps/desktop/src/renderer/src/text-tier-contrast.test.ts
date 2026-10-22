import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// Plan 174 S1.8 (D12, J1-4): the tertiary text tier reads at AA on the
// window's solid tone in both themes, and in the Increase Contrast block,
// while staying a step below the secondary tier. Computed from styles.css,
// so a retune that breaks the bar fails here before it reaches a screen.

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

type Oklch = [number, number, number]

function tokenValues(name: string): Oklch[] {
  const pattern = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`, 'g')
  return [...styles.matchAll(pattern)].map((match) => [+match[1], +match[2], +match[3]])
}

/** OKLCH to relative luminance (sRGB, D65), per the WCAG 2 definition. */
function luminance([lightness, chroma, hue]: Oklch): number {
  const a = chroma * Math.cos((hue * Math.PI) / 180)
  const b = chroma * Math.sin((hue * Math.PI) / 180)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (value: number): number => Math.min(1, Math.max(0, value))
  const red = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
  const green = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
  const blue = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(text: Oklch, ground: Oklch): number {
  const [high, low] = [luminance(text), luminance(ground)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

describe('text tiers on the solid (plan 174 S1.8, D12)', () => {
  // In styles.css order: light, dark, then the Increase Contrast pair.
  const subtle = tokenValues('subtle')
  const muted = tokenValues('muted-foreground')
  const [lightSolid, darkSolid] = tokenValues('glass-solid')

  it('finds both themes and the Increase Contrast block', () => {
    expect(subtle).toHaveLength(4)
    expect(muted).toHaveLength(4)
    expect(lightSolid).toBeDefined()
    expect(darkSolid).toBeDefined()
  })

  it('puts the tertiary tier at 4.5:1 or more on the solid, both themes', () => {
    const [light, dark, lightMore, darkMore] = subtle
    expect(contrast(light, lightSolid)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(dark, darkSolid)).toBeGreaterThanOrEqual(4.5)
    // Increase Contrast raises it further: 6:1 or more.
    expect(contrast(lightMore, lightSolid)).toBeGreaterThanOrEqual(6)
    expect(contrast(darkMore, darkSolid)).toBeGreaterThanOrEqual(6)
  })

  it('keeps three tiers: the tertiary stays a step below the secondary', () => {
    for (const [index, ground] of [lightSolid, darkSolid, lightSolid, darkSolid].entries()) {
      expect(contrast(muted[index], ground)).toBeGreaterThan(contrast(subtle[index], ground) + 0.5)
    }
  })
})
