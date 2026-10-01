import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  compositeCover,
  deriveGlassCoats,
  DOCKED_PREVIEW_CORNER_RADIUS,
  GLASS_COVERS
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

describe('window palette mirrors styles.css', () => {
  it('keeps the glass covers in step with the stylesheet (plan 091, D3 and D5)', () => {
    expect(covers(block(':root'))).toEqual(GLASS_COVERS.darwin.light)
    expect(covers(block('.dark'))).toEqual(GLASS_COVERS.darwin.dark)
    expect(covers(block(":root[data-platform='win32']"))).toEqual(GLASS_COVERS.win32.light)
    expect(covers(block(":root[data-platform='win32'].dark"))).toEqual(GLASS_COVERS.win32.dark)
    // One base per theme, and the solid is that base.
    expect(token(block(':root'), 'glass-base')).toBe('0.985 0.001 286')
    expect(token(block('.dark'), 'glass-base')).toBe('0.13 0.003 286')
    expect(token(block(':root'), 'glass-solid')).toBe('oklch(0.985 0.001 286)')
    expect(token(block('.dark'), 'glass-solid')).toBe('oklch(0.13 0.003 286)')
  })

  it('derives the coats so every region composites to exactly its cover', () => {
    const dark = deriveGlassCoats(GLASS_COVERS.darwin.dark)
    expect(dark.body).toBe(0.83)
    expect(dark.content).toBe(0)
    expect(dark.sidebar).toBeCloseTo(0.2941, 4)
    expect(compositeCover(dark.body, dark.sidebar)).toBeCloseTo(0.88, 10)
    const light = deriveGlassCoats(GLASS_COVERS.darwin.light)
    expect(light.body).toBe(0.86)
    expect(light.content).toBe(0)
    expect(light.sidebar).toBeCloseTo(0.5, 10)
    expect(compositeCover(light.body, light.sidebar)).toBeCloseTo(0.93, 10)
  })

  it('reproduces the plan 050 Mica composite on Windows: 34% + 26% dark, 50% + 24% light', () => {
    const dark = deriveGlassCoats(GLASS_COVERS.win32.dark)
    expect(dark.body).toBe(0.34)
    expect(dark.sidebar).toBe(0)
    expect(dark.content).toBeCloseTo(0.26, 10)
    expect(compositeCover(0.34, 0.26)).toBeCloseTo(GLASS_COVERS.win32.dark.work, 10)
    const light = deriveGlassCoats(GLASS_COVERS.win32.light)
    expect(light.body).toBe(0.5)
    expect(light.sidebar).toBe(0)
    expect(light.content).toBeCloseTo(0.24, 10)
    expect(compositeCover(0.5, 0.24)).toBeCloseTo(GLASS_COVERS.win32.light.work, 10)
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
