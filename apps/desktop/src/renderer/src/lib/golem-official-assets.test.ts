import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// Plan 170 D10: every official character in the shared catalog ships its
// four poses with the app (the Golem's are the default pack), so official
// avatars work offline and signed out. Each file obeys the default pack's
// rules: a WebP with alpha, under 200 KB, drawn at the same scale.

interface CatalogEntry {
  slug: string
}

const assetsRoot = new URL('../assets/golem/', import.meta.url)
const catalog = JSON.parse(
  readFileSync(
    new URL('../../../../../../protocol-fixtures/golem-official-catalog.json', import.meta.url),
    'utf8'
  )
) as { avatars: CatalogEntry[] }

const STATES = ['idle', 'talk', 'laugh', 'think'] as const

function posePath(slug: string, state: string): string {
  const folder = slug === 'golem' ? 'default/' : `official/${slug}/`
  return fileURLToPath(new URL(`${folder}${state}.webp`, assetsRoot))
}

/** Canvas size from an extended (VP8X) WebP header, which alpha WebPs carry. */
function webpSize(bytes: Buffer): { width: number; height: number; alpha: boolean } {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
  expect(bytes.toString('ascii', 8, 12)).toBe('WEBP')
  expect(bytes.toString('ascii', 12, 16)).toBe('VP8X')
  const flags = bytes[20]
  const width = 1 + bytes.readUIntLE(24, 3)
  const height = 1 + bytes.readUIntLE(27, 3)
  return { width, height, alpha: (flags & 0x10) !== 0 }
}

describe('official Golem assets', () => {
  it('lists the five official characters', () => {
    expect(catalog.avatars.map((entry) => entry.slug)).toEqual([
      'golem',
      'orc',
      'goblin',
      'pirate',
      'robot'
    ])
  })

  for (const entry of catalog.avatars) {
    for (const state of STATES) {
      it(`${entry.slug} ${state}: a WebP with alpha, under 200 KB, 500 to 800 px tall`, () => {
        const path = posePath(entry.slug, state)
        expect(existsSync(path), path).toBe(true)
        expect(statSync(path).size).toBeLessThan(200 * 1024)
        const size = webpSize(readFileSync(path))
        expect(size.alpha).toBe(true)
        expect(size.height).toBeGreaterThanOrEqual(500)
        expect(size.height).toBeLessThanOrEqual(800)
      })
    }
  }
})
