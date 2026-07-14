import { describe, expect, it } from 'vitest'

import { defaultCaptureConfig } from './capture'
import {
  configureWindowsLiveAudioSmokeCapture,
  WINDOWS_LIVE_AUDIO_SMOKE_BURST,
  windowsLiveAudioSmokeState
} from './windows-live-audio-smoke-harness'

const devices = [
  { id: 'screen:1', name: 'Display 1', kind: 'screen' as const, status: 'available' as const },
  { id: 'camera:1', name: 'Camera 1', kind: 'camera' as const, status: 'available' as const },
  { id: 'mic:1', name: 'Mic 1', kind: 'microphone' as const, status: 'available' as const }
]

describe('Windows live audio StudioProvider smoke harness', () => {
  it('configures the exact physical Screen + Cam record-only profile', () => {
    const configured = configureWindowsLiveAudioSmokeCapture(defaultCaptureConfig, devices, {
      action: 'configure',
      screenId: 'screen:1',
      cameraId: 'camera:1',
      microphoneId: 'mic:1'
    })

    expect(configured.sources).toEqual({
      screenId: 'screen:1',
      screenName: 'Display 1',
      cameraId: 'camera:1',
      cameraName: 'Camera 1',
      microphoneId: 'mic:1',
      microphoneName: 'Mic 1',
      testPattern: false
    })
    expect(configured.layout.layoutPreset).toBe('screen-camera')
    expect(configured.video).toEqual({
      preset: 'custom',
      width: 1280,
      height: 720,
      fps: 30,
      bitrateKbps: 2_000
    })
    expect(configured.audio).toMatchObject({ microphoneGainDb: 0, microphoneMuted: false })
    expect(configured.recordEnabled).toBe(true)
    expect(configured.streamEnabled).toBe(false)
    expect(configured.captions.enabled).toBe(false)
  })

  it('rejects unavailable or wrong-kind device ids', () => {
    expect(() =>
      configureWindowsLiveAudioSmokeCapture(defaultCaptureConfig, devices, {
        action: 'configure',
        screenId: 'camera:1',
        cameraId: 'camera:1',
        microphoneId: 'mic:1'
      })
    ).toThrow(/available screen/)
  })

  it('ends the fixed rapid burst at zero gain and unmuted', () => {
    expect(WINDOWS_LIVE_AUDIO_SMOKE_BURST.at(-1)).toEqual({
      microphoneGainDb: 0,
      microphoneMuted: false
    })
  })

  it('returns no recording paths and copies real RPC telemetry', () => {
    const state = windowsLiveAudioSmokeState({
      recording: {
        state: 'recording',
        sessionId: 'session-1',
        outputPath: 'C:\\private\\recording.mkv'
      },
      lastError: null,
      captureConfig: defaultCaptureConfig,
      telemetry: {
        requestedCount: 2,
        settledCount: 1,
        lastSettled: {
          requested: {
            sessionId: 'session-1',
            microphoneGainDb: 6,
            microphoneMuted: false
          },
          applied: true,
          settings: { microphoneGainDb: 6, microphoneMuted: false }
        }
      }
    })

    expect(state.recording).toEqual({ state: 'recording', sessionId: 'session-1' })
    expect(JSON.stringify(state)).not.toContain('private')
    expect(state.telemetry).toMatchObject({ requestedCount: 2, settledCount: 1 })
  })
})
