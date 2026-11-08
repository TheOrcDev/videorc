import { describe, expect, it } from 'vitest'

import type { StreamTargetSettings } from './backend'
import {
  type CaptureConfig,
  defaultCaptureConfig,
  streamOutputVideoForTarget,
  streamOutputVideoSettings
} from './capture'
import { cloudTestOutputs } from './cloud-test-outputs'

// Plan 184 C6b: the test pushes the shape a show would be created with.

function target(id: string, overrides: Partial<StreamTargetSettings> = {}): StreamTargetSettings {
  return {
    id,
    platform: 'custom',
    label: id,
    enabled: true,
    serverUrl: 'rtmp://example.test/live',
    streamKey: '',
    streamKeyPresent: true,
    authMode: 'manual-rtmp',
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
    ...overrides
  }
}

function config(
  targets: StreamTargetSettings[],
  overrides: Partial<CaptureConfig> = {}
): CaptureConfig {
  return {
    ...defaultCaptureConfig,
    streamEnabled: true,
    streaming: {
      ...defaultCaptureConfig.streaming,
      enabled: true,
      targets,
      enabledTargetIds: targets.map((entry) => entry.id)
    },
    ...overrides
  }
}

describe('cloudTestOutputs (plan 184 C6b)', () => {
  it('tests the default stream profile before any destination exists', () => {
    const empty = config([])
    const video = streamOutputVideoSettings(empty.video, empty.streaming)
    expect(cloudTestOutputs(empty)).toEqual([
      {
        orientation: 'horizontal',
        width: video.width,
        height: video.height,
        fps: video.fps,
        videoKbps: video.bitrateKbps
      }
    ])
  })

  it('takes the horizontal destinations shape and their lowest bitrate', () => {
    const fast = target('fast', { outputBitrateKbps: 6000 })
    const slow = target('slow', { outputBitrateKbps: 2500 })
    const two = config([fast, slow])
    const shape = streamOutputVideoForTarget(two.video, two.streaming, fast)
    const outputs = cloudTestOutputs(two)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toEqual({
      orientation: 'horizontal',
      width: shape.width,
      height: shape.height,
      fps: shape.fps,
      videoKbps: 2500
    })
    // A destination switched off does not lower the test.
    const off = config([fast, { ...slow, enabled: false }])
    expect(cloudTestOutputs(off)[0]?.videoKbps).toBe(6000)
  })

  it('adds the vertical leg only when the dual-orientation stream is armed', () => {
    const vertical = target('shorts', { outputOrientation: 'vertical' })
    const armed = config([target('main'), vertical])
    const outputs = cloudTestOutputs(armed)
    expect(outputs.map((output) => output.orientation)).toEqual(['horizontal', 'vertical'])
    const leg = outputs[1]!
    expect(leg.height).toBeGreaterThan(leg.width)
    expect(leg.videoKbps).toBeGreaterThan(0)

    // Streaming off: one horizontal output at the recording's quality, no leg.
    const notStreaming = config([target('main'), vertical], { streamEnabled: false })
    expect(cloudTestOutputs(notStreaming).map((output) => output.orientation)).toEqual([
      'horizontal'
    ])
  })
})
