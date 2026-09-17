import { describe, expect, it } from 'vitest'

import { validateWindowsLiveAudioSmokeRequest } from './windows-live-audio-smoke'

describe('Windows live audio packaged smoke contract', () => {
  it('accepts only exact device configuration and fixed actions', () => {
    expect(
      validateWindowsLiveAudioSmokeRequest({
        action: 'configure',
        screenId: 'screen:dxgi:0000000000000001:1',
        cameraId: 'camera:dshow:HD Camera',
        microphoneId: 'microphone:dshow:USB Microphone'
      })
    ).toEqual({
      action: 'configure',
      screenId: 'screen:dxgi:0000000000000001:1',
      cameraId: 'camera:dshow:HD Camera',
      microphoneId: 'microphone:dshow:USB Microphone'
    })
    expect(validateWindowsLiveAudioSmokeRequest({ action: 'start' })).toEqual({ action: 'start' })
    expect(validateWindowsLiveAudioSmokeRequest({ action: 'rapid-burst' })).toEqual({
      action: 'rapid-burst'
    })
    expect(validateWindowsLiveAudioSmokeRequest({ action: 'stop' })).toEqual({ action: 'stop' })
    expect(validateWindowsLiveAudioSmokeRequest({ action: 'state' })).toEqual({ action: 'state' })
  })

  it('accepts bounded gain and mute values', () => {
    expect(
      validateWindowsLiveAudioSmokeRequest({
        action: 'set-audio',
        microphoneGainDb: 6,
        microphoneMuted: true
      })
    ).toEqual({ action: 'set-audio', microphoneGainDb: 6, microphoneMuted: true })
    expect(
      validateWindowsLiveAudioSmokeRequest({
        action: 'set-audio',
        microphoneGainDb: -24,
        microphoneMuted: false
      })
    ).not.toBeNull()
    expect(
      validateWindowsLiveAudioSmokeRequest({
        action: 'set-audio',
        microphoneGainDb: 24,
        microphoneMuted: false
      })
    ).not.toBeNull()
  })

  it('rejects extra capabilities, paths, code, malformed ids, and invalid gain', () => {
    expect(
      validateWindowsLiveAudioSmokeRequest({
        action: 'configure',
        screenId: 'screen:1',
        cameraId: 'camera:1',
        microphoneId: 'mic:1',
        path: 'C:\\Users\\person\\recordings'
      })
    ).toBeNull()
    expect(
      validateWindowsLiveAudioSmokeRequest({ action: 'state', code: 'window.location.href' })
    ).toBeNull()
    expect(
      validateWindowsLiveAudioSmokeRequest({
        action: 'configure',
        screenId: ' screen:1',
        cameraId: 'camera:1',
        microphoneId: 'mic:1'
      })
    ).toBeNull()
    expect(
      validateWindowsLiveAudioSmokeRequest({
        action: 'set-audio',
        microphoneGainDb: 25,
        microphoneMuted: false
      })
    ).toBeNull()
    expect(validateWindowsLiveAudioSmokeRequest({ action: 'eval-js' })).toBeNull()
  })
})
