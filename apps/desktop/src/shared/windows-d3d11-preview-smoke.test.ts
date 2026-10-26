import { describe, expect, it } from 'vitest'

import { validateWindowsD3d11PreviewSmokeRequest } from './windows-d3d11-preview-smoke'

describe('Windows D3D11 preview packaged smoke contract', () => {
  it('accepts only an exact screen selection and the state read', () => {
    expect(
      validateWindowsD3d11PreviewSmokeRequest({
        action: 'configure',
        screenId: 'screen:dxgi:0000000000000001:1'
      })
    ).toEqual({ action: 'configure', screenId: 'screen:dxgi:0000000000000001:1' })
    expect(validateWindowsD3d11PreviewSmokeRequest({ action: 'state' })).toEqual({
      action: 'state'
    })
  })

  it('rejects extra capabilities, paths, code, malformed ids, and recording control', () => {
    expect(
      validateWindowsD3d11PreviewSmokeRequest({
        action: 'configure',
        screenId: 'screen:1',
        cameraId: 'camera:1'
      })
    ).toBeNull()
    expect(
      validateWindowsD3d11PreviewSmokeRequest({
        action: 'configure',
        screenId: 'screen:1',
        path: 'C:\\Users\\person\\recordings'
      })
    ).toBeNull()
    expect(
      validateWindowsD3d11PreviewSmokeRequest({ action: 'state', code: 'window.location.href' })
    ).toBeNull()
    expect(validateWindowsD3d11PreviewSmokeRequest({ action: 'configure' })).toBeNull()
    expect(
      validateWindowsD3d11PreviewSmokeRequest({ action: 'configure', screenId: ' screen:1' })
    ).toBeNull()
    expect(
      validateWindowsD3d11PreviewSmokeRequest({ action: 'configure', screenId: 'screen:\u00001' })
    ).toBeNull()
    expect(
      validateWindowsD3d11PreviewSmokeRequest({ action: 'configure', screenId: 'x'.repeat(2_049) })
    ).toBeNull()
    expect(validateWindowsD3d11PreviewSmokeRequest({ action: 'configure', screenId: 7 })).toBeNull()
    expect(validateWindowsD3d11PreviewSmokeRequest({ action: 'start' })).toBeNull()
    expect(validateWindowsD3d11PreviewSmokeRequest({ action: 'stop' })).toBeNull()
    expect(validateWindowsD3d11PreviewSmokeRequest({ action: 'eval-js' })).toBeNull()
  })
})
