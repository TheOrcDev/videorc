import { describe, expect, it } from 'vitest'

import {
  isCoreAudioMicrophoneId,
  warmMicrophoneWanted,
  type WarmMicrophoneGateInput
} from './warm-microphone-gate'

const ON_SCREEN: WarmMicrophoneGateInput = {
  keepWarm: true,
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
    ['the setting is off', { keepWarm: false }],
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

  it('recognises CoreAudio ids only', () => {
    expect(isCoreAudioMicrophoneId('microphone:coreaudio:1')).toBe(true)
    expect(isCoreAudioMicrophoneId('microphone:avfoundation:1')).toBe(false)
    expect(isCoreAudioMicrophoneId(undefined)).toBe(false)
  })
})
