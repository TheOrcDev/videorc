import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceCompositorUpdateParams, PreviewSurfaceStatus } from '@/lib/backend'
import {
  DEFAULT_NATIVE_PREVIEW_MAX_HANDOFF_AGE_MS,
  compositorStatusMetalTargetHandoff,
  nativeCametalLayerStatusMatchesHandoff,
  proofSurfaceCompositorMessage,
  realSurfaceUnavailableMessage,
  staleNativePreviewHandoffShouldDeclareFallback
} from '../../../shared/native-preview-host-driver'

function compositorStatus(
  overrides: Partial<PreviewSurfaceCompositorUpdateParams> = {}
): PreviewSurfaceCompositorUpdateParams {
  return {
    state: 'live',
    targetFps: 30,
    width: 1920,
    height: 1080,
    sceneSources: [],
    sources: [],
    runId: 'preview-run-1',
    framesRendered: 42,
    repeatedFrames: 0,
    droppedFrames: 0,
    metalTargetIosurfaceId: 7001,
    metalTargetWidth: 1920,
    metalTargetHeight: 1080,
    updatedAt: '2026-06-06T12:00:00.000Z',
    ...overrides
  }
}

function previewStatus(overrides: Partial<PreviewSurfaceStatus> = {}): PreviewSurfaceStatus {
  return {
    state: 'live',
    source: 'screen',
    transport: 'native-surface',
    backing: 'cametal-layer',
    targetFps: 60,
    width: 1280,
    height: 720,
    framesRendered: 42,
    presentedFrameId: 42,
    droppedFrames: 0,
    framePollingSuppressed: true,
    sourcePixelsPresent: true,
    pendingHostCommandCount: 0,
    updatedAt: '2026-06-06T12:00:00.000Z',
    ...overrides
  }
}

describe('native-preview-host-driver', () => {
  it('extracts a complete IOSurface handoff from compositor status', () => {
    expect(compositorStatusMetalTargetHandoff(compositorStatus())).toEqual({
      iosurfaceId: 7001,
      width: 1920,
      height: 1080,
      frameId: 42,
      runId: 'preview-run-1'
    })
  })

  it('rejects incomplete or non-positive IOSurface handoff metadata', () => {
    expect(
      compositorStatusMetalTargetHandoff(compositorStatus({ metalTargetIosurfaceId: undefined }))
    ).toBeNull()
    expect(
      compositorStatusMetalTargetHandoff(compositorStatus({ metalTargetIosurfaceId: 0 }))
    ).toBeNull()
    expect(compositorStatusMetalTargetHandoff(compositorStatus({ metalTargetWidth: 0 }))).toBeNull()
    expect(
      compositorStatusMetalTargetHandoff(compositorStatus({ metalTargetHeight: -1 }))
    ).toBeNull()
    expect(compositorStatusMetalTargetHandoff(compositorStatus({ framesRendered: 0 }))).toBeNull()
    expect(
      compositorStatusMetalTargetHandoff(compositorStatus({ metalTargetIosurfaceId: 7.5 }))
    ).toBeNull()
  })

  it('rejects stale IOSurface handoff metadata when an age gate is provided', () => {
    const nowMs = Date.parse('2026-06-06T12:00:01.000Z')

    expect(
      compositorStatusMetalTargetHandoff(compositorStatus(), {
        nowMs,
        maxAgeMs: DEFAULT_NATIVE_PREVIEW_MAX_HANDOFF_AGE_MS
      })
    ).toBeNull()
    expect(
      compositorStatusMetalTargetHandoff(compositorStatus(), {
        nowMs: Date.parse('2026-06-06T12:00:00.200Z'),
        maxAgeMs: DEFAULT_NATIVE_PREVIEW_MAX_HANDOFF_AGE_MS
      })
    ).toEqual({
      iosurfaceId: 7001,
      width: 1920,
      height: 1080,
      frameId: 42,
      runId: 'preview-run-1'
    })
  })

  it('declares stale-handoff fallback only after repeated bounded failure', () => {
    expect(
      staleNativePreviewHandoffShouldDeclareFallback({ attemptCount: 1, elapsedMs: 1_500 })
    ).toBe(false)
    expect(
      staleNativePreviewHandoffShouldDeclareFallback({ attemptCount: 10, elapsedMs: 250 })
    ).toBe(false)
    expect(
      staleNativePreviewHandoffShouldDeclareFallback({ attemptCount: 3, elapsedMs: 1_000 })
    ).toBe(true)
  })

  it('rejects IOSurface handoffs rendered from an older scene revision', () => {
    expect(
      compositorStatusMetalTargetHandoff(
        compositorStatus({ sceneRevision: 12, frameSceneRevision: 11 })
      )
    ).toBeNull()
    expect(
      compositorStatusMetalTargetHandoff(
        compositorStatus({ sceneRevision: 12, frameSceneRevision: 12 })
      )
    ).toEqual({
      iosurfaceId: 7001,
      width: 1920,
      height: 1080,
      frameId: 42,
      runId: 'preview-run-1'
    })
    expect(
      compositorStatusMetalTargetHandoff(compositorStatus({ sceneRevision: 12 }))
    ).not.toBeNull()
  })

  it('keeps the fallback message honest when no real driver is installed', () => {
    const status = compositorStatus()
    const handoff = compositorStatusMetalTargetHandoff(status)

    expect(handoff).not.toBeNull()
    const message = proofSurfaceCompositorMessage(status, realSurfaceUnavailableMessage(handoff!))

    expect(message).toContain('Real CAMetalLayer IOSurface presenter is not installed')
    expect(message).toContain('Electron proof preview surface')
    expect(message).toContain('compositor frame 42')
  })

  it('accepts only live CAMetalLayer statuses that confirm the requested frame', () => {
    const handoff = compositorStatusMetalTargetHandoff(compositorStatus())

    expect(handoff).not.toBeNull()
    expect(nativeCametalLayerStatusMatchesHandoff(previewStatus(), handoff!)).toBe(true)
    expect(
      nativeCametalLayerStatusMatchesHandoff(
        previewStatus({ transport: 'electron-proof-surface' }),
        handoff!
      )
    ).toBe(false)
    expect(
      nativeCametalLayerStatusMatchesHandoff(
        previewStatus({ backing: 'electron-browser-window' }),
        handoff!
      )
    ).toBe(false)
    expect(
      nativeCametalLayerStatusMatchesHandoff(previewStatus({ presentedFrameId: 41 }), handoff!)
    ).toBe(false)
    expect(
      nativeCametalLayerStatusMatchesHandoff(
        previewStatus({ sourcePixelsPresent: false }),
        handoff!
      )
    ).toBe(false)
  })
})
