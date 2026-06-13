import { describe, expect, it } from 'vitest'

import type { CompositorStatus, PreviewSurfaceStatus } from './backend'
import {
  buildNativePreviewCompositorUpdateParams,
  decideNativePreviewCompositorPresent,
  nativePreviewDroppedFramesWithSuppressed,
  pendingCompositorStatusSupersedes
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

  it('suppresses frame polling during active recording states', () => {
    expect(
      buildNativePreviewCompositorUpdateParams(compositorStatus(), 'recording', {
        nativePreviewRendererPollIntervalP95Ms: 17,
        nativePreviewRendererPollRoundTripP95Ms: 4,
        nativePreviewRendererPresentRoundTripP95Ms: 3,
        nativePreviewRendererPollInFlightSkips: 2
      })
    ).toMatchObject({
      framesRendered: 100,
      suppressFramePolling: true,
      nativePreviewRendererPollIntervalP95Ms: 17,
      nativePreviewRendererPollRoundTripP95Ms: 4,
      nativePreviewRendererPresentRoundTripP95Ms: 3,
      nativePreviewRendererPollInFlightSkips: 2
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
})
