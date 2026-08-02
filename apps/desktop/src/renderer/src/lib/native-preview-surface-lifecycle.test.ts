import { describe, expect, it } from 'vitest'

import type { PreviewSurfaceStatus } from '../../../shared/backend'
import {
  nativePreviewFramePollingShouldSuppress,
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
        status: {
          state: 'live',
          transport: 'd3d11-shared-texture',
          backing: 'directcomposition-swapchain',
          sourcePixelsPresent: true,
          nativePreviewHostAttached: true,
          nativePreviewHostKind: 'backend-d3d11-presenter'
        }
      })
    ).toBe(true)
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
        windowsD3d11Presenter: undefined
      })
    ).toBe(true)
    expect(
      previewSurfaceStatusRequiresMainAuthority({
        transport: 'electron-proof-surface',
        windowsD3d11Presenter: {
          fallbackReason: 'presenter-stopped'
        } as PreviewSurfaceStatus['windowsD3d11Presenter']
      })
    ).toBe(true)
    expect(
      previewSurfaceStatusRequiresMainAuthority({
        transport: 'electron-proof-surface',
        windowsD3d11Presenter: undefined
      })
    ).toBe(false)
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
