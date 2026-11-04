import { describe, expect, it } from 'vitest'

import {
  MAIN_ISOLATED_BACKEND_EVENTS,
  parseMainBackendWireMessage,
  parseMainBannerList,
  parseMainBannersChangedEvent,
  parseMainCompositorFrameReadyEvent,
  parseMainCompositorStatusEvent,
  parseMainPreviewSurfaceStatus,
  parseMainPreviewSurfaceStatusEvent,
  parseMainRecordingStatusEvent,
  parseMainVirtualCameraChangedEvent,
  parseMainVirtualCameraStatus
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

describe('the Videorc Camera status on the main socket (plan 214 B3)', () => {
  const ready = { on: true, available: true, state: 'ready', viewers: 0, platformStep: 'ready' }

  it('validates the status and the changed event at use', () => {
    expect(parseMainVirtualCameraStatus(ready)).toEqual(ready)
    expect(parseMainVirtualCameraChangedEvent(ready)).toEqual(ready)
    expect(() => parseMainVirtualCameraStatus({ on: true })).toThrow('virtualCamera.status')
    expect(() => parseMainVirtualCameraChangedEvent({ ...ready, state: 'sleeping' })).toThrow(
      'virtualCamera.changed'
    )
    expect(() => parseMainVirtualCameraChangedEvent(null)).toThrow('virtualCamera.changed')
  })

  it('never retires the socket over a bad camera status: the event is isolated', () => {
    expect(MAIN_ISOLATED_BACKEND_EVENTS.has('virtualCamera.changed')).toBe(true)
    const parsed = parseMainBackendWireMessage(
      JSON.stringify({ event: 'virtualCamera.changed', payload: { on: 'yes' } })
    )
    expect(parsed).toEqual({ event: 'virtualCamera.changed', payload: { on: 'yes' } })
  })
})
