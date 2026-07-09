import { describe, expect, it } from 'vitest'

import {
  nativePreviewSurfaceSyncCanCommit,
  nativePreviewSurfaceSyncNeedsCreate
} from './native-preview-surface-lifecycle'

describe('native preview surface lifecycle', () => {
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
