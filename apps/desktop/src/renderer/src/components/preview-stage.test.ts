import { describe, expect, it } from 'vitest'

import type { PreviewSupervisorState } from '@/lib/backend'

import { previewPermissionPane, previewSupervisorDisplay } from './preview-stage'

function supervisor(
  permissionStatus: PreviewSupervisorState['permissionStatus'],
  lifecycleState: PreviewSupervisorState['lifecycleState'] = 'permission-required'
): PreviewSupervisorState {
  return {
    lifecycleState,
    generation: 1,
    windowOpen: true,
    windowVisible: true,
    surfaceRequested: true,
    surfaceActive: false,
    transport: 'none',
    backing: 'none',
    permissionStatus,
    updatedAt: '2026-07-15T00:00:00.000Z'
  }
}

describe('previewPermissionPane', () => {
  it('keeps camera failures on the camera permission path', () => {
    expect(previewPermissionPane(supervisor('camera-required'))).toBe('camera')
  })

  it('keeps screen failures on the Screen Recording path', () => {
    expect(previewPermissionPane(supervisor('screen-recording-required'))).toBe('screen-recording')
  })

  it('uses the generic privacy pane only for an unknown permission diagnosis', () => {
    expect(previewPermissionPane(supervisor('unknown'))).toBe('privacy')
  })

  it('does not invent a permission action without an explicit diagnosis', () => {
    expect(previewPermissionPane(supervisor('camera-required', 'failed'))).toBeNull()
    expect(previewPermissionPane(supervisor('ok'))).toBeNull()
  })
})

describe('previewSupervisorDisplay', () => {
  it('reports device recovery instead of a stale camera permission blocker after grant', () => {
    expect(
      previewSupervisorDisplay(true, supervisor('camera-required'), undefined, undefined, {
        action: null,
        row: {
          id: 'camera',
          label: 'Camera',
          purpose: 'Camera overlay in your scenes.',
          state: 'device-issue',
          detail: 'Camera permission is granted, but no usable camera is currently available.'
        }
      })
    ).toEqual({
      title: 'Preview is recovering',
      detail: 'Camera permission is granted, but no usable camera is currently available.',
      tone: 'warn'
    })
  })

  it('reports capture recovery for a granted screen route while preserving real blockers', () => {
    expect(
      previewSupervisorDisplay(
        true,
        supervisor('screen-recording-required'),
        undefined,
        undefined,
        {
          action: null,
          row: {
            id: 'screen-recording',
            label: 'Screen Recording',
            purpose: 'Capture displays and app windows.',
            state: 'granted',
            detail: 'Permission granted.'
          }
        }
      )
    ).toEqual({
      title: 'Preview is recovering',
      detail: 'Screen Recording permission is granted. Reconnecting capture.',
      tone: 'warn'
    })

    expect(
      previewSupervisorDisplay(
        true,
        supervisor('screen-recording-required'),
        undefined,
        undefined,
        {
          action: 'open-settings',
          row: {
            id: 'screen-recording',
            label: 'Screen Recording',
            purpose: 'Capture displays and app windows.',
            state: 'not-granted',
            detail: 'System Settings is blocking screen capture.'
          }
        }
      ).title
    ).toBe('Preview needs permission')
  })
})
