import { describe, expect, it } from 'vitest'

import {
  MAIN_ISOLATED_BACKEND_EVENTS,
  parseMainBackendWireMessage,
  parseMainBannerList,
  parseMainBannersChangedEvent,
  parseMainCompositorFrameReadyEvent,
  parseMainCompositorStatusEvent,
  parseMainHtmlOverlayTargets,
  parseMainHtmlOverlayTargetsEvent,
  parseMainPreviewSurfaceStatus,
  parseMainPreviewSurfaceStatusEvent,
  parseMainRecordingStatusEvent,
  parseMainScene,
  parseMainSceneChangedEvent,
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

describe('the HTML overlay targets on the main socket (plan 231)', () => {
  const target = {
    id: '0f9d1c2e-5b7a-4c3d-9e8f-a1b2c3d4e5f6',
    pageWidth: 640,
    pageHeight: 360,
    frameWidth: 384,
    frameHeight: 216,
    fps: 30
  }

  it('isolates the feed: a bad target list never retires the capture socket', () => {
    expect(MAIN_ISOLATED_BACKEND_EVENTS.has('htmlOverlays.targets')).toBe(true)
    const bad = { event: 'htmlOverlays.targets', payload: { targets: [{ id: '../../etc' }] } }
    expect(parseMainBackendWireMessage(JSON.stringify(bad))).toEqual(bad)
    // The handler validates at use, strictly: main opens no window for it.
    expect(() => parseMainHtmlOverlayTargetsEvent(bad.payload)).toThrow('htmlOverlays.targets')
    expect(() => parseMainHtmlOverlayTargets({})).toThrow('htmlOverlays.targets.get')
  })

  it('accepts exactly what the backend names, and nothing main could misuse', () => {
    expect(parseMainHtmlOverlayTargetsEvent({ targets: [target] })).toEqual({ targets: [target] })
    expect(parseMainHtmlOverlayTargets({ targets: [] })).toEqual({ targets: [] })
    for (const bad of [
      // An id is a folder name and a host name in main: only a banner id.
      { ...target, id: 'not-a-uuid/../x' },
      // A frame larger than a side can be.
      { ...target, frameWidth: 100_000 },
      // Above the rate an overlay may render at.
      { ...target, fps: 240 },
      // A path is never the backend's to hand main.
      { ...target, folder: '/Users/me/Desktop' }
    ]) {
      expect(() => parseMainHtmlOverlayTargetsEvent({ targets: [bad] })).toThrow()
    }
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

describe('the committed scene on the main socket (proof surface background)', () => {
  const scene = {
    id: 'scene:main',
    name: 'Main',
    sources: [],
    outputs: [],
    background: {
      assetId: 'live-silk-satin',
      managedAssetPath: 'videorc-asset://background/live-silk-satin.webp',
      fit: 'fill',
      scale: 100,
      offsetX: 0,
      offsetY: 0,
      blurPx: 0,
      dimPercent: 0,
      saturationPercent: 100,
      vignettePercent: 0,
      visibilityPercent: 20,
      live: { id: 'silk', look: 'satin', motion: 'calm' }
    }
  }

  it('validates the scene and the changed event at use', () => {
    expect(parseMainScene(scene)).toEqual(scene)
    expect(parseMainSceneChangedEvent(scene)).toEqual(scene)
    const { background: _background, ...withoutBackground } = scene
    expect(parseMainSceneChangedEvent(withoutBackground)).toEqual(withoutBackground)
    expect(() => parseMainScene({ id: 'scene:main' })).toThrow('scene.get')
    expect(() => parseMainSceneChangedEvent({ ...scene, background: { assetId: 7 } })).toThrow(
      'scene.changed'
    )
    expect(() =>
      parseMainScene({ ...scene, background: { ...scene.background, fit: 'tile' } })
    ).toThrow('backend.scene.get.result.background.fit')
    expect(() =>
      parseMainSceneChangedEvent({
        ...scene,
        background: { ...scene.background, live: { ...scene.background.live, id: 'lava' } }
      })
    ).toThrow('background.live.id')
    expect(() =>
      parseMainSceneChangedEvent({ ...scene, background: { ...scene.background, extra: true } })
    ).toThrow('scene.changed')
  })

  it('never retires the socket over a bad scene: the event is isolated', () => {
    expect(MAIN_ISOLATED_BACKEND_EVENTS.has('scene.changed')).toBe(true)
    const parsed = parseMainBackendWireMessage(
      JSON.stringify({ event: 'scene.changed', payload: { id: 7 } })
    )
    expect(parsed).toEqual({ event: 'scene.changed', payload: { id: 7 } })
  })
})
