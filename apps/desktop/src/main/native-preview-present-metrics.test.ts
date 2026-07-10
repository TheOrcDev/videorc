import { describe, expect, it } from 'vitest'

import { NativePreviewPresentMetrics } from './native-preview-present-metrics'

describe('native preview present metrics', () => {
  it('measures native present cadence and input-to-present latency', () => {
    let nowMs = 1_000
    const metrics = new NativePreviewPresentMetrics(() => nowMs, 0)
    const request = {
      frameAgeMs: 5,
      compositorUpdatedAt: new Date(990).toISOString()
    }

    expect(metrics.record(request)).toMatchObject({
      inputToPresentLatencyMs: 15,
      presentFps: undefined
    })
    nowMs = 1_016
    expect(metrics.record(request)).toMatchObject({
      presentFps: 62.5,
      intervalP95Ms: 16,
      intervalP99Ms: 16,
      inputToPresentLatencyMs: 31,
      inputToPresentLatencyP95Ms: 31
    })
  })

  it('resets only the measurement window', () => {
    let nowMs = 2_000
    const metrics = new NativePreviewPresentMetrics(() => nowMs, 0)
    metrics.record({ frameAgeMs: 2 })
    nowMs += 20
    expect(metrics.record({ frameAgeMs: 2 }).presentFps).toBe(50)

    metrics.reset()
    expect(metrics.record({ frameAgeMs: 2 }).presentFps).toBeUndefined()
  })

  it('keeps percentile and cadence assembly on telemetry ticks, not presents', () => {
    let nowMs = 10_000
    const metrics = new NativePreviewPresentMetrics(() => nowMs, 250)

    for (let index = 0; index < 10_000; index += 1) {
      metrics.record({ frameAgeMs: index % 4 })
      nowMs += 1
    }

    expect(metrics.telemetryRefreshCount).toBeGreaterThanOrEqual(40)
    expect(metrics.telemetryRefreshCount).toBeLessThanOrEqual(41)
  })
})
