import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  BUDDY_PET_MANIFEST_RULES,
  BuddyPetError,
  measureBuddyPetHeadTop,
  parseBuddyPetManifest,
  validateBuddyPetImages,
  validateBuddyPetManifest,
  validateBuddyPetSheetSizes,
  type BuddyPetSheetPixels,
  type BuddyPetSheetSize
} from './buddy-pet'

interface FixtureCase {
  name: string
  rule?: string
  manifest: unknown
  sheets?: Record<string, [number, number]>
  expect?: { frames: number; gaze: number; neutral: string }
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/buddy-pet-manifests.json', import.meta.url),
    'utf8'
  )
) as { rules: string[]; valid: FixtureCase[]; invalid: FixtureCase[] }

function sizes(sheets: FixtureCase['sheets']): Map<string, BuddyPetSheetSize> | null {
  if (!sheets) return null
  return new Map(Object.entries(sheets).map(([name, [width, height]]) => [name, { width, height }]))
}

function ruleOf(run: () => void): string | null {
  try {
    run()
    return null
  } catch (error) {
    if (!(error instanceof BuddyPetError)) throw error
    expect(error.message.length).toBeGreaterThan(0)
    return error.rule
  }
}

/** A transparent RGBA sheet with an opaque body and head drawn in each cell. */
function syntheticSheet(
  width: number,
  height: number,
  cells: [number, number, number, number][]
): BuddyPetSheetPixels {
  const data = new Uint8ClampedArray(width * height * 4)
  const fill = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let row = y0; row < y1; row++) {
      for (let col = x0; col < x1; col++) {
        const offset = (row * width + col) * 4
        data.set([90, 140, 200, 255], offset)
      }
    }
  }
  for (const [x, y, w, h] of cells) {
    fill(
      x + Math.floor(w / 4),
      y + Math.floor((h * 2) / 5),
      x + Math.floor((w * 3) / 4),
      y + Math.floor((h * 9) / 10)
    )
    fill(
      x + Math.floor((w * 3) / 8),
      y + Math.floor(h / 5),
      x + Math.floor((w * 5) / 8),
      y + Math.floor((h * 2) / 5)
    )
  }
  return { width, height, data }
}

describe('buddy-pet shared manifest fixture', () => {
  it('lists the same rules as the TypeScript validator', () => {
    expect(fixture.rules).toStrictEqual([...BUDDY_PET_MANIFEST_RULES])
  })

  it.each(fixture.valid.map((entry) => [entry.name, entry] as const))(
    'accepts %s',
    (_name, entry) => {
      const manifest = validateBuddyPetManifest(entry.manifest)
      const sheetSizes = sizes(entry.sheets)
      if (sheetSizes) validateBuddyPetSheetSizes(manifest, sheetSizes)
      if (entry.expect) {
        expect(manifest.frames).toHaveLength(entry.expect.frames)
        expect(manifest.frames.filter((frame) => frame.kind === 'gaze')).toHaveLength(
          entry.expect.gaze
        )
        expect(manifest.neutral).toBe(entry.expect.neutral)
      }
    }
  )

  it.each(fixture.invalid.map((entry) => [entry.name, entry] as const))(
    'refuses %s with its rule',
    (_name, entry) => {
      const rule = ruleOf(() => {
        const manifest = validateBuddyPetManifest(entry.manifest)
        const sheetSizes = sizes(entry.sheets)
        if (!sheetSizes) throw new Error('passed the manifest rules without sheets')
        validateBuddyPetSheetSizes(manifest, sheetSizes)
      })
      expect(rule).toBe(entry.rule)
    }
  )

  it('has a failing case for every manifest rule', () => {
    const covered = new Set(fixture.invalid.map((entry) => entry.rule))
    for (const rule of BUDDY_PET_MANIFEST_RULES) expect(covered).toContain(rule)
  })
})

describe('buddy-pet manifest details', () => {
  it('names invalid JSON', () => {
    expect(ruleOf(() => parseBuddyPetManifest('{ not json'))).toBe('manifest-json')
  })

  it('keeps only the fields the runtime uses', () => {
    const manifest = validateBuddyPetManifest({
      version: 1,
      name: 'Pip',
      neutral: 'center',
      thumb: 'thumb.webp',
      frames: [
        { id: 'center', kind: 'gaze', gaze: [0, 0], sheet: 'a.png', rect: [0, 0, 128, 128] },
        { id: 'wave', kind: 'reaction', gaze: [1, 1], sheet: 'a.png', rect: [128, 0, 128, 128] }
      ]
    })
    expect(manifest).toStrictEqual({
      version: 1,
      name: 'Pip',
      neutral: 'center',
      frames: [
        { id: 'center', kind: 'gaze', gaze: [0, 0], sheet: 'a.png', rect: [0, 0, 128, 128] },
        { id: 'wave', kind: 'reaction', sheet: 'a.png', rect: [128, 0, 128, 128] }
      ]
    })
  })
})

describe('buddy-pet images', () => {
  const manifest = validateBuddyPetManifest({
    version: 1,
    name: 'Synthetic',
    neutral: 'center',
    frames: [
      { id: 'center', kind: 'gaze', gaze: [0, 0], sheet: 'a.png', rect: [0, 0, 128, 128] },
      { id: 'laugh', kind: 'reaction', sheet: 'a.png', rect: [128, 0, 128, 128] }
    ]
  })

  it('accepts characters on transparency and measures the head top', () => {
    const sheet = syntheticSheet(256, 128, [
      [0, 0, 128, 128],
      [128, 0, 128, 128]
    ])
    const sheets = new Map([['a.png', sheet]])
    validateBuddyPetImages(manifest, sheets)
    // The same number the Rust test measures on the same drawing.
    expect(measureBuddyPetHeadTop(manifest, sheets)).toBe(0.1953)
  })

  it('refuses an opaque background and an empty cell', () => {
    const opaque = syntheticSheet(256, 128, [
      [0, 0, 128, 128],
      [128, 0, 128, 128]
    ])
    for (let row = 0; row < 128; row++) {
      for (let col = 128; col < 256; col++) opaque.data[(row * 256 + col) * 4 + 3] = 255
    }
    expect(ruleOf(() => validateBuddyPetImages(manifest, new Map([['a.png', opaque]])))).toBe(
      'cell-transparency'
    )
    const empty = syntheticSheet(256, 128, [[128, 0, 128, 128]])
    const sheets = new Map([['a.png', empty]])
    expect(ruleOf(() => validateBuddyPetImages(manifest, sheets))).toBe('cell-transparency')
    expect(measureBuddyPetHeadTop(manifest, sheets)).toBeNull()
  })

  it('refuses a sheet smaller than its rects', () => {
    const small = syntheticSheet(200, 128, [[0, 0, 128, 128]])
    expect(ruleOf(() => validateBuddyPetImages(manifest, new Map([['a.png', small]])))).toBe(
      'frame-outside-sheet'
    )
  })
})
