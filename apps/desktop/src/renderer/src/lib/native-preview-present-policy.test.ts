import { describe, expect, it } from 'vitest'

import type { CompositorStatus, PreviewSurfaceStatus } from './backend'
import {
  buildNativePreviewCompositorUpdateParams,
  compositorStatusCanDriveProofScene,
  compositorStatusHasRenderedSceneRevision,
  decideNativePreviewCompositorPresent,
  nativePreviewDroppedFramesWithSuppressed,
  nativePreviewSceneProofPresentationOwner,
  pendingCompositorStatusSupersedes,
  rendererFallbackCompositorStatusIsFresh,
  rendererFallbackSeedCompositorStatus,
  rendererFallbackOwnsPresentation
} from './native-preview-present-policy'

const compositorStatus = (patch: Partial<CompositorStatus> = {}): CompositorStatus => ({
  state: 'live',
  targetFps: 60,
  width: 1920,
  height: 1080,
  sceneSources: [],
  sources: [],
  framesRendered: 100,
  repeatedFrames: 0,
  droppedFrames: 0,
  updatedAt: '2026-06-13T00:00:00.000Z',
  ...patch
})

describe('native preview present policy', () => {
  it('suppresses compositor presents while recording is starting', () => {
    expect(
      decideNativePreviewCompositorPresent({
        nativePreviewSurfaceEnabled: true,
        updateCompositorAvailable: true,
        recordingState: 'starting'
      })
    ).toEqual({ kind: 'suppress-starting' })
  })

  it('does not queue presents when the native surface path is unavailable', () => {
    expect(
      decideNativePreviewCompositorPresent({
        nativePreviewSurfaceEnabled: false,
        updateCompositorAvailable: true,
        recordingState: 'idle'
      })
    ).toEqual({ kind: 'disabled' })
  })

  it('keeps Windows proof-surface polling live in fallback compositor updates while recording', () => {
    expect(
      buildNativePreviewCompositorUpdateParams(
        compositorStatus(),
        {
          nativePreviewRendererPollIntervalP95Ms: 17,
          nativePreviewRendererPollRoundTripP95Ms: 4,
          nativePreviewRendererPresentRoundTripP95Ms: 3,
          nativePreviewRendererPollInFlightSkips: 2
        },
        {
          recordingActive: true,
          windowOpen: true,
          status: {
            state: 'live',
            transport: 'electron-proof-surface',
            backing: 'electron-browser-window',
            sourcePixelsPresent: true,
            nativePreviewHostAttached: false,
            nativePreviewHostKind: 'proof-surface'
          }
        }
      )
    ).toMatchObject({
      framesRendered: 100,
      suppressFramePolling: false,
      nativePreviewRendererPollIntervalP95Ms: 17,
      nativePreviewRendererPollRoundTripP95Ms: 4,
      nativePreviewRendererPresentRoundTripP95Ms: 3,
      nativePreviewRendererPollInFlightSkips: 2
    })
  })

  it('still suppresses fallback polling when an attached CAMetalLayer owns recording pixels', () => {
    expect(
      buildNativePreviewCompositorUpdateParams(
        compositorStatus(),
        {},
        {
          recordingActive: true,
          windowOpen: true,
          status: {
            state: 'live',
            transport: 'native-surface',
            backing: 'cametal-layer',
            sourcePixelsPresent: true,
            nativePreviewHostAttached: true,
            nativePreviewHostKind: 'in-process'
          }
        }
      )
    ).toMatchObject({
      framesRendered: 100,
      suppressFramePolling: true
    })
  })

  it('lets the latest compositor status win when a newer pending run supersedes an older one', () => {
    expect(
      pendingCompositorStatusSupersedes(
        compositorStatus({ runId: 'run-2', framesRendered: 20 }),
        compositorStatus({ runId: 'run-1', framesRendered: 200 }),
        { includeSameRunFrameAdvance: false }
      )
    ).toBe(true)
  })

  it('counts newer same-run frames as superseding after reporting the presented status', () => {
    expect(
      pendingCompositorStatusSupersedes(
        compositorStatus({ runId: 'run-1', framesRendered: 101 }),
        compositorStatus({ runId: 'run-1', framesRendered: 100 }),
        { includeSameRunFrameAdvance: true }
      )
    ).toBe(true)
  })

  it('requires the rendered frame revision to catch up before scene-change presentation', () => {
    expect(
      compositorStatusHasRenderedSceneRevision(
        compositorStatus({ sceneRevision: 4, frameSceneRevision: 3 }),
        4
      )
    ).toBe(false)
    expect(
      compositorStatusHasRenderedSceneRevision(
        compositorStatus({ sceneRevision: 4, frameSceneRevision: 4 }),
        4
      )
    ).toBe(true)
  })

  it('lets the Linux CPU proof path attach once a live compositor has a screen layer', () => {
    const pendingFrame = compositorStatus({
      state: 'live',
      sceneRevision: 4,
      frameSceneRevision: 3,
      sceneSources: [
        {
          id: 'screen:portal:monitor',
          name: 'Portal monitor',
          kind: 'screen',
          state: 'referenced',
          visible: true,
          transform: {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            cropLeft: 0,
            cropTop: 0,
            cropRight: 0,
            cropBottom: 0
          },
          fit: 'cover',
          mirror: false
        }
      ]
    })
    expect(compositorStatusCanDriveProofScene(pendingFrame, 4)).toBe(false)
    expect(compositorStatusCanDriveProofScene(pendingFrame, 4, { linuxCpuProof: true })).toBe(true)
    expect(
      compositorStatusCanDriveProofScene(
        compositorStatus({
          state: 'stopped',
          sceneRevision: 4,
          sceneSources: pendingFrame.sceneSources
        }),
        4,
        { linuxCpuProof: true }
      )
    ).toBe(false)
    expect(
      compositorStatusCanDriveProofScene(
        compositorStatus({
          state: 'live',
          sceneRevision: 4,
          sceneSources: [{ ...pendingFrame.sceneSources[0], visible: false }]
        }),
        4,
        { linuxCpuProof: true }
      )
    ).toBe(false)
  })

  it('adds locally suppressed presents to native dropped-frame accounting', () => {
    expect(
      nativePreviewDroppedFramesWithSuppressed(
        {
          droppedFrames: 3
        } as PreviewSurfaceStatus,
        2
      )
    ).toBe(5)
  })

  it('keeps scene-proof presentation with main while the main pump is active', () => {
    expect(
      nativePreviewSceneProofPresentationOwner({
        mainPumpActive: true,
        statusReaderAvailable: true,
        rendererUpdaterAvailable: true
      })
    ).toBe('main-pump')
  })

  it('uses the renderer only as a fallback when the main pump is unavailable', () => {
    expect(
      nativePreviewSceneProofPresentationOwner({
        mainPumpActive: false,
        statusReaderAvailable: true,
        rendererUpdaterAvailable: true
      })
    ).toBe('renderer-fallback')
  })

  it('waits for a fresh frame event when renderer fallback takes over from main', () => {
    const cached = compositorStatus({ framesRendered: 100 })

    expect(
      rendererFallbackSeedCompositorStatus({
        wasMainPumpActive: true,
        nextMainPumpActive: false,
        latestStatus: cached
      })
    ).toBeNull()
    expect(
      rendererFallbackSeedCompositorStatus({
        wasMainPumpActive: false,
        nextMainPumpActive: false,
        latestStatus: cached
      })
    ).toBe(cached)
  })

  it('keeps renderer fallback available during an active recording', () => {
    expect(
      rendererFallbackOwnsPresentation({
        mainPumpActive: false,
        recordingState: 'recording'
      })
    ).toBe(true)
    expect(
      rendererFallbackOwnsPresentation({
        mainPumpActive: true,
        recordingState: 'recording'
      })
    ).toBe(false)
  })

  it('rejects a queued main-era status when renderer fallback takes over', () => {
    expect(
      rendererFallbackCompositorStatusIsFresh({
        fallbackActivatedAtMs: Date.parse('2026-06-13T00:00:01.000Z'),
        statusUpdatedAt: '2026-06-13T00:00:00.999Z'
      })
    ).toBe(false)
    expect(
      rendererFallbackCompositorStatusIsFresh({
        fallbackActivatedAtMs: Date.parse('2026-06-13T00:00:01.000Z'),
        statusUpdatedAt: '2026-06-13T00:00:01.001Z'
      })
    ).toBe(true)
  })

  it('allows status-only compatibility before main has ever owned presentation', () => {
    expect(
      rendererFallbackCompositorStatusIsFresh({
        fallbackActivatedAtMs: 0,
        statusUpdatedAt: compositorStatus().updatedAt
      })
    ).toBe(true)
  })
})
