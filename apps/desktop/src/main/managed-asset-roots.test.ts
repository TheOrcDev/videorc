import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { managedBackendAssetRootCandidates } from './managed-asset-roots'

// Expected paths go through the same `join` as the code, so the test reads the
// platform's own separators (Windows CI joins with backslashes).

describe('managedBackendAssetRootCandidates (release test 146, plan 0005)', () => {
  it('serves the backend folder first, then the legacy userData folder (Linux)', () => {
    expect(
      managedBackendAssetRootCandidates({
        backendRoot: '/home/u/.videorc/Banners',
        userDataDir: '/home/u/.config/Videorc',
        folder: 'Banners'
      })
    ).toEqual([join('/home/u/.videorc/Banners'), join('/home/u/.config/Videorc', 'Banners')])
  })

  it('is the same single folder as before on macOS and Windows', () => {
    const mac = '/Users/u/Library/Application Support/Videorc'
    expect(
      managedBackendAssetRootCandidates({
        backendRoot: `${mac}/Screens`,
        userDataDir: mac,
        folder: 'Screens'
      })
    ).toEqual([join(mac, 'Screens')])
  })

  it('falls back to userData until the backend has said where its folder is', () => {
    expect(
      managedBackendAssetRootCandidates({
        backendRoot: null,
        userDataDir: '/home/u/.config/Videorc',
        folder: 'Screens'
      })
    ).toEqual([join('/home/u/.config/Videorc', 'Screens')])
  })
})
