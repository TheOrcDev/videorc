import { describe, expect, it } from 'vitest'

import { defaultCaptureConfig } from './capture'
import {
  configureWindowsD3d11PreviewSmokeCapture,
  windowsD3d11PreviewSmokeState
} from './windows-d3d11-preview-smoke-harness'

const devices = [
  { id: 'screen:1', name: 'Display 1', kind: 'screen' as const, status: 'available' as const },
  { id: 'screen:2', name: 'Display 2', kind: 'screen' as const, status: 'unavailable' as const },
  { id: 'camera:1', name: 'Camera 1', kind: 'camera' as const, status: 'available' as const },
  { id: 'mic:1', name: 'Mic 1', kind: 'microphone' as const, status: 'available' as const }
]

describe('Windows D3D11 preview StudioProvider smoke harness', () => {
  it('makes the exact screen the only source, with camera and microphone off', () => {
    const current = {
      ...defaultCaptureConfig,
      sources: {
        cameraId: 'camera:1',
        cameraName: 'Camera 1',
        microphoneId: 'mic:1',
        microphoneName: 'Mic 1',
        testPattern: true
      }
    }
    const configured = configureWindowsD3d11PreviewSmokeCapture(current, devices, {
      action: 'configure',
      screenId: 'screen:1'
    })

    expect(configured.sources).toEqual({
      screenId: 'screen:1',
      screenName: 'Display 1',
      cameraOff: true,
      microphoneOff: true,
      testPattern: false
    })
    expect(configured.layout.layoutPreset).toBe('screen-only')
    expect(configured.lastHorizontalPreset).toBe('screen-only')
    expect(configured.video).toEqual({
      preset: 'custom',
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateKbps: 6_000
    })
    expect(configured.recordEnabled).toBe(true)
    expect(configured.streamEnabled).toBe(false)
    expect(configured.captions.enabled).toBe(false)
    // The buffer-only ring is what puts source pixels in the preview before Record.
    expect(configured.replayBuffer).toEqual(current.replayBuffer)
  })

  it('rejects unavailable or wrong-kind device ids', () => {
    for (const screenId of ['screen:2', 'camera:1', 'screen:missing']) {
      expect(() =>
        configureWindowsD3d11PreviewSmokeCapture(defaultCaptureConfig, devices, {
          action: 'configure',
          screenId
        })
      ).toThrow(/available screen/)
    }
  })

  it('returns no recording paths', () => {
    const state = windowsD3d11PreviewSmokeState({
      recording: {
        state: 'recording',
        sessionId: 'session-1',
        outputPath: 'C:\\private\\recording.mkv'
      },
      lastError: null,
      captureConfig: configureWindowsD3d11PreviewSmokeCapture(defaultCaptureConfig, devices, {
        action: 'configure',
        screenId: 'screen:1'
      })
    })

    expect(state.recording).toEqual({ state: 'recording', sessionId: 'session-1' })
    expect(JSON.stringify(state)).not.toContain('private')
    expect(state.sources).toEqual({
      screenId: 'screen:1',
      cameraId: undefined,
      cameraOff: true,
      microphoneId: undefined,
      microphoneOff: true,
      testPattern: false
    })
    expect(state.layout).toEqual({ layoutPreset: 'screen-only' })
  })
})
