import { describe, expect, it } from 'vitest'

import type { PreviewSupervisorState } from '@/lib/backend'

import {
  PREVIEW_FALLBACK_LABEL,
  previewDisabledCopy,
  previewFallbackLabel,
  previewPermissionPane,
  previewSupervisorDisplay
} from './preview-stage'

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
          required: false,
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
            required: true,
            label: 'Screen Recording',
            purpose: 'Capture displays, app windows and system audio.',
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
            required: true,
            label: 'Screen Recording',
            purpose: 'Capture displays, app windows and system audio.',
            state: 'not-granted',
            detail: 'System Settings is blocking screen capture.'
          }
        }
      ).title
    ).toBe('Preview needs permission')
  })
})

describe('previewDisabledCopy', () => {
  it('names the Linux CPU preview in plain words, never the proof surface', () => {
    expect(previewDisabledCopy('linux', 'Native preview addon is not built on linux')).toEqual({
      title: 'Preview runs on the CPU',
      detail: 'Open Preview to watch your scene. Linux draws it on the CPU, so it can lag.',
      retryable: true,
      tone: 'expected'
    })
  })

  it('keeps the retryable warning everywhere a native preview exists', () => {
    for (const platform of ['darwin', 'win32', undefined]) {
      expect(previewDisabledCopy(platform, 'The addon failed to load.')).toEqual({
        title: 'The fast preview is off',
        detail: 'The addon failed to load.',
        retryable: true,
        tone: 'warn'
      })
    }
  })
})

describe('preview copy (plan 174 S2.3a, B-23)', () => {
  it('names the path only when it is a fallback for this platform', () => {
    expect(previewFallbackLabel('native-surface', 'cametal-layer', undefined, 'darwin')).toBeNull()
    expect(previewFallbackLabel('latest-jpeg-polling', 'none', undefined, 'darwin')).toBe(
      PREVIEW_FALLBACK_LABEL
    )
    expect(
      previewFallbackLabel('electron-proof-surface', 'electron-browser-window', undefined, 'darwin')
    ).toBe('Using a slower preview path')
    // Windows ships the proof surface; Linux has no other path. Neither is a fallback.
    expect(
      previewFallbackLabel('electron-proof-surface', 'electron-browser-window', undefined, 'win32')
    ).toBeNull()
    expect(
      previewFallbackLabel('electron-proof-surface', 'electron-browser-window', undefined, 'linux')
    ).toBeNull()
    expect(
      previewFallbackLabel(
        'd3d11-shared-texture',
        'directcomposition-swapchain',
        'backend-d3d11-presenter',
        'win32'
      )
    ).toBeNull()
    expect(previewFallbackLabel('none', 'none', undefined, 'darwin')).toBeNull()
  })

  it('says Opening preview… and Closing preview…, never the surface or the compositor', () => {
    const opening = previewSupervisorDisplay(true, supervisor('ok', 'opening-window'))
    const starting = previewSupervisorDisplay(true, supervisor('ok', 'starting-surface'))
    const closing = previewSupervisorDisplay(true, supervisor('ok', 'closing'))
    expect(opening.title).toBe('Opening preview…')
    expect(starting.title).toBe('Opening preview…')
    expect(closing.title).toBe('Closing preview…')
    for (const state of [
      'surface-live',
      'surface-fallback',
      'opening-window',
      'starting-surface',
      'closing',
      'open-no-surface',
      'closed'
    ] as const) {
      const display = previewSupervisorDisplay(true, supervisor('ok', state))
      expect(`${display.title} ${display.detail} ${display.transportLabel ?? ''}`).not.toMatch(
        /surface|compositor|proof|electron|tearing|detached|native|live in/i
      )
    }
  })

  it('never lets a fallback pass silently (AGENTS.md)', () => {
    const fallback = previewSupervisorDisplay(true, {
      ...supervisor('ok', 'surface-fallback'),
      fallbackReason: 'The Metal device was lost.'
    })
    expect(fallback).toMatchObject({
      title: PREVIEW_FALLBACK_LABEL,
      detail: 'The Metal device was lost.',
      tone: 'warn'
    })
  })
})
