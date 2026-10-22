import { describe, expect, it } from 'vitest'

import {
  formatBitrate,
  formatFrameRate,
  formatResolution,
  formatVideoQuality,
  resolutionName
} from './format-video'

// Plan 174 S1.4 (D-22, V-X2): one spelling per video fact.

describe('resolutionName', () => {
  it('names a size by its short edge, 4K for 2160', () => {
    expect(resolutionName({ width: 3840, height: 2160 })).toBe('4K')
    expect(resolutionName({ width: 2560, height: 1440 })).toBe('1440p')
    expect(resolutionName({ width: 1920, height: 1080 })).toBe('1080p')
    expect(resolutionName({ width: 1280, height: 720 })).toBe('720p')
    expect(resolutionName({ width: 960, height: 540 })).toBe('540p')
    expect(resolutionName({ width: 640, height: 360 })).toBe('360p')
  })

  it('reads the same class in either orientation, and never says 2K or Full HD', () => {
    expect(resolutionName({ width: 1080, height: 1920 })).toBe('1080p')
    expect(resolutionName({ width: 2160, height: 3840 })).toBe('4K')
    for (const [width, height] of [
      [2560, 1440],
      [1920, 1080]
    ]) {
      expect(resolutionName({ width, height })).not.toMatch(/2K|Full HD/)
    }
  })
})

describe('formatResolution', () => {
  it('spells both sides, width first, with a spaced multiplication sign', () => {
    expect(formatResolution({ width: 1920, height: 1080 })).toBe('1920 × 1080')
    expect(formatResolution({ width: 1080, height: 1920 })).toBe('1080 × 1920')
  })
})

describe('formatFrameRate', () => {
  it('writes fps in lower case after a space', () => {
    expect(formatFrameRate(30)).toBe('30 fps')
    expect(formatFrameRate(60)).toBe('60 fps')
    expect(formatFrameRate(29.97)).toBe('29.97 fps')
    expect(formatFrameRate(29.9712)).toBe('29.97 fps')
  })
})

describe('formatBitrate', () => {
  it('always says Mbps, with one decimal at most', () => {
    expect(formatBitrate(6000)).toBe('6 Mbps')
    expect(formatBitrate(4500)).toBe('4.5 Mbps')
    expect(formatBitrate(12_000)).toBe('12 Mbps')
    expect(formatBitrate(800)).toBe('0.8 Mbps')
    expect(formatBitrate(6049)).toBe('6 Mbps')
  })

  it('is empty when there is no rate', () => {
    expect(formatBitrate(undefined)).toBe('')
    expect(formatBitrate(Number.NaN)).toBe('')
    expect(formatBitrate(-1)).toBe('')
  })
})

describe('formatVideoQuality', () => {
  const hd = { width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }

  it('says the short form by default', () => {
    expect(formatVideoQuality(hd)).toBe('1080p · 30 fps')
    expect(formatVideoQuality({ width: 3840, height: 2160, fps: 60 })).toBe('4K · 60 fps')
    expect(formatVideoQuality({ width: 2560, height: 1440, fps: 30 })).toBe('1440p · 30 fps')
  })

  it('spells the full size on request', () => {
    expect(formatVideoQuality(hd, { size: 'full' })).toBe('1920 × 1080 · 30 fps')
  })

  it('adds the bitrate on request, and only when there is one', () => {
    expect(formatVideoQuality(hd, { bitrate: true })).toBe('1080p · 30 fps · 6 Mbps')
    expect(formatVideoQuality(hd, { size: 'full', bitrate: true })).toBe(
      '1920 × 1080 · 30 fps · 6 Mbps'
    )
    expect(formatVideoQuality({ width: 1920, height: 1080, fps: 30 }, { bitrate: true })).toBe(
      '1080p · 30 fps'
    )
  })

  it('keeps both sides of a portrait canvas, because "1080p" reads as landscape', () => {
    expect(formatVideoQuality({ width: 1080, height: 1920, fps: 30, bitrateKbps: 6000 })).toBe(
      '1080 × 1920 · 30 fps'
    )
    expect(
      formatVideoQuality(
        { width: 1080, height: 1920, fps: 30, bitrateKbps: 6000 },
        { bitrate: true }
      )
    ).toBe('1080 × 1920 · 30 fps · 6 Mbps')
  })

  it('never spells a size the old ways', () => {
    const spellings = [
      formatVideoQuality(hd),
      formatVideoQuality(hd, { size: 'full', bitrate: true }),
      formatVideoQuality({ width: 1080, height: 1920, fps: 60 })
    ]
    for (const text of spellings) {
      expect(text).not.toMatch(/\d×\d|\dx\d|fps\b.*@|@|FPS|\dfps|p\d{2}\b|kbps|Full HD/)
    }
  })
})
