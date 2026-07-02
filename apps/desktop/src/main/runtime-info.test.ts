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
      captureExecPath: '/Users/orcdev/projects/videogre/target/debug/videorc-backend',
      env: {}
    })

    expect(info).toMatchObject({
      isPackaged: false,
      permissionTargetName: 'Electron',
      permissionTargetPath: '/Applications/Electron.app',
      capturePermissionTargetName: 'videorc-backend',
      capturePermissionTargetPath: '/Users/orcdev/projects/videogre/target/debug/videorc-backend'
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
        VIDEORC_SMOKE_NATIVE_PREVIEW_SUSPENDED: '1',
        VIDEORC_NOTES_WINDOW: '1',
        VIDEORC_NOTES_RECORDING_OVERLAY: '1',
        VIDEORC_COMMENTS_WINDOW: '1',
        VIDEORC_COMMENTS_RECORDING_OVERLAY: '1'
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
      disableAutoPreview: true,
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
      env: {}
    })

    expect(info.version).toBe('1.2.3')
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
