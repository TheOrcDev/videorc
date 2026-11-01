import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// Record's material (Button's `record`, RecordButton; plan 005 in videorc-ui,
// D8): metallic red with no border or ring, whose glow alone breathes while a
// session runs. Computed from styles.css, so a retune that breaks the label's
// contrast or makes the metal move fails here before it reaches a screen.

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

const light = /:root \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
const dark = /\n\.dark \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
const utility = /@utility chrome-led \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
const keyframes = /@keyframes chrome-led-breathe \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''

const METAL_TOKENS = [
  '--chrome-led-off-stops',
  '--chrome-led-off-flat',
  '--chrome-led-stops',
  '--chrome-led-flat'
]

type Oklch = [number, number, number]

function token(column: string, name: string): string | undefined {
  return new RegExp(`${name}:([^;]*);`).exec(column)?.[1]
}

function colours(value: string): Oklch[] {
  return [...value.matchAll(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g)].map((match) => [
    +match[1],
    +match[2],
    +match[3]
  ])
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

describe('chrome-led: Record in metallic red', () => {
  it('gives both themes the idle and lit metal and the glow', () => {
    for (const [theme, column] of Object.entries({ light, dark })) {
      for (const name of METAL_TOKENS) {
        expect(token(column, name), `${theme} ${name}`).toBeDefined()
      }
      expect(token(column, '--chrome-led-glow')?.trim(), theme).toMatch(
        /^color-mix\(in oklch, var\(--live\) \d+%, transparent\)$/
      )
    }
  })

  it('keeps the white label at 4.5:1 on every stop of the metal, idle and lit', () => {
    for (const [theme, column] of Object.entries({ light, dark })) {
      const [label] = colours(token(column, '--live-foreground') ?? '')
      expect(label, `${theme} --live-foreground`).toBeDefined()
      for (const name of METAL_TOKENS) {
        const stops = colours(token(column, name) ?? '')
        expect(stops.length, `${theme} ${name}`).toBeGreaterThan(0)
        for (const stop of stops) {
          expect(contrast(label, stop), `${theme} ${name}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('is defined once, with no border or ring, and keeps Tailwind ring stack', () => {
    expect(styles.match(/@utility chrome-led \{/g)).toHaveLength(1)
    expect(utility).toContain('var(--tw-ring-shadow)')
    expect(utility).not.toMatch(/backdrop-filter|--chrome-chromatic/)
    const borders = [...utility.matchAll(/(border[\w-]*):/g)].map(([, property]) => property)
    expect(borders.every((property) => property === 'border-radius')).toBe(true)
  })

  it('breathes the glow alone, on opacity alone, and only while lit', () => {
    expect(utility).toMatch(/&\[data-lit\] \{\s*--chrome-led-metal: var\(--chrome-led-stops\);/)
    expect(utility).toMatch(
      /&\[data-lit\]:not\([^)]*\)::after \{[^}]*animation: chrome-led-breathe [^}]*\}/
    )
    // Every transition and animation sits on the ::after glow.
    const withoutGlow = utility.replace(/[^{};]*::after \{[^{}]*\}/g, '')
    expect(withoutGlow).not.toMatch(/animation|transition/)
    const properties = [...keyframes.matchAll(/([\w-]+):\s*[^;{}]+;/g)].map(
      ([, property]) => property
    )
    expect(properties.length).toBeGreaterThan(0)
    expect(properties.every((property) => property === 'opacity')).toBe(true)
  })
})
