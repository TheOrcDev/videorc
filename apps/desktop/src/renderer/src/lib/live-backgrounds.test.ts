import { readdirSync, statSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { LiveBackgroundStillReason } from '@/lib/backend'
import {
  LIVE_BACKGROUND_CATALOG,
  LIVE_BACKGROUND_OFFERED,
  LIVE_BACKGROUND_THUMBNAILS,
  liveBackgroundLabel,
  liveBackgroundLook,
  liveBackgroundStillLine,
  liveBackgroundThumbnail
} from './live-backgrounds'
import { livePosterAssetId } from '../../../shared/live-background-ids'

const POSTER_DIR = new URL('../assets/backgrounds/', import.meta.url)
const THUMBNAIL_DIR = new URL('../assets/backgrounds/live-thumbs/', import.meta.url)

const ALL_REASONS: readonly LiveBackgroundStillReason[] = [
  'forced',
  'legacy-graph',
  'cpu-fallback',
  'no-gpu',
  'software-gpu',
  'quarantined-node',
  'shader-compile-failed',
  'gpu-budget'
]

describe('live background thumbnails (plans 190 S8 and 194 S6)', () => {
  it('pins every look to its own thumbnail file, and every file to a look', () => {
    const posterIds = LIVE_BACKGROUND_OFFERED.flatMap((entry) =>
      entry.looks.map((look) => livePosterAssetId(entry.id, look.id))
    )
    expect(posterIds).toHaveLength(30)
    expect(Object.keys(LIVE_BACKGROUND_THUMBNAILS).sort()).toEqual([...posterIds].sort())
    for (const posterId of posterIds) {
      expect(LIVE_BACKGROUND_THUMBNAILS[posterId]).toContain(`live-thumbs/${posterId}.webp`)
    }
    const files = readdirSync(THUMBNAIL_DIR).filter((file) => file.endsWith('.webp'))
    expect(files.map((file) => file.replace(/\.webp$/, '')).sort()).toEqual([...posterIds].sort())
  })

  it('offers all ten, the plan 190 five first, each with a thumbnail for every look (plan 194 S6)', () => {
    // The plan 194 five joined Assets with their thumbnails, so no tile ever
    // shows without a picture.
    expect(LIVE_BACKGROUND_OFFERED.map((entry) => entry.id)).toEqual([
      'silk',
      'side-rays',
      'plasma-wave',
      'liquid-chrome',
      'line-waves',
      'beams',
      'color-bends',
      'dither',
      'ferrofluid',
      'ghost-fibers'
    ])
    expect(LIVE_BACKGROUND_OFFERED).toEqual(LIVE_BACKGROUND_CATALOG)
  })

  it('keeps every bundled live picture inside its size limit (plan 190: 250 KB, 20 KB)', () => {
    const posterIds = LIVE_BACKGROUND_OFFERED.flatMap((entry) =>
      entry.looks.map((look) => livePosterAssetId(entry.id, look.id))
    )
    // Plan 194's fifteen. Line Waves (plan 190) shipped over both limits
    // (510-570 KB and 42-45 KB) and stays as shipped.
    const PLAN_194 = /^live-(beams|color-bends|dither|ferrofluid|ghost-fibers)-/
    for (const posterId of posterIds.filter((id) => PLAN_194.test(id))) {
      expect(statSync(new URL(`${posterId}.webp`, POSTER_DIR)).size).toBeLessThanOrEqual(250_000)
      expect(statSync(new URL(`${posterId}.webp`, THUMBNAIL_DIR)).size).toBeLessThanOrEqual(20_000)
    }
  })

  it("shows the current look's thumbnail, and the first look's for a look this build lacks", () => {
    expect(liveBackgroundThumbnail('silk', 'midnight')).toContain('live-silk-midnight.webp')
    expect(liveBackgroundThumbnail('line-waves', 'aurora')).toContain('live-line-waves-aurora.webp')
    expect(liveBackgroundThumbnail('plasma-wave', 'neon')).toContain('live-plasma-wave-plasma.webp')
    expect(liveBackgroundThumbnail('dither', 'blueprint')).toContain('live-dither-blueprint.webp')
    expect(liveBackgroundThumbnail('ghost-fibers', 'neon')).toContain(
      'live-ghost-fibers-violet.webp'
    )
    expect(liveBackgroundLook('plasma-wave', 'neon').id).toBe('plasma')
  })

  it('names a live background with its look', () => {
    expect(liveBackgroundLabel('silk', 'satin')).toBe('Silk · Satin')
    expect(liveBackgroundLabel('side-rays', 'moonlight')).toBe('Side Rays · Moonlight')
    expect(liveBackgroundLabel('liquid-chrome', 'unknown')).toBe('Liquid Chrome · Polished')
    expect(liveBackgroundLabel('color-bends', 'ocean')).toBe('Color Bends · Ocean')
    expect(liveBackgroundLabel('ghost-fibers', 'fiber')).toBe('Ghost Fibers · Fiber Optic')
  })
})

describe('liveBackgroundStillLine', () => {
  it('says why in one plain sentence per reason', () => {
    const lines = ALL_REASONS.map((reason) => liveBackgroundStillLine(reason))
    expect(new Set(lines).size).toBe(ALL_REASONS.length)
    for (const line of lines) {
      expect(line).toMatch(/^Showing a still frame: [a-zA-Z].*[^.]\.$/)
      // One sentence, no em dash, no internals (docs/ui-copy.md).
      expect(line.split('. ')).toHaveLength(1)
      expect(line).not.toMatch(/—|\.\.\.|compositor|backend|shader|GPU|VIDEORC_/)
    }
    expect(liveBackgroundStillLine('legacy-graph')).toBe(
      "Showing a still frame: it can't move at this resolution and frame rate."
    )
    expect(liveBackgroundStillLine('gpu-budget')).toBe(
      'Showing a still frame: your graphics card is too busy to animate it.'
    )
  })

  it('still says what shows when the reason is missing or unknown', () => {
    expect(liveBackgroundStillLine(undefined)).toBe('Showing a still frame.')
    expect(liveBackgroundStillLine('lunar-eclipse' as LiveBackgroundStillReason)).toBe(
      'Showing a still frame.'
    )
  })
})
