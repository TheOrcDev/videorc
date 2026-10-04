import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OrcleEmblem } from './orcle-emblem'

// Plan 149: Orcle's emblem ships as two trimmed WebP exports of the master in
// `assets/brand/orcle/`. Their heights are the 2× files for 32 and 56 px.

const ASSET_DIR = join(__dirname, '..', 'assets', 'orcle')
const RENDERER_ROOT = join(__dirname, '..', '..')
const MAX_EXPORT_BYTES = 20 * 1024

/** The canvas size from a WebP's VP8X chunk (cwebp writes one for alpha). */
function webpSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
  expect(bytes.toString('ascii', 8, 12)).toBe('WEBP')
  expect(bytes.toString('ascii', 12, 16)).toBe('VP8X')
  return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
}

describe('the Orcle emblem exports', () => {
  it.each([
    ['orcle-emblem-64.webp', 64],
    ['orcle-emblem-112.webp', 112]
  ])('%s is a %i px tall WebP under the byte cap', (file, height) => {
    const bytes = readFileSync(join(ASSET_DIR, file))
    const size = webpSize(bytes)
    expect(size.height).toBe(height)
    // The trimmed eye keeps its aspect (about 1.43 : 1), never squared.
    expect(size.width / size.height).toBeGreaterThan(1.35)
    expect(size.width / size.height).toBeLessThan(1.5)
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_EXPORT_BYTES)
  })

  it('never bundles the 1.5 MB master', () => {
    const offenders: string[] = []
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry)
        if (statSync(path).isDirectory()) {
          if (entry !== 'node_modules') walk(path)
        } else if (/\.(tsx?|css|html)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          if (readFileSync(path, 'utf8').includes('orcle-eye-emblem-master')) offenders.push(path)
        }
      }
    }
    walk(RENDERER_ROOT)
    expect(offenders).toEqual([])
  })
})

describe('OrcleEmblem', () => {
  const markup = (props: Parameters<typeof OrcleEmblem>[0] = {}): string =>
    renderToStaticMarkup(createElement(OrcleEmblem, props))

  it('is decorative at 32 px by default', () => {
    const html = markup()
    expect(html).toContain('alt=""')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('h-8')
    expect(html).toContain('orcle-emblem-64')
    expect(html).toContain('draggable="false"')
  })

  it('uses the larger export at 56 px', () => {
    const html = markup({ size: 'lg' })
    expect(html).toContain('h-14')
    expect(html).toContain('orcle-emblem-112')
  })

  it('names itself when given alt text', () => {
    const html = markup({ alt: 'Orcle' })
    expect(html).toContain('alt="Orcle"')
    expect(html).not.toContain('aria-hidden')
  })
})
