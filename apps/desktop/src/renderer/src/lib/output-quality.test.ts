import { describe, expect, it } from 'vitest'
import {
  coerceVideoToOrientation,
  defaultCaptureConfig,
  normalizeStreamingSettings,
  normalizeVideoSettings,
  videoPresets
} from './capture'
import {
  LANDSCAPE_CANVAS_RULE,
  VERTICAL_CANVAS_RULE,
  commitOutputField,
  outputFieldLimits,
  pickRecordingResolution,
  streamQualityOverride,
  withStreamQuality
} from './output-quality'

describe('independent output quality', () => {
  it('preserves target overrides and recording when changing and reloading stream quality', () => {
    const base = { ...defaultCaptureConfig, video: videoPresets['record-4k30'] }
    const streaming = {
      ...base.streaming,
      targets: base.streaming.targets.map((target) => ({
        ...target,
        ...streamQualityOverride('stream-safe-1080p60')
      }))
    }
    const changed = { ...base, streaming: withStreamQuality(streaming, 'stream-safe-1080p30') }
    expect(changed.video).toBe(base.video)
    expect(changed.streaming.targets).toBe(streaming.targets)
    expect(normalizeStreamingSettings(changed.streaming).targets[0].outputPreset).toBe(
      'stream-safe-1080p60'
    )
    expect(streamQualityOverride('default')).toEqual({
      outputPreset: undefined,
      outputBitrateKbps: undefined
    })
  })
  it('raises the standard HD recording bitrate when selecting 4K, including portrait', () => {
    expect(pickRecordingResolution(videoPresets['tutorial-1080p30'], 3840, 2160)).toMatchObject({
      width: 3840,
      height: 2160,
      bitrateKbps: 30000
    })
    expect(
      pickRecordingResolution(
        { ...videoPresets['tutorial-1080p30'], width: 1080, height: 1920 },
        2160,
        3840
      )
    ).toMatchObject({ width: 2160, height: 3840, bitrateKbps: 30000 })
  })
  it.each([
    [2160, 3840],
    [1440, 2560],
    [360, 640]
  ])('preserves portrait %sx%s recording dimensions on reload', (width, height) => {
    const saved = { preset: 'custom' as const, width, height, fps: 30, bitrateKbps: 30000 }
    expect(normalizeVideoSettings(saved)).toEqual(saved)
  })
  it('keeps an intentional custom recording bitrate', () => {
    expect(
      pickRecordingResolution(
        { ...videoPresets['tutorial-1080p30'], preset: 'custom', bitrateKbps: 18000 },
        3840,
        2160
      ).bitrateKbps
    ).toBe(18000)
  })
})

describe('typed Output fields (plan 174, D-1)', () => {
  const fullHd = videoPresets['tutorial-1080p30']
  const portraitHd = { ...fullHd, preset: 'custom' as const, width: 1080, height: 1920 }

  it('commits the typed width as typed: 2560 into Width gives 2560×1080', () => {
    const result = commitOutputField(fullHd, 'width', '2560', 'horizontal')
    expect(result).toEqual({ kind: 'commit', patch: { width: 2560 } })
    // What patchVideo then stores: the orientation guard has nothing to undo.
    const stored = coerceVideoToOrientation(
      { ...fullHd, ...(result.kind === 'commit' ? result.patch : {}), preset: 'custom' },
      'horizontal'
    )
    expect([stored.width, stored.height]).toEqual([2560, 1080])
  })

  it('refuses a size that contradicts the orientation instead of transposing it', () => {
    expect(commitOutputField(fullHd, 'height', '2000', 'horizontal')).toEqual({
      kind: 'refused',
      message: LANDSCAPE_CANVAS_RULE
    })
    expect(commitOutputField(fullHd, 'width', '800', 'horizontal')).toEqual({
      kind: 'refused',
      message: LANDSCAPE_CANVAS_RULE
    })
    expect(commitOutputField(portraitHd, 'width', '2000', 'vertical')).toEqual({
      kind: 'refused',
      message: VERTICAL_CANVAS_RULE
    })
    // A square canvas fits either orientation.
    expect(commitOutputField(fullHd, 'width', '1080', 'horizontal')).toEqual({
      kind: 'commit',
      patch: { width: 1080 }
    })
  })

  it('clamps to the bounds the saved settings reload with', () => {
    expect(commitOutputField(fullHd, 'width', '9000', 'horizontal')).toEqual({
      kind: 'commit',
      patch: { width: 3840 }
    })
    expect(commitOutputField(fullHd, 'fps', '120', 'horizontal')).toEqual({
      kind: 'commit',
      patch: { fps: 60 }
    })
    expect(commitOutputField(fullHd, 'bitrateKbps', '200', 'horizontal')).toEqual({
      kind: 'commit',
      patch: { bitrateKbps: 1000 }
    })
    expect(commitOutputField(portraitHd, 'height', '9000', 'vertical')).toEqual({
      kind: 'commit',
      patch: { height: 3840 }
    })
    for (const orientation of ['horizontal', 'vertical'] as const) {
      const { min: minWidth, max: maxWidth } = outputFieldLimits('width', orientation)
      const { min: minHeight, max: maxHeight } = outputFieldLimits('height', orientation)
      const corners = [
        { width: minWidth, height: minHeight },
        { width: maxWidth, height: maxHeight }
      ]
      for (const size of corners) {
        const saved = { ...fullHd, preset: 'custom' as const, ...size }
        expect(normalizeVideoSettings(saved)).toEqual(saved)
      }
    }
  })

  it('rounds a fractional value and keeps an empty or unchanged entry as it was', () => {
    expect(commitOutputField(fullHd, 'fps', '29.6', 'horizontal')).toEqual({
      kind: 'unchanged'
    })
    expect(commitOutputField(fullHd, 'bitrateKbps', ' 12345.4 ', 'horizontal')).toEqual({
      kind: 'commit',
      patch: { bitrateKbps: 12345 }
    })
    expect(commitOutputField(fullHd, 'width', '', 'horizontal')).toEqual({ kind: 'unchanged' })
    expect(commitOutputField(fullHd, 'width', 'abc', 'horizontal')).toEqual({ kind: 'unchanged' })
    expect(commitOutputField(fullHd, 'width', '1920', 'horizontal')).toEqual({
      kind: 'unchanged'
    })
  })
})
