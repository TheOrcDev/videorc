import { describe, expect, it } from 'vitest'

import {
  assertPermissionShortcutSupported,
  buildRuntimeInfo,
  permissionTargetPath,
  permissionUrlForPane
} from './runtime-info'

describe('runtime info helpers', () => {
  it('strips packaged app executable paths to the app bundle', () => {
    expect(permissionTargetPath('/Applications/Videorc.app/Contents/MacOS/Videorc')).toBe(
      '/Applications/Videorc.app'
    )
  })

  it('keeps Electron development paths and names the permission target Electron', () => {
    const info = buildRuntimeInfo({
      execPath: '/Applications/Electron.app/Contents/MacOS/Electron',
      env: {}
    })

    expect(info).toMatchObject({
      isPackaged: false,
      permissionTargetName: 'Electron',
      permissionTargetPath: '/Applications/Electron.app'
    })
  })

  it('reflects main-process env flags without renderer process access', () => {
    const info = buildRuntimeInfo({
      execPath: '/Applications/Videorc.app/Contents/MacOS/Videorc',
      env: {
        VIDEORC_NATIVE_PREVIEW_SURFACE: '0',
        VIDEORC_SMOKE_PREVIEW_MOTION: '1',
        VIDEORC_DISABLE_AUTO_PREVIEW: '1',
        VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED: '1'
      }
    })

    expect(info).toMatchObject({
      isPackaged: true,
      permissionTargetName: 'Videorc',
      nativePreviewSurfaceProofEnabled: false,
      previewSmokeMode: true,
      disableAutoPreview: true,
      nativePreviewSurfaceStageSuspended: true
    })
  })

  it('rejects permission shortcuts outside macOS', () => {
    expect(() => assertPermissionShortcutSupported('linux')).toThrow(
      'Permission shortcut is only available on macOS.'
    )
  })

  it('falls back to the privacy pane for unknown permission panes', () => {
    expect(permissionUrlForPane('camera')).toContain('Privacy_Camera')
    expect(permissionUrlForPane('unknown' as never)).toBe(permissionUrlForPane('privacy'))
  })
})
