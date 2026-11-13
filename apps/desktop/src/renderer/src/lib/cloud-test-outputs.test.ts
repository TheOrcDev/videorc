import { describe, expect, it } from 'vitest'

import type { StreamTargetSettings } from './backend'
import {
  type CaptureConfig,
  defaultCaptureConfig,
  streamOutputVideoForTarget,
  streamOutputVideoSettings
} from './capture'
import { cloudTestOutputs, cloudUploadPlan } from './cloud-test-outputs'

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

// Plan 222 U2, U3: the upload through the cloud against streaming directly.
describe('cloudUploadPlan (plan 222 U2, U3)', () => {
  it('has nothing to say with no destination enabled', () => {
    expect(cloudUploadPlan(config([]))).toBeNull()
  })

  it('uploads one feed for one or three horizontal destinations', () => {
    const one = config([target('a')])
    const kbps = streamOutputVideoSettings(one.video, one.streaming).bitrateKbps
    expect(cloudUploadPlan(one)).toEqual({ feedsKbps: [kbps], directKbps: kbps, destinations: 1 })
    const three = config([target('a'), target('b'), target('c')])
    const each = three.streaming.targets.map(
      (entry) => streamOutputVideoForTarget(three.video, three.streaming, entry).bitrateKbps
    )
    const plan = cloudUploadPlan(three)!
    expect(plan.feedsKbps).toEqual([Math.min(...each)])
    expect(plan.directKbps).toBe(each.reduce((sum, value) => sum + value, 0))
    expect(plan.destinations).toBe(3)
  })

  it('uploads one feed per orientation with a vertical destination', () => {
    const dual = config([target('a'), target('b'), target('v', { outputOrientation: 'vertical' })])
    const outputs = cloudTestOutputs(dual)
    const vertical = outputs.find((output) => output.orientation === 'vertical')!
    expect(vertical).toBeDefined()
    const plan = cloudUploadPlan(dual)!
    expect(plan.feedsKbps).toHaveLength(2)
    expect(plan.feedsKbps[1]).toBe(vertical.videoKbps)
    expect(plan.destinations).toBe(3)
    expect(plan.directKbps).toBeGreaterThan(plan.feedsKbps[0]! + plan.feedsKbps[1]!)
  })
})
