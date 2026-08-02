import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceStatus } from '../shared/backend'
import {
  nativePreviewClosedWindowUnsuppressStatus,
  nativePreviewDriverFailureFallbackStatus,
  nativePreviewValidatedHandoffStatus,
  nativePreviewPresentFailureDisposition,
  nativePreviewPlacementOwnedByNativeSurface,
  nativePreviewFramePollingSuppressionStatus,
  nativePreviewFramePollingSuppressionGenerationMatches,
  nativePreviewHelperFallbackAllowed,
  nativePreviewLifecycleFramePollingSuppressed,
  nativePreviewProofPollingSuppressed,
  reconcileWindowsD3d11PresenterStatus,
  nativePreviewSupervisorFallbackReason,
  nativePreviewSupervisorDisposition,
  windowsD3d11BackendEventAuthority,
  windowsD3d11BackendStatusIsStale
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
        {
          ...d3d11BackendStatus(),
          nativePreviewHostKind: 'backend-d3d11-presenter',
          nativePreviewHostAttached: true,
          sourcePixelsPresent: true,
          firstFrameContract: 'met'
        },
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
    const status = reconcileWindowsD3d11PresenterStatus(
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
        proofSurfaceAvailable: true,
        generation: 7,
        trustedGeneration: 7
      }
    )
    expect(status).toMatchObject({
      nativePreviewHostKind: 'backend-d3d11-presenter',
      nativePreviewHostAttached: true,
      sourcePixelsPresent: true
    })
    expect(
      nativePreviewPlacementOwnedByNativeSurface({
        status,
        driverKind: null,
        recentPresent: false,
        platform: 'win32',
        generation: 7
      })
    ).toBe(true)
    expect(
      nativePreviewPlacementOwnedByNativeSurface({
        status,
        driverKind: null,
        recentPresent: false,
        platform: 'win32',
        generation: 8
      })
    ).toBe(false)
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

  it('suppresses polling for a closed preview lifecycle and resumes it while open', () => {
    expect(nativePreviewLifecycleFramePollingSuppressed(false)).toBe(true)
    expect(nativePreviewLifecycleFramePollingSuppressed(true)).toBe(false)
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
      state: 'unavailable',
      transport: 'unavailable',
      backing: 'none',
      framePollingSuppressed: true,
      sourcePixelsPresent: false,
      nativePreviewHostAttached: false
    })
    expect(typeof closed).toBe('object')

    const reopened = nativePreviewFramePollingSuppressionStatus(closed, false)
    expect(reopened).toMatchObject({
      framePollingSuppressed: false,
      transport: 'unavailable',
      backing: 'none'
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

    const afterStaleFailure = reconcileWindowsD3d11PresenterStatus(
      canonical,
      {
        ...d3d11BackendStatus({
          previewGeneration: 6,
          sourceLive: false,
          firstPresentSucceeded: false,
          fallbackReason: 'retired-presenter-failed'
        }),
        state: 'failed'
      },
      {
        platform: 'win32',
        previewWindowOpen: true,
        generation: 7,
        trustedGeneration: 7
      }
    )
    expect(afterStaleFailure).toEqual(canonical)
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

  it('retires a canonical claim when a newer pre-present backend failure resets counters', () => {
    const previousBackend = d3d11BackendStatus()
    const canonical = reconcileWindowsD3d11PresenterStatus(
      surfaceStatus({
        transport: 'electron-proof-surface',
        backing: 'electron-browser-window',
        nativePreviewHostKind: 'proof-surface'
      }),
      previousBackend,
      {
        platform: 'win32',
        previewWindowOpen: true,
        proofSurfaceAvailable: true,
        generation: 7,
        trustedGeneration: 7
      }
    )
    const failedBeforePresent = {
      ...d3d11BackendStatus({
        mediaGeneration: 12,
        successfulPresents: 0,
        lastPresentedSequence: undefined,
        sourceLive: false,
        firstPresentSucceeded: false,
        fallbackReason: 'present-before-first-frame-failed'
      }),
      state: 'failed' as const,
      updatedAt: '2026-07-09T00:00:01.000Z',
      message: 'The D3D11 presenter failed before Present.'
    }

    expect(windowsD3d11BackendStatusIsStale(previousBackend, failedBeforePresent, 7)).toBe(false)
    expect(
      reconcileWindowsD3d11PresenterStatus(canonical, failedBeforePresent, {
        platform: 'win32',
        previewWindowOpen: true,
        proofSurfaceAvailable: true,
        generation: 7,
        trustedGeneration: 7
      })
    ).toMatchObject({
      state: 'failed',
      transport: 'unavailable',
      backing: 'none',
      nativePreviewHostAttached: false,
      sourcePixelsPresent: false,
      message: 'The D3D11 presenter failed before Present.'
    })
  })

  it('orders presenter authority by generation and progress, never wall-clock time', () => {
    const current = d3d11BackendStatus({ mediaGeneration: 12 })
    const lowerAuthorityWithFutureTimestamp = {
      ...d3d11BackendStatus({
        mediaGeneration: 11,
        successfulPresents: 999,
        lastPresentedSequence: 999
      }),
      updatedAt: '2099-01-01T00:00:00.000Z'
    }
    const newerAuthorityWithOldTimestamp = {
      ...d3d11BackendStatus({
        mediaGeneration: 13,
        successfulPresents: 0,
        lastPresentedSequence: undefined,
        sourceLive: false,
        firstPresentSucceeded: false,
        fallbackReason: 'new-authority-failed-before-present'
      }),
      updatedAt: '2000-01-01T00:00:00.000Z'
    }
    const regressedProgressWithFutureTimestamp = {
      ...d3d11BackendStatus({
        mediaGeneration: 12,
        successfulPresents: 41,
        lastPresentedSequence: 41
      }),
      updatedAt: '2099-01-01T00:00:00.000Z'
    }
    const advancedProgressWithOldTimestamp = {
      ...d3d11BackendStatus({
        mediaGeneration: 12,
        successfulPresents: 43,
        lastPresentedSequence: 43
      }),
      updatedAt: '2000-01-01T00:00:00.000Z'
    }

    expect(windowsD3d11BackendStatusIsStale(current, lowerAuthorityWithFutureTimestamp, 7)).toBe(
      true
    )
    expect(windowsD3d11BackendStatusIsStale(current, newerAuthorityWithOldTimestamp, 7)).toBe(false)
    expect(windowsD3d11BackendStatusIsStale(current, regressedProgressWithFutureTimestamp, 7)).toBe(
      true
    )
    expect(windowsD3d11BackendStatusIsStale(current, advancedProgressWithOldTimestamp, 7)).toBe(
      false
    )
    expect(
      windowsD3d11BackendStatusIsStale(current, d3d11BackendStatus({ previewGeneration: 6 }), 7)
    ).toBe(true)
  })

  it('accepts an equal-progress explicit failure but rejects lower retired progress', () => {
    const previousBackend = d3d11BackendStatus()
    const canonical = reconcileWindowsD3d11PresenterStatus(
      surfaceStatus({
        transport: 'electron-proof-surface',
        backing: 'electron-browser-window',
        nativePreviewHostKind: 'proof-surface'
      }),
      previousBackend,
      {
        platform: 'win32',
        previewWindowOpen: true,
        proofSurfaceAvailable: true,
        generation: 7,
        trustedGeneration: 7
      }
    )
    const explicitFailure = d3d11BackendStatus({
      sourceLive: false,
      firstPresentSucceeded: false,
      fallbackReason: 'same-generation-presenter-failed'
    })
    const lowerRetiredFailure = d3d11BackendStatus({
      successfulPresents: 41,
      lastPresentedSequence: 41,
      sourceLive: false,
      firstPresentSucceeded: false,
      fallbackReason: 'retired-presenter-failed'
    })

    expect(windowsD3d11BackendStatusIsStale(previousBackend, explicitFailure, 7)).toBe(false)
    expect(windowsD3d11BackendStatusIsStale(previousBackend, lowerRetiredFailure, 7)).toBe(true)
    expect(
      reconcileWindowsD3d11PresenterStatus(canonical, explicitFailure, {
        platform: 'win32',
        previewWindowOpen: true,
        proofSurfaceAvailable: true,
        generation: 7,
        trustedGeneration: 7
      })
    ).toMatchObject({
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      nativePreviewHostKind: 'proof-surface',
      firstFrameContract: 'fallback'
    })
  })

  it('rejects generationless backend events and stale polling-suppression requests', () => {
    expect(windowsD3d11BackendEventAuthority(surfaceStatus({}))).toBeNull()
    expect(
      windowsD3d11BackendEventAuthority(d3d11BackendStatus({ previewGeneration: undefined }))
    ).toBeNull()
    expect(windowsD3d11BackendEventAuthority(d3d11BackendStatus())).toEqual({
      previewGeneration: 7,
      mediaGeneration: 11
    })
    expect(nativePreviewFramePollingSuppressionGenerationMatches(7, 7)).toBe(true)
    expect(nativePreviewFramePollingSuppressionGenerationMatches(7, 8)).toBe(false)
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

  it('clears D3D11 presenter evidence without inventing a headless proof fallback', () => {
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

    const closed = reconcileWindowsD3d11PresenterStatus(canonical, null, {
      platform: 'win32',
      previewWindowOpen: false,
      proofSurfaceAvailable: false,
      generation: 7,
      trustedGeneration: 7
    })
    expect(closed).toMatchObject({
      state: 'unavailable',
      transport: 'unavailable',
      backing: 'none',
      nativePreviewHostKind: undefined,
      nativePreviewHostAttached: false,
      framePollingSuppressed: true,
      sourcePixelsPresent: false
    })
    expect(closed.windowsD3d11Presenter).toBeUndefined()

    const reopened = reconcileWindowsD3d11PresenterStatus(canonical, null, {
      platform: 'win32',
      previewWindowOpen: true,
      proofSurfaceAvailable: true,
      generation: 8,
      trustedGeneration: 7
    })
    expect(reopened).toMatchObject({
      state: 'live',
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      nativePreviewHostKind: 'proof-surface',
      nativePreviewHostAttached: false,
      framePollingSuppressed: false,
      sourcePixelsPresent: false
    })
    expect(reopened.windowsD3d11Presenter).toBeUndefined()

    const headless = reconcileWindowsD3d11PresenterStatus(canonical, null, {
      platform: 'win32',
      previewWindowOpen: true,
      proofSurfaceAvailable: false,
      generation: 7,
      trustedGeneration: null
    })
    expect(headless).toMatchObject({
      state: 'unavailable',
      transport: 'unavailable',
      backing: 'none',
      nativePreviewHostKind: undefined,
      nativePreviewHostAttached: false,
      framePollingSuppressed: true,
      sourcePixelsPresent: false
    })
  })

  it('preserves stopped backend teardown truth instead of relabeling it as proof-live', () => {
    const stopped = reconcileWindowsD3d11PresenterStatus(
      d3d11BackendStatus(),
      {
        ...surfaceStatus({}),
        state: 'stopped',
        transport: 'unavailable',
        backing: 'none',
        windowsD3d11Presenter: undefined,
        sourcePixelsPresent: false,
        updatedAt: '2026-07-09T00:00:03.000Z',
        message: 'Preview surface stopped.'
      },
      {
        platform: 'win32',
        previewWindowOpen: true,
        proofSurfaceAvailable: true,
        generation: 7,
        trustedGeneration: 7
      }
    )

    expect(stopped).toMatchObject({
      state: 'stopped',
      transport: 'unavailable',
      backing: 'none',
      nativePreviewHostKind: undefined,
      nativePreviewHostAttached: false,
      sourcePixelsPresent: false,
      message: 'Preview surface stopped.'
    })
    expect(nativePreviewSupervisorDisposition(stopped, 'win32')).toBe('failed')
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
      mediaGeneration: 11,
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
