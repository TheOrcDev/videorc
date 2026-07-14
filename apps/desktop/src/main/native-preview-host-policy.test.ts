import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceStatus } from '../shared/backend'
import {
  nativePreviewClosedWindowUnsuppressStatus,
  nativePreviewDriverFailureFallbackStatus,
  nativePreviewValidatedHandoffStatus,
  nativePreviewPresentFailureDisposition,
  nativePreviewPlacementOwnedByNativeSurface,
  nativePreviewFramePollingSuppressionStatus,
  nativePreviewHelperFallbackAllowed,
  nativePreviewProofPollingSuppressed,
  nativePreviewSupervisorFallbackReason,
  nativePreviewSupervisorDisposition
} from './native-preview-host-policy'

describe('native preview host policy', () => {
  it('stamps the main-validated scene revision and run onto external presenter status', () => {
    expect(
      nativePreviewValidatedHandoffStatus(
        surfaceStatus({
          nativePreviewHostKind: 'external-module',
          nativePreviewPresentedSceneRevision: 2,
          nativePreviewCompositorRunId: 'stale-run'
        }),
        { sceneRevision: 8, runId: 'current-run' }
      )
    ).toMatchObject({
      nativePreviewPresentedSceneRevision: 8,
      nativePreviewCompositorRunId: 'current-run'
    })
  })

  it('treats a hidden in-process present skip as benign instead of a failure', () => {
    expect(
      nativePreviewPresentFailureDisposition({
        driverKind: 'in-process',
        surfaceVisible: false,
        presentValidated: false,
        consecutiveFailures: 2,
        failureThreshold: 3
      })
    ).toBe('benign-skip')
  })

  it('disables a visible in-process presenter at the bounded failure threshold', () => {
    expect(
      nativePreviewPresentFailureDisposition({
        driverKind: 'in-process',
        surfaceVisible: true,
        presentValidated: false,
        consecutiveFailures: 2,
        failureThreshold: 3
      })
    ).toBe('disable-native')
    expect(
      nativePreviewPresentFailureDisposition({
        driverKind: 'in-process',
        surfaceVisible: true,
        presentValidated: false,
        consecutiveFailures: 1,
        failureThreshold: 3
      })
    ).toBe('retain-native')
  })

  it('keeps an attached in-process surface in charge of placement after present activity pauses', () => {
    expect(
      nativePreviewPlacementOwnedByNativeSurface({
        status: surfaceStatus({
          nativePreviewHostKind: 'in-process',
          nativePreviewHostAttached: true,
          sourcePixelsPresent: true
        }),
        driverKind: 'in-process',
        recentPresent: false
      })
    ).toBe(true)
  })

  it('does not launch the separate helper on the normal production path', () => {
    expect(nativePreviewHelperFallbackAllowed({})).toBe(false)
    expect(nativePreviewHelperFallbackAllowed({ fallbackFlag: '0' })).toBe(false)
  })

  it('allows the transitional helper only through an explicit diagnostic route', () => {
    expect(nativePreviewHelperFallbackAllowed({ fallbackFlag: '1' })).toBe(true)
    expect(nativePreviewHelperFallbackAllowed({ explicitHelperPath: '/tmp/helper' })).toBe(true)
  })

  it('treats the supported Windows proof presenter as live', () => {
    expect(
      nativePreviewSupervisorDisposition(
        surfaceStatus({
          transport: 'electron-proof-surface',
          backing: 'electron-browser-window',
          firstFrameContract: 'met'
        }),
        'win32'
      )
    ).toBe('live')
  })

  it('keeps the Windows proof presenter pending until its first-frame contract is met', () => {
    const proof = surfaceStatus({
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window'
    })
    expect(nativePreviewSupervisorDisposition(proof, 'win32')).toBe('pending')
    expect(
      nativePreviewSupervisorDisposition({ ...proof, firstFrameContract: 'pending' }, 'win32')
    ).toBe('pending')
  })

  it('keeps macOS proof presentation and a stalled Windows presenter truthful', () => {
    const proof = surfaceStatus({
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      firstFrameContract: 'met'
    })
    expect(nativePreviewSupervisorDisposition(proof, 'darwin')).toBe('fallback')
    expect(
      nativePreviewSupervisorDisposition({ ...proof, firstFrameContract: 'fallback' }, 'win32')
    ).toBe('fallback')
  })

  it('uses the Windows first-frame stall diagnosis instead of healthy compositor copy', () => {
    expect(
      nativePreviewSupervisorFallbackReason(
        surfaceStatus({
          transport: 'electron-proof-surface',
          firstFrameContract: 'fallback',
          firstFrameReason: 'Windows preview source frames stopped advancing.'
        }),
        'win32',
        'Preview is displaying compositor output.'
      )
    ).toBe('Windows preview source frames stopped advancing.')
  })

  it('suppresses only the Electron poller while an attached CAMetalLayer keeps presenting', () => {
    expect(
      nativePreviewFramePollingSuppressionStatus(
        surfaceStatus({
          transport: 'native-surface',
          backing: 'cametal-layer',
          nativePreviewHostKind: 'in-process',
          nativePreviewHostAttached: true,
          sourcePixelsPresent: true
        }),
        true
      )
    ).toMatchObject({
      framePollingSuppressed: true,
      sourcePixelsPresent: true,
      nativePreviewHostKind: 'in-process',
      nativePreviewHostAttached: true,
      transport: 'native-surface',
      backing: 'cametal-layer'
    })
  })

  it('marks Electron proof pixels absent when its frame poller is suppressed', () => {
    expect(
      nativePreviewFramePollingSuppressionStatus(
        surfaceStatus({
          transport: 'electron-proof-surface',
          backing: 'electron-browser-window',
          nativePreviewHostKind: 'proof-surface',
          nativePreviewHostAttached: false,
          sourcePixelsPresent: true
        }),
        true
      )
    ).toMatchObject({
      framePollingSuppressed: true,
      sourcePixelsPresent: false,
      nativePreviewHostKind: 'proof-surface'
    })
  })

  it('turns off hidden proof polling while the native layer owns presentation', () => {
    expect(
      nativePreviewProofPollingSuppressed({
        lifecycleSuppressed: false,
        nativeSurfaceOwnsPresentation: true
      })
    ).toBe(true)
    expect(
      nativePreviewProofPollingSuppressed({
        lifecycleSuppressed: false,
        nativeSurfaceOwnsPresentation: false
      })
    ).toBe(false)
    expect(
      nativePreviewProofPollingSuppressed({
        lifecycleSuppressed: true,
        nativeSurfaceOwnsPresentation: false
      })
    ).toBe(true)
  })

  it('keeps the visible proof fallback polling after a native driver failure during recording', () => {
    expect(
      nativePreviewProofPollingSuppressed({
        lifecycleSuppressed: true,
        nativeSurfaceOwnsPresentation: false,
        nativeFailureFallbackActive: true
      })
    ).toBe(false)
  })

  it('returns a complete suppressed status for stale post-close unsuppress and resumes on reopen', () => {
    const closed = nativePreviewClosedWindowUnsuppressStatus(
      surfaceStatus({
        transport: 'electron-proof-surface',
        backing: 'electron-browser-window',
        nativePreviewHostKind: 'proof-surface',
        nativePreviewHostAttached: false
      })
    )

    expect(closed).toMatchObject({
      state: 'live',
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      framePollingSuppressed: true,
      sourcePixelsPresent: false
    })
    expect(typeof closed).toBe('object')

    const reopened = nativePreviewFramePollingSuppressionStatus(closed, false)
    expect(reopened).toMatchObject({
      framePollingSuppressed: false,
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window'
    })
  })

  it('stops claiming attached native pixels after the native driver is destroyed', () => {
    expect(
      nativePreviewDriverFailureFallbackStatus(
        surfaceStatus({
          nativePreviewHostKind: 'in-process',
          nativePreviewHostAttached: true,
          sourcePixelsPresent: true
        }),
        {
          reason: 'native presenter failed',
          framePollingSuppressed: false
        }
      )
    ).toMatchObject({
      state: 'live',
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      framePollingSuppressed: false,
      sourcePixelsPresent: false,
      nativePreviewHostKind: 'proof-surface',
      nativePreviewHostAttached: false,
      message: 'native presenter failed'
    })
  })
})

function surfaceStatus(patch: Partial<PreviewSurfaceStatus>): PreviewSurfaceStatus {
  return {
    state: 'live',
    source: 'camera',
    transport: 'native-surface',
    backing: 'cametal-layer',
    targetFps: 60,
    width: 960,
    height: 540,
    framesRendered: 12,
    presentedFrameId: 12,
    droppedFrames: 0,
    framePollingSuppressed: false,
    sourcePixelsPresent: true,
    pendingHostCommandCount: 0,
    updatedAt: '2026-07-09T00:00:00.000Z',
    ...patch
  }
}
