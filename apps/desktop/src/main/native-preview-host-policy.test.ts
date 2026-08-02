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
  reconcileWindowsD3d11PresenterStatus,
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

  it('treats the Windows D3D11 presenter as live only after first-present liveness', () => {
    expect(
      nativePreviewSupervisorDisposition(
        surfaceStatus({
          transport: 'd3d11-shared-texture',
          backing: 'directcomposition-swapchain',
          nativePreviewHostKind: 'backend-d3d11-presenter',
          firstFrameContract: 'met'
        }),
        'win32'
      )
    ).toBe('live')
  })

  it('keeps the Windows D3D11 presenter pending until its first-frame contract is met', () => {
    const d3d11 = surfaceStatus({
      transport: 'd3d11-shared-texture',
      backing: 'directcomposition-swapchain',
      nativePreviewHostKind: 'backend-d3d11-presenter'
    })
    expect(nativePreviewSupervisorDisposition(d3d11, 'win32')).toBe('pending')
    expect(
      nativePreviewSupervisorDisposition({ ...d3d11, firstFrameContract: 'pending' }, 'win32')
    ).toBe('pending')
  })

  it('keeps proof presentation and a stalled Windows D3D11 presenter truthful', () => {
    const proof = surfaceStatus({
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      firstFrameContract: 'met'
    })
    expect(nativePreviewSupervisorDisposition(proof, 'darwin')).toBe('fallback')
    expect(nativePreviewSupervisorDisposition(proof, 'win32')).toBe('fallback')
    expect(
      nativePreviewSupervisorDisposition(
        {
          ...proof,
          transport: 'd3d11-shared-texture',
          backing: 'directcomposition-swapchain',
          nativePreviewHostKind: 'backend-d3d11-presenter',
          firstFrameContract: 'fallback'
        },
        'win32'
      )
    ).toBe('fallback')
  })

  it('uses the Windows first-frame stall diagnosis instead of healthy compositor copy', () => {
    expect(
      nativePreviewSupervisorFallbackReason(
        surfaceStatus({
          transport: 'd3d11-shared-texture',
          backing: 'directcomposition-swapchain',
          nativePreviewHostKind: 'backend-d3d11-presenter',
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

  it('lets an attached backend D3D11 presenter own placement without a JS driver', () => {
    const status = surfaceStatus({
      transport: 'd3d11-shared-texture',
      backing: 'directcomposition-swapchain',
      nativePreviewHostKind: 'backend-d3d11-presenter',
      nativePreviewHostAttached: true,
      sourcePixelsPresent: true
    })
    expect(
      nativePreviewPlacementOwnedByNativeSurface({
        status,
        driverKind: null,
        recentPresent: false,
        platform: 'win32'
      })
    ).toBe(true)
    expect(nativePreviewFramePollingSuppressionStatus(status, true, 'win32')).toMatchObject({
      framePollingSuppressed: true,
      sourcePixelsPresent: true,
      transport: 'd3d11-shared-texture',
      backing: 'directcomposition-swapchain'
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

  it('adopts the backend D3D11 triple only after all first-present evidence is true', () => {
    const current = surfaceStatus({
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      nativePreviewHostKind: 'proof-surface',
      nativePreviewHostAttached: false,
      sourcePixelsPresent: true
    })
    const canonical = reconcileWindowsD3d11PresenterStatus(current, d3d11BackendStatus(), {
      platform: 'win32',
      previewWindowOpen: true,
      generation: 7,
      trustedGeneration: 7
    })

    expect(canonical).toMatchObject({
      transport: 'd3d11-shared-texture',
      backing: 'directcomposition-swapchain',
      nativePreviewHostKind: 'backend-d3d11-presenter',
      nativePreviewHostAttached: true,
      framePollingSuppressed: true,
      sourcePixelsPresent: true,
      firstFrameContract: 'met',
      presentedFrameId: 42
    })
    expect(canonical.windowsD3d11Presenter).toMatchObject({
      firstPresentSucceeded: true,
      sourceLive: true,
      sameAdapter: true
    })

    const waiting = reconcileWindowsD3d11PresenterStatus(
      current,
      d3d11BackendStatus({
        sourceLive: false,
        fallbackReason: 'windows-d3d11-preview-source-stalled'
      }),
      {
        platform: 'win32',
        previewWindowOpen: true,
        generation: 7,
        trustedGeneration: 7
      }
    )
    expect(waiting).toMatchObject({
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      nativePreviewHostKind: 'proof-surface',
      nativePreviewHostAttached: false,
      framePollingSuppressed: false
    })

    const stale = reconcileWindowsD3d11PresenterStatus(
      current,
      d3d11BackendStatus({ previewGeneration: 6 }),
      {
        platform: 'win32',
        previewWindowOpen: true,
        generation: 7,
        trustedGeneration: 7
      }
    )
    expect(stale).toEqual(current)
  })

  it('ignores a retired-generation event instead of revoking the current presenter', () => {
    const canonical = reconcileWindowsD3d11PresenterStatus(
      surfaceStatus({
        transport: 'electron-proof-surface',
        backing: 'electron-browser-window',
        nativePreviewHostKind: 'proof-surface',
        nativePreviewHostAttached: false
      }),
      d3d11BackendStatus(),
      {
        platform: 'win32',
        previewWindowOpen: true,
        generation: 7,
        trustedGeneration: 7
      }
    )

    const afterStaleFallback = reconcileWindowsD3d11PresenterStatus(
      canonical,
      d3d11BackendStatus({
        previewGeneration: 6,
        sourceLive: false,
        firstPresentSucceeded: false,
        fallbackReason: 'retired-presenter-stopped'
      }),
      {
        platform: 'win32',
        previewWindowOpen: true,
        generation: 7,
        trustedGeneration: 7
      }
    )

    expect(afterStaleFallback).toEqual(canonical)
    expect(afterStaleFallback.nativePreviewHostKind).toBe('backend-d3d11-presenter')
  })

  it('publishes an explicit first-frame fallback for a current-generation presenter failure', () => {
    const fallback = reconcileWindowsD3d11PresenterStatus(
      surfaceStatus({
        transport: 'd3d11-shared-texture',
        backing: 'directcomposition-swapchain',
        nativePreviewHostKind: 'backend-d3d11-presenter',
        nativePreviewHostAttached: true,
        firstFrameContract: 'met'
      }),
      d3d11BackendStatus({
        sourceLive: false,
        firstPresentSucceeded: false,
        fallbackReason: 'windows-d3d11-preview-source-stalled'
      }),
      {
        platform: 'win32',
        previewWindowOpen: true,
        generation: 7,
        trustedGeneration: 7
      }
    )

    expect(fallback).toMatchObject({
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      nativePreviewHostKind: 'proof-surface',
      firstFrameContract: 'fallback',
      firstFrameReason: 'windows-d3d11-preview-source-stalled'
    })
  })

  it('keeps same-generation presenter transitions monotonic across socket reordering', () => {
    const fallback = reconcileWindowsD3d11PresenterStatus(
      surfaceStatus({
        transport: 'd3d11-shared-texture',
        backing: 'directcomposition-swapchain',
        nativePreviewHostKind: 'backend-d3d11-presenter',
        nativePreviewHostAttached: true
      }),
      d3d11BackendStatus({
        successfulPresents: 42,
        sourceLive: false,
        firstPresentSucceeded: false,
        fallbackReason: 'device-reset'
      }),
      {
        platform: 'win32',
        previewWindowOpen: true,
        generation: 7,
        trustedGeneration: 7
      }
    )

    const afterOlderCanonical = reconcileWindowsD3d11PresenterStatus(
      fallback,
      d3d11BackendStatus({ successfulPresents: 42, lastPresentedSequence: 42 }),
      {
        platform: 'win32',
        previewWindowOpen: true,
        generation: 7,
        trustedGeneration: 7
      }
    )
    expect(afterOlderCanonical).toEqual(fallback)

    const recovered = reconcileWindowsD3d11PresenterStatus(
      fallback,
      d3d11BackendStatus({ successfulPresents: 43, lastPresentedSequence: 43 }),
      {
        platform: 'win32',
        previewWindowOpen: true,
        generation: 7,
        trustedGeneration: 7
      }
    )
    expect(recovered).toMatchObject({
      nativePreviewHostKind: 'backend-d3d11-presenter',
      presentedFrameId: 43
    })
    expect(recovered.windowsD3d11Presenter?.successfulPresents).toBe(43)
  })

  it('clears D3D11 presenter evidence on stop or lifecycle-generation change', () => {
    const canonical = reconcileWindowsD3d11PresenterStatus(
      surfaceStatus({
        transport: 'electron-proof-surface',
        backing: 'electron-browser-window',
        nativePreviewHostKind: 'proof-surface',
        nativePreviewHostAttached: false
      }),
      d3d11BackendStatus(),
      {
        platform: 'win32',
        previewWindowOpen: true,
        generation: 7,
        trustedGeneration: 7
      }
    )

    for (const input of [
      {
        platform: 'win32' as const,
        previewWindowOpen: false,
        generation: 7,
        trustedGeneration: 7
      },
      {
        platform: 'win32' as const,
        previewWindowOpen: true,
        generation: 8,
        trustedGeneration: 7
      }
    ]) {
      expect(reconcileWindowsD3d11PresenterStatus(canonical, null, input)).toMatchObject({
        transport: 'electron-proof-surface',
        backing: 'electron-browser-window',
        nativePreviewHostKind: 'proof-surface',
        nativePreviewHostAttached: false,
        framePollingSuppressed: false,
        sourcePixelsPresent: false
      })
      expect(
        reconcileWindowsD3d11PresenterStatus(canonical, null, input).windowsD3d11Presenter
      ).toBeUndefined()
    }
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

function d3d11BackendStatus(
  presenterPatch: Partial<NonNullable<PreviewSurfaceStatus['windowsD3d11Presenter']>> = {}
): PreviewSurfaceStatus {
  return surfaceStatus({
    transport: 'd3d11-shared-texture',
    backing: 'directcomposition-swapchain',
    presentedFrameId: 42,
    windowsD3d11Presenter: {
      layered: true,
      transparent: true,
      noActivate: true,
      excludedFromCapture: true,
      windowActive: false,
      windowFocused: false,
      previewGeneration: 7,
      generationMatches: true,
      ownerProcessMatches: true,
      sameAdapter: true,
      sourceLive: true,
      firstPresentSucceeded: true,
      successfulPresents: 42,
      lastPresentedSequence: 42,
      latestWinsDrops: 0,
      hiddenDrops: 0,
      busyDrops: 0,
      staleFrameDrops: 0,
      ...presenterPatch
    }
  })
}
