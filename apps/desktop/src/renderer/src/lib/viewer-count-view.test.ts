import { describe, expect, it } from 'vitest'

import type { ViewerSample } from '@/lib/backend'
import {
  formatViewerCount,
  viewerChipCount,
  viewerChipDetail,
  viewerChipLabel,
  viewerSampleStale
} from './viewer-count-view'

function sample(overrides: Partial<ViewerSample> = {}): ViewerSample {
  return {
    sessionId: 's',
    platforms: [
      { platform: 'youtube', count: 1234 },
      { platform: 'twitch', count: 87 }
    ],
    total: 1321,
    at: '2026-07-07T00:00:00Z',
    ...overrides
  }
}

// Viewer rider V2: the chip says "watching" (viewers, never subs), compacts
// large counts, and greys out instead of freezing when samples stop.
describe('viewer count view', () => {
  it('compacts counts', () => {
    expect(formatViewerCount(7)).toBe('7')
    expect(formatViewerCount(999)).toBe('999')
    expect(formatViewerCount(1000)).toBe('1k')
    expect(formatViewerCount(1234)).toBe('1.2k')
    expect(formatViewerCount(2_500_000)).toBe('2.5m')
  })

  it('promotes to the next unit on the rounded value', () => {
    expect(formatViewerCount(999_949)).toBe('999.9k')
    expect(formatViewerCount(999_999)).toBe('1m')
    expect(formatViewerCount(1_000_000)).toBe('1m')
    expect(formatViewerCount(1_500_000)).toBe('1.5m')
  })

  it('keeps the bare count for the narrow header', () => {
    expect(viewerChipCount(sample())).toBe('1.3k')
    expect(viewerChipCount(sample({ total: 999 }))).toBe('999')
  })

  it('labels with "watching" — never "subs"', () => {
    expect(viewerChipLabel(sample())).toBe('1.3k watching')
    expect(viewerChipLabel(sample())).not.toMatch(/sub/i)
  })

  it('details the per-platform split', () => {
    expect(viewerChipDetail(sample())).toBe('youtube: 1.2k · twitch: 87')
  })

  it('goes stale after 2× the sampler cadence', () => {
    const at = Date.parse('2026-07-07T00:00:00Z')
    expect(viewerSampleStale(sample(), at + 60_000)).toBe(false)
    expect(viewerSampleStale(sample(), at + 76_000)).toBe(true)
    expect(viewerSampleStale(sample({ at: 'garbage' }), at)).toBe(true)
  })
})
