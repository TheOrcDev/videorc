import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { PreviewSupervisorState } from '@/lib/backend'

import {
  DetachedPreviewCard,
  PREVIEW_CLOSED_COPY,
  PREVIEW_FALLBACK_LABEL,
  PREVIEW_FLOATING_DETAIL,
  PREVIEW_FLOATING_TITLE,
  dockedSupervisorDisplay,
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

  it('reads the Linux CPU preview as open, not as a slower fallback', () => {
    // On Linux the main process always reports the proof surface as
    // 'surface-fallback'; it is the only preview Linux has.
    const linuxPreview = {
      ...supervisor('ok', 'surface-fallback'),
      fallbackReason: 'Preview is displaying compositor output.'
    }
    const linux = previewSupervisorDisplay(true, linuxPreview, undefined, undefined, null, 'linux')
    expect(linux).toMatchObject({
      title: PREVIEW_FLOATING_TITLE,
      detail: PREVIEW_FLOATING_DETAIL,
      tone: 'normal'
    })
    expect(`${linux.title} ${linux.detail}`).not.toMatch(/slower|compositor|surface|proof/i)

    for (const platform of ['darwin', 'win32']) {
      expect(
        previewSupervisorDisplay(true, linuxPreview, undefined, undefined, null, platform)
      ).toMatchObject({
        title: PREVIEW_FALLBACK_LABEL,
        detail: 'Preview is displaying compositor output.',
        tone: 'warn'
      })
    }
  })
})

describe('the stage with no docked Preview (issue #1273)', () => {
  const noop = (): void => {}

  function card(overrides: Partial<Parameters<typeof DetachedPreviewCard>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(DetachedPreviewCard, {
        previewWindowOpen: false,
        previewWindowMode: 'floating',
        previewSupervisor: supervisor('ok', 'closed'),
        nativePreviewSurfaceEnabled: true,
        alwaysOnTop: false,
        aspect: { width: 1920, height: 1080 },
        onAlwaysOnTopChange: noop,
        onOpen: noop,
        onOpenDocked: noop,
        onOpenFloating: noop,
        onClose: noop,
        onStick: noop,
        permissionAccess: null,
        platform: 'win32',
        ...overrides
      })
    )
  }

  it('says the closed Preview is closed and offers both places to open it', () => {
    const html = card()
    expect(html).toContain(PREVIEW_CLOSED_COPY.title)
    expect(html).toContain(PREVIEW_CLOSED_COPY.detail)
    expect(html).toMatch(/data-videorc-open-preview-window[^>]*>.*?Show here/)
    expect(html).toMatch(/data-videorc-open-preview-floating[^>]*>.*?Open in its own window/)
    expect(html).not.toContain('lives in its own window')
  })

  it('puts the Preview shortcut on the button for the remembered mode', () => {
    const shortcutAfter = (html: string, marker: string): boolean => {
      const start = html.indexOf(marker)
      const end = html.indexOf('</button>', start)
      return html.slice(start, end).includes('<kbd')
    }
    const floating = card({ previewWindowMode: 'floating' })
    expect(shortcutAfter(floating, 'data-videorc-open-preview-floating')).toBe(true)
    expect(shortcutAfter(floating, 'data-videorc-open-preview-window')).toBe(false)
    const docked = card({ previewWindowMode: 'docked' })
    expect(shortcutAfter(docked, 'data-videorc-open-preview-window')).toBe(true)
    expect(shortcutAfter(docked, 'data-videorc-open-preview-floating')).toBe(false)
  })

  it('leads a floating Preview with Show here, the way back into the Studio', () => {
    const html = card({
      previewWindowOpen: true,
      previewSupervisor: supervisor('ok', 'surface-live')
    })
    expect(html).toContain(PREVIEW_FLOATING_TITLE)
    expect(html).toContain(PREVIEW_FLOATING_DETAIL)
    const stick = html.indexOf('data-videorc-preview-stick')
    const front = html.indexOf('data-videorc-preview-bring-to-front')
    expect(stick).toBeGreaterThan(-1)
    expect(front).toBeGreaterThan(stick)
    expect(html.slice(stick, html.indexOf('</button>', stick))).toContain('Show here')
    // The lead action is the chrome primary, not an outline beside it.
    const stickTag = html.slice(html.lastIndexOf('<button', stick), html.indexOf('>', stick))
    expect(stickTag).toContain('data-variant="default"')
  })
})

describe('dockedSupervisorDisplay', () => {
  it('never tells a docked slot the Preview is in its own window', () => {
    for (const lifecycle of ['surface-live', 'open-no-surface'] as const) {
      const display = dockedSupervisorDisplay(
        previewSupervisorDisplay(
          true,
          supervisor('ok', lifecycle),
          undefined,
          undefined,
          null,
          'win32'
        )
      )
      expect(display.title).not.toBe(PREVIEW_FLOATING_TITLE)
      expect(`${display.title} ${display.detail}`).not.toMatch(/own window|Show it here/)
    }
  })

  it('keeps every other state as stated', () => {
    const failed = previewSupervisorDisplay(true, {
      ...supervisor('ok', 'failed'),
      lastError: 'The camera stopped.'
    })
    expect(dockedSupervisorDisplay(failed)).toEqual(failed)
  })
})
