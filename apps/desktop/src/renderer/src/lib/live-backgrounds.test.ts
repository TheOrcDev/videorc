import { readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { LiveBackgroundStillReason } from '@/lib/backend'
import {
  LIVE_BACKGROUND_CATALOG,
  LIVE_BACKGROUND_THUMBNAILS,
  liveBackgroundLabel,
  liveBackgroundLook,
  liveBackgroundStillLine,
  liveBackgroundThumbnail
} from './live-backgrounds'
import { livePosterAssetId } from '../../../shared/live-background-ids'

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

describe('live background thumbnails (plan 190 S8)', () => {
  it('pins every look to its own thumbnail file, and every file to a look', () => {
    const posterIds = LIVE_BACKGROUND_CATALOG.flatMap((entry) =>
      entry.looks.map((look) => livePosterAssetId(entry.id, look.id))
    )
    expect(posterIds).toHaveLength(15)
    expect(Object.keys(LIVE_BACKGROUND_THUMBNAILS).sort()).toEqual([...posterIds].sort())
    for (const posterId of posterIds) {
      expect(LIVE_BACKGROUND_THUMBNAILS[posterId]).toContain(`live-thumbs/${posterId}.webp`)
    }
    const files = readdirSync(THUMBNAIL_DIR).filter((file) => file.endsWith('.webp'))
    expect(files.map((file) => file.replace(/\.webp$/, '')).sort()).toEqual([...posterIds].sort())
  })

  it("shows the current look's thumbnail, and the first look's for a look this build lacks", () => {
    expect(liveBackgroundThumbnail('silk', 'midnight')).toContain('live-silk-midnight.webp')
    expect(liveBackgroundThumbnail('line-waves', 'aurora')).toContain('live-line-waves-aurora.webp')
    expect(liveBackgroundThumbnail('plasma-wave', 'neon')).toContain('live-plasma-wave-plasma.webp')
    expect(liveBackgroundLook('plasma-wave', 'neon').id).toBe('plasma')
  })

  it('names a live background with its look', () => {
    expect(liveBackgroundLabel('silk', 'satin')).toBe('Silk · Satin')
    expect(liveBackgroundLabel('side-rays', 'moonlight')).toBe('Side Rays · Moonlight')
    expect(liveBackgroundLabel('liquid-chrome', 'unknown')).toBe('Liquid Chrome · Polished')
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
