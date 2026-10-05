import { describe, expect, it } from 'vitest'
import { defaultCaptureConfig, normalizeStreamingSettings, videoPresets } from './capture'
import {
  recordingResolutionSettings,
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
    expect(recordingResolutionSettings(videoPresets['tutorial-1080p30'], 3840, 2160)).toMatchObject(
      { width: 3840, height: 2160, bitrateKbps: 30000 }
    )
    expect(
      recordingResolutionSettings(
        { ...videoPresets['tutorial-1080p30'], width: 1080, height: 1920 },
        2160,
        3840
      )
    ).toMatchObject({ width: 2160, height: 3840, bitrateKbps: 30000 })
  })
  it('keeps an intentional custom recording bitrate', () => {
    expect(
      recordingResolutionSettings(
        { ...videoPresets['tutorial-1080p30'], preset: 'custom', bitrateKbps: 18000 },
        3840,
        2160
      ).bitrateKbps
    ).toBe(18000)
  })
})
