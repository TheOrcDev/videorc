import { describe, expect, it } from 'vitest'

import {
  assertPermissionShortcutSupported,
  buildRuntimeInfo,
  normalizeRuntimeGpuDevices,
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
      appVersion: '9.9.9-test',
      execPath: '/Applications/Electron.app/Contents/MacOS/Electron',
      env: {}
    })

    expect(info).toMatchObject({
      isPackaged: false,
      permissionTargetName: 'Electron',
      permissionTargetPath: '/Applications/Electron.app',
      capturePermissionTargetName: 'Electron',
      capturePermissionTargetPath: '/Applications/Electron.app'
    })
  })

  it('reports the backend helper as the capture permission target when provided', () => {
    const info = buildRuntimeInfo({
      appVersion: '9.9.9-test',
      execPath: '/Applications/Electron.app/Contents/MacOS/Electron',
      captureExecPath: '/Users/orcdev/projects/videorc/target/debug/videorc-backend',
      env: {}
    })

    expect(info).toMatchObject({
      isPackaged: false,
      permissionTargetName: 'Electron',
      permissionTargetPath: '/Applications/Electron.app',
      capturePermissionTargetName: 'videorc-backend',
      capturePermissionTargetPath: '/Users/orcdev/projects/videorc/target/debug/videorc-backend'
    })
  })

  it('reports the packaged backend helper as the capture permission target', () => {
    const info = buildRuntimeInfo({
      appVersion: '9.9.9-test',
      execPath: '/Applications/Videorc.app/Contents/MacOS/Videorc',
      captureExecPath: '/Applications/Videorc.app/Contents/Resources/videorc-backend',
      env: {}
    })

    expect(info).toMatchObject({
      isPackaged: true,
      permissionTargetName: 'Videorc',
      permissionTargetPath: '/Applications/Videorc.app',
      capturePermissionTargetName: 'videorc-backend',
      capturePermissionTargetPath: '/Applications/Videorc.app/Contents/Resources/videorc-backend'
    })
  })

  it('reflects main-process env flags without renderer process access', () => {
    const info = buildRuntimeInfo({
      appVersion: '9.9.9-test',
      execPath: '/Applications/Videorc.app/Contents/MacOS/Videorc',
      env: {
        VIDEORC_NATIVE_PREVIEW_SURFACE: '0',
        VIDEORC_SMOKE_PREVIEW_MOTION: '1',
        VIDEORC_DISABLE_AUTO_PREVIEW: '1',
        VIDEORC_DISABLE_AUTO_SOURCE_PREVIEW: '1',
        VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED: '1',
        VIDEORC_NOTES_WINDOW: '1',
        VIDEORC_NOTES_RECORDING_OVERLAY: '1',
        VIDEORC_COMMENTS_WINDOW: '1',
        VIDEORC_COMMENTS_RECORDING_OVERLAY: '1',
        VIDEORC_WINDOWS_LIVE_AUDIO_SMOKE: '1'
      }
    })

    expect(info).toMatchObject({
      isPackaged: true,
      permissionTargetName: 'Videorc',
      capturePermissionTargetName: 'Videorc',
      nativePreviewSurfaceProofEnabled: false,
      notesWindowEnabled: true,
      notesWindowRecordingOverlayAllowed: true,
      commentsWindowEnabled: true,
      commentsWindowRecordingOverlayAllowed: true,
      previewSmokeMode: true,
      windowsLiveAudioSmokeMode: true,
      disableAutoPreview: true,
      disableAutoSourcePreview: true,
      nativePreviewSurfaceStageSuspended: true
    })
  })

  it('enables Notes, Comments, and recording overlays by default after artifact gates', () => {
    const info = buildRuntimeInfo({
      appVersion: '9.9.9-test',
      execPath: '/Applications/Videorc.app/Contents/MacOS/Videorc',
      env: {}
    })

    expect(info).toMatchObject({
      notesWindowEnabled: true,
      notesWindowRecordingOverlayAllowed: true,
      commentsWindowEnabled: true,
      commentsWindowRecordingOverlayAllowed: true
    })
  })

  it('allows Notes, Comments, and recording overlays to be disabled by env kill switches', () => {
    const info = buildRuntimeInfo({
      appVersion: '9.9.9-test',
      execPath: '/Applications/Videorc.app/Contents/MacOS/Videorc',
      env: {
        VIDEORC_NOTES_WINDOW: '0',
        VIDEORC_NOTES_RECORDING_OVERLAY: '0',
        VIDEORC_COMMENTS_WINDOW: '0',
        VIDEORC_COMMENTS_RECORDING_OVERLAY: '0'
      }
    })

    expect(info).toMatchObject({
      notesWindowEnabled: false,
      notesWindowRecordingOverlayAllowed: false,
      commentsWindowEnabled: false,
      commentsWindowRecordingOverlayAllowed: false
    })
  })

  it('surfaces the running app version', () => {
    const info = buildRuntimeInfo({
      appVersion: '1.2.3',
      execPath: '/Applications/Videorc.app/Contents/MacOS/Videorc',
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.22631',
      gpuInfo: {
        gpuDevice: [
          {
            vendorId: 4318,
            deviceId: 9348,
            active: true,
            vendorString: 'NVIDIA',
            deviceString: 'NVIDIA RTX'
          }
        ]
      },
      env: {}
    })

    expect(info.version).toBe('1.2.3')
    expect(info.platform).toBe('win32')
    expect(info.arch).toBe('x64')
    expect(info.osRelease).toBe('10.0.22631')
    expect(info.gpuDevices).toEqual([
      {
        vendorId: 4318,
        deviceId: 9348,
        active: true,
        vendor: 'NVIDIA',
        description: 'NVIDIA RTX'
      }
    ])
  })

  it('drops malformed GPU entries from runtime diagnostics', () => {
    expect(
      normalizeRuntimeGpuDevices({
        gpuDevice: [
          null,
          {},
          {
            vendorId: '0x8086',
            deviceId: '0x9a49',
            active: false,
            deviceString: 'Intel Iris Xe'
          }
        ]
      })
    ).toEqual([
      {
        vendorId: '0x8086',
        deviceId: '0x9a49',
        active: false,
        description: 'Intel Iris Xe'
      }
    ])
  })

  it('supports permission shortcuts on macOS and Windows, rejects the rest', () => {
    expect(() => assertPermissionShortcutSupported('darwin')).not.toThrow()
    expect(() => assertPermissionShortcutSupported('win32')).not.toThrow()
    expect(() => assertPermissionShortcutSupported('linux')).toThrow(
      'Permission shortcuts are only available on macOS and Windows.'
    )
  })

  it('falls back to the privacy pane for unknown permission panes', () => {
    expect(permissionUrlForPane('camera', 'darwin')).toContain('Privacy_Camera')
    expect(permissionUrlForPane('unknown' as never, 'darwin')).toBe(
      permissionUrlForPane('privacy', 'darwin')
    )
  })

  it('maps panes to ms-settings URIs on Windows', () => {
    expect(permissionUrlForPane('camera', 'win32')).toBe('ms-settings:privacy-webcam')
    expect(permissionUrlForPane('microphone', 'win32')).toBe('ms-settings:privacy-microphone')
    // Windows has no per-app screen permission — screen-recording falls back
    // to the privacy hub rather than a dedicated pane.
    expect(permissionUrlForPane('screen-recording', 'win32')).toBe('ms-settings:privacy')
  })
})
