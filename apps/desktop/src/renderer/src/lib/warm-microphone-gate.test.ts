import { describe, expect, it } from 'vitest'

import {
  WARM_MICROPHONE_OPEN_FAILED_RETRY_MS,
  WARM_MICROPHONE_RETRY_MS,
  isBackendMeteredMicrophoneId,
  isCoreAudioMicrophoneId,
  warmMicrophoneMeterOnly,
  warmMicrophoneRetryDelayMs,
  warmMicrophoneWanted,
  type WarmMicrophoneGateInput
} from './warm-microphone-gate'

const ON_SCREEN: WarmMicrophoneGateInput = {
  workspaceVisible: true,
  documentVisible: true,
  microphoneId: 'microphone:coreaudio:42',
  muted: false
}

describe('warmMicrophoneWanted', () => {
  it('keeps a CoreAudio microphone warm while Studio is on screen', () => {
    expect(warmMicrophoneWanted(ON_SCREEN)).toBe(true)
  })

  it.each<[string, Partial<WarmMicrophoneGateInput>]>([
    ['the workspace tab is elsewhere', { workspaceVisible: false }],
    ['the window is hidden', { documentVisible: false }],
    ['no microphone is selected', { microphoneId: undefined }],
    ['the microphone is not a CoreAudio input', { microphoneId: 'microphone:avfoundation:0' }],
    ['the microphone is muted', { muted: true }]
  ])('releases the device when %s', (_label, overrides) => {
    // The device is genuinely open while armed, so every one of these must
    // release it — this is what keeps the OS indicator honest.
    expect(warmMicrophoneWanted({ ...ON_SCREEN, ...overrides })).toBe(false)
  })

  // Plan 260 S1.3a (D2, owner 2026-11-09): the standing-by microphone is the
  // idle meter's only feed, so Keep microphone ready off still opens it, for
  // the meter only (Record opens the device fresh).
  it('stands by for the meter with Keep microphone ready off, meter-only', () => {
    expect(warmMicrophoneWanted(ON_SCREEN)).toBe(true)
    expect(warmMicrophoneMeterOnly(false)).toBe(true)
    expect(warmMicrophoneMeterOnly(true)).toBe(false)
    expect(warmMicrophoneMeterOnly(undefined)).toBe(false)
  })

  it('arms again after a transient refusal or a failed open, never after a lasting one', () => {
    for (const reason of ['session-active', 'cleanup-pending', 'opening', 'superseded']) {
      expect(warmMicrophoneRetryDelayMs(reason)).toBe(WARM_MICROPHONE_RETRY_MS)
    }
    expect(warmMicrophoneRetryDelayMs('open-failed')).toBe(WARM_MICROPHONE_OPEN_FAILED_RETRY_MS)
    for (const reason of ['not-coreaudio', 'disabled-for-smoke', 'disarmed', undefined]) {
      expect(warmMicrophoneRetryDelayMs(reason)).toBeNull()
    }
  })

  it('recognises CoreAudio ids only', () => {
    expect(isCoreAudioMicrophoneId('microphone:coreaudio:1')).toBe(true)
    expect(isCoreAudioMicrophoneId('microphone:avfoundation:1')).toBe(false)
    expect(isCoreAudioMicrophoneId(undefined)).toBe(false)
  })

  // Plan 260 S1.3: a PipeWire source stands by in the backend too, for the
  // idle meter only; a Windows input still meters in the renderer.
  it('stands a PipeWire microphone by for the meter, never a Windows one', () => {
    const pipewire = 'microphone:linux-pulse:616c73615f696e707574'
    expect(isBackendMeteredMicrophoneId(pipewire)).toBe(true)
    expect(isBackendMeteredMicrophoneId('microphone:coreaudio:1')).toBe(true)
    expect(isBackendMeteredMicrophoneId('microphone:windows-dshow:4d6963')).toBe(false)
    expect(isBackendMeteredMicrophoneId(undefined)).toBe(false)
    expect(warmMicrophoneWanted({ ...ON_SCREEN, microphoneId: pipewire })).toBe(true)
    expect(
      warmMicrophoneWanted({ ...ON_SCREEN, microphoneId: 'microphone:windows-dshow:4d6963' })
    ).toBe(false)
  })
})
