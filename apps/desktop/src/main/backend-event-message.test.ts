import { describe, expect, it } from 'vitest'

import {
  parseMainBackendWireMessage,
  parseMainBannerList,
  parseMainBannersChangedEvent,
  parseMainCompositorFrameReadyEvent,
  parseMainCompositorStatusEvent,
  parseMainPreviewSurfaceStatus,
  parseMainPreviewSurfaceStatusEvent,
  parseMainRecordingStatusEvent
} from './backend-event-message'

describe('main backend event trust boundary', () => {
  it('rejects malformed and oversized websocket envelopes before privileged dispatch', () => {
    expect(() => parseMainBackendWireMessage('null')).toThrow('invalid websocket envelope')
    expect(() => parseMainBackendWireMessage(' '.repeat(16_000_001))).toThrow('oversized')
  })

  it('semantically validates capture and native-present state before mutation', () => {
    expect(() => parseMainRecordingStatusEvent({ state: 'attacker-controlled' })).toThrow(
      'recording.status'
    )
    expect(() => parseMainCompositorStatusEvent({})).toThrow('compositor.status')
    expect(() => parseMainCompositorFrameReadyEvent(null)).toThrow('preview.frameReady')
    expect(() => parseMainPreviewSurfaceStatus({})).toThrow('preview.surface.status')
    expect(() => parseMainPreviewSurfaceStatusEvent({})).toThrow('preview.surface.status')

    expect(
      parseMainCompositorFrameReadyEvent({
        targetFps: 30,
        width: 1920,
        height: 1080,
        framesRendered: 42,
        frameAgeMs: 12,
        updatedAt: '2026-07-12T00:00:00.000Z'
      })
    ).toMatchObject({ framesRendered: 42, width: 1920, height: 1080 })
  })

  it('isolates the banner feed: a bad list never retires the capture socket (plan 186)', () => {
    const bad = { event: 'banners.changed', payload: [{ id: 'x', imageFile: '/etc/passwd' }] }
    // Envelope parsing still runs; the payload is left for its handler.
    expect(parseMainBackendWireMessage(JSON.stringify(bad))).toEqual(bad)
    expect(() => parseMainBackendWireMessage(JSON.stringify({ ...bad, extra: true }))).toThrow(
      'backend.event.extra'
    )
    // The handler validates at use, strictly.
    expect(() => parseMainBannersChangedEvent(bad.payload)).toThrow('banners.changed')
    expect(() => parseMainBannerList({})).toThrow('banners.list')
    expect(parseMainBannersChangedEvent([])).toEqual([])
    expect(parseMainBannerList([])).toEqual([])
    // Every other event keeps validating before dispatch.
    expect(() =>
      parseMainBackendWireMessage(JSON.stringify({ event: 'recording.status', payload: {} }))
    ).toThrow('recording.status')
  })
})
