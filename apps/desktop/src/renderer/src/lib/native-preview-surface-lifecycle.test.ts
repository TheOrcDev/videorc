import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceStatus } from '../../../shared/backend'
import {
  mergePreviewSurfaceHostStatus,
  nativePreviewFramePollingRequestKey,
  nativePreviewFramePollingResponseCanCommit,
  nativePreviewFramePollingShouldSuppress,
  nativePreviewMainStatusReadGenerationMatches,
  previewSurfaceStatusWithoutMainAuthority,
  previewSurfaceStatusRequiresMainAuthority,
  nativePreviewSurfaceSyncCanCommit,
  nativePreviewSurfaceSyncNeedsCreate
} from './native-preview-surface-lifecycle'

describe('native preview surface lifecycle', () => {
  it('keeps the Windows proof surface polling while a recording is active', () => {
    expect(
      nativePreviewFramePollingShouldSuppress({
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
      })
    ).toBe(false)
  })

  it('suppresses the hidden proof poller when an attached CAMetalLayer owns pixels', () => {
    expect(
      nativePreviewFramePollingShouldSuppress({
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
      })
    ).toBe(true)
  })

  it('suppresses proof polling for the canonical Windows D3D11 presenter', () => {
    expect(
      nativePreviewFramePollingShouldSuppress({
        recordingActive: true,
        windowOpen: true,
        platform: 'win32',
        generation: 7,
        status: canonicalWindowsStatus()
      })
    ).toBe(true)
    expect(
      nativePreviewFramePollingShouldSuppress({
        recordingActive: true,
        windowOpen: true,
        platform: 'win32',
        generation: 8,
        status: canonicalWindowsStatus()
      })
    ).toBe(false)
  })

  it('keeps proof ownership when the D3D11 triple lacks canonical presenter evidence', () => {
    expect(
      nativePreviewFramePollingShouldSuppress({
        recordingActive: true,
        windowOpen: true,
        platform: 'win32',
        generation: 7,
        status: {
          ...canonicalWindowsStatus(),
          windowsD3d11Presenter: {
            ...canonicalWindowsStatus().windowsD3d11Presenter!,
            sourceLive: false,
            fallbackReason: 'source-stalled'
          }
        }
      })
    ).toBe(false)
  })

  it('does not mistake a Metal host for native Windows presentation', () => {
    expect(
      nativePreviewFramePollingShouldSuppress({
        recordingActive: true,
        windowOpen: true,
        platform: 'win32',
        status: {
          state: 'live',
          transport: 'native-surface',
          backing: 'cametal-layer',
          sourcePixelsPresent: true,
          nativePreviewHostAttached: true,
          nativePreviewHostKind: 'in-process'
        }
      })
    ).toBe(false)
  })

  it('routes every D3D11 presenter transition through Electron main authority', () => {
    expect(
      previewSurfaceStatusRequiresMainAuthority({
        transport: 'd3d11-shared-texture',
        backing: 'directcomposition-swapchain',
        nativePreviewHostKind: undefined,
        windowsD3d11Presenter: undefined
      })
    ).toBe(true)
    expect(
      previewSurfaceStatusRequiresMainAuthority({
        transport: 'electron-proof-surface',
        backing: 'electron-browser-window',
        nativePreviewHostKind: 'proof-surface',
        windowsD3d11Presenter: {
          fallbackReason: 'presenter-stopped'
        } as PreviewSurfaceStatus['windowsD3d11Presenter']
      })
    ).toBe(true)
    expect(
      previewSurfaceStatusRequiresMainAuthority({
        transport: 'electron-proof-surface',
        backing: 'electron-browser-window',
        nativePreviewHostKind: 'proof-surface',
        windowsD3d11Presenter: undefined
      })
    ).toBe(true)
  })

  it('fails raw D3D11 status closed when Electron main authority cannot be read', () => {
    expect(previewSurfaceStatusWithoutMainAuthority(canonicalWindowsStatus())).toMatchObject({
      state: 'unavailable',
      transport: 'unavailable',
      backing: 'none',
      nativePreviewHostKind: undefined,
      nativePreviewHostAttached: false,
      sourcePixelsPresent: false,
      framePollingSuppressed: true
    })
  })

  it('fails raw proof fallback inactive when main authority cannot be read', () => {
    const proof = previewSurfaceStatusWithoutMainAuthority({
      ...canonicalWindowsStatus(),
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      nativePreviewHostKind: 'proof-surface',
      nativePreviewHostAttached: false,
      framePollingSuppressed: false,
      windowsD3d11Presenter: canonicalWindowsStatus().windowsD3d11Presenter
    })

    expect(proof).toMatchObject({
      state: 'unavailable',
      transport: 'unavailable',
      backing: 'none',
      nativePreviewHostKind: undefined,
      nativePreviewHostAttached: false,
      sourcePixelsPresent: false,
      framePollingSuppressed: true
    })
    expect(proof.windowsD3d11Presenter).toBeUndefined()

    const inconsistentStoppedClaim = previewSurfaceStatusWithoutMainAuthority({
      ...canonicalWindowsStatus(),
      state: 'stopped',
      transport: 'unavailable',
      sourcePixelsPresent: false
    })
    expect(inconsistentStoppedClaim).toMatchObject({
      state: 'stopped',
      transport: 'unavailable',
      backing: 'none',
      nativePreviewHostKind: undefined,
      nativePreviewHostAttached: false,
      sourcePixelsPresent: false
    })
    expect(inconsistentStoppedClaim.windowsD3d11Presenter).toBeUndefined()
  })

  it('lets main host truth override raw backend D3D ownership and preserves terminal teardown', () => {
    const backend = canonicalWindowsStatus()
    const proofHost = {
      ...backend,
      transport: 'electron-proof-surface' as const,
      backing: 'electron-browser-window' as const,
      nativePreviewHostKind: 'proof-surface' as const,
      nativePreviewHostAttached: false,
      framePollingSuppressed: false,
      sourcePixelsPresent: false,
      windowsD3d11Presenter: undefined
    }
    const fallback = mergePreviewSurfaceHostStatus(backend, proofHost)
    expect(fallback).toMatchObject({
      state: 'live',
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      nativePreviewHostKind: 'proof-surface',
      nativePreviewHostAttached: false,
      framePollingSuppressed: false,
      sourcePixelsPresent: false
    })
    expect(fallback.windowsD3d11Presenter).toBeUndefined()

    const stoppedBackend = {
      ...backend,
      state: 'stopped' as const,
      transport: 'unavailable' as const,
      backing: 'none' as const,
      sourcePixelsPresent: false,
      message: 'Preview surface stopped.'
    }
    const unavailableHost = {
      ...proofHost,
      state: 'unavailable' as const,
      transport: 'unavailable' as const,
      backing: 'none' as const
    }
    expect(mergePreviewSurfaceHostStatus(stoppedBackend, unavailableHost)).toMatchObject({
      state: 'unavailable',
      transport: 'unavailable',
      backing: 'none',
      nativePreviewHostKind: undefined,
      nativePreviewHostAttached: false,
      sourcePixelsPresent: false
    })
    expect(
      mergePreviewSurfaceHostStatus(stoppedBackend, unavailableHost).windowsD3d11Presenter
    ).toBeUndefined()
  })

  it('keys polling suppression by generation and rejects a stale response commit', () => {
    const generationSevenKey = nativePreviewFramePollingRequestKey({
      generation: 7,
      suppress: true,
      recordingActive: true
    })
    const generationEightKey = nativePreviewFramePollingRequestKey({
      generation: 8,
      suppress: true,
      recordingActive: true
    })

    expect(generationSevenKey).not.toBe(generationEightKey)
    expect(
      nativePreviewFramePollingResponseCanCommit({
        requestKey: generationSevenKey,
        currentRequestKey: generationSevenKey,
        requestGeneration: 7,
        currentGeneration: 8
      })
    ).toBe(false)
    expect(
      nativePreviewFramePollingResponseCanCommit({
        requestKey: generationEightKey,
        currentRequestKey: generationEightKey,
        requestGeneration: 8,
        currentGeneration: 8
      })
    ).toBe(true)
  })

  it('rejects a main-status read after the preview supervisor generation changes', () => {
    expect(nativePreviewMainStatusReadGenerationMatches(7, 7)).toBe(true)
    expect(nativePreviewMainStatusReadGenerationMatches(7, 8)).toBe(false)
  })

  it('always suppresses polling when the preview window is closed', () => {
    expect(
      nativePreviewFramePollingShouldSuppress({
        recordingActive: false,
        windowOpen: false,
        status: {
          state: 'live',
          transport: 'electron-proof-surface',
          backing: 'electron-browser-window',
          sourcePixelsPresent: true,
          nativePreviewHostAttached: false,
          nativePreviewHostKind: 'proof-surface'
        }
      })
    ).toBe(true)
  })

  it('rejects an old sync after close even when the supervisor generation is unchanged', () => {
    expect(
      nativePreviewSurfaceSyncCanCommit(
        {
          open: false,
          supervisor: { generation: 7 }
        },
        7
      )
    ).toBe(false)
  })

  it('accepts only the open window generation after reopen', () => {
    const reopened = {
      open: true,
      supervisor: { generation: 8 }
    }

    expect(nativePreviewSurfaceSyncCanCommit(reopened, 7)).toBe(false)
    expect(nativePreviewSurfaceSyncCanCommit(reopened, 8)).toBe(true)
  })

  it('requires an open window even for generation-less recovery work', () => {
    expect(
      nativePreviewSurfaceSyncCanCommit(
        {
          open: false,
          supervisor: { generation: 3 }
        },
        undefined
      )
    ).toBe(false)
  })

  it('recreates when a cached session ref meets a stopped backend', () => {
    expect(nativePreviewSurfaceSyncNeedsCreate(true, 'stopped')).toBe(true)
    expect(nativePreviewSurfaceSyncNeedsCreate(true, 'unavailable')).toBe(true)
    expect(nativePreviewSurfaceSyncNeedsCreate(true, 'live')).toBe(false)
    expect(nativePreviewSurfaceSyncNeedsCreate(false, 'stopped')).toBe(false)
  })
})

function canonicalWindowsStatus(): PreviewSurfaceStatus {
  return {
    state: 'live',
    source: 'screen',
    transport: 'd3d11-shared-texture',
    backing: 'directcomposition-swapchain',
    targetFps: 60,
    width: 1920,
    height: 1080,
    framesRendered: 42,
    presentedFrameId: 42,
    droppedFrames: 0,
    framePollingSuppressed: true,
    sourcePixelsPresent: true,
    nativePreviewHostKind: 'backend-d3d11-presenter',
    nativePreviewHostAttached: true,
    pendingHostCommandCount: 0,
    updatedAt: '2026-07-30T00:00:01.000Z',
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
      staleFrameDrops: 0
    }
  }
}
