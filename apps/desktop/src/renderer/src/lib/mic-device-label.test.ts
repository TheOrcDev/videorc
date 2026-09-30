import { describe, expect, it } from 'vitest'

import { chromiumAudioInputBaseLabel, matchStrictAudioInput } from './mic-device-label'

const inputs = (...labels: string[]): Array<{ deviceId: string; label: string }> =>
  labels.map((label, index) => ({ deviceId: `mic-${index}`, label }))

describe('chromiumAudioInputBaseLabel', () => {
  it('strips the transport, USB model and role decorations Chromium adds on macOS', () => {
    // Real labels: the built-in pair was read from Electron 39 on the owner's
    // Mac (2026-09-30); AirPods and the MV7 follow the same Chromium rules.
    expect(chromiumAudioInputBaseLabel('MacBook Pro Microphone (Built-in)')).toBe(
      'MacBook Pro Microphone'
    )
    expect(chromiumAudioInputBaseLabel('Default - MacBook Pro Microphone (Built-in)')).toBe(
      'MacBook Pro Microphone'
    )
    expect(chromiumAudioInputBaseLabel('AirPods Pro (Bluetooth)')).toBe('AirPods Pro')
    expect(chromiumAudioInputBaseLabel('Shure MV7 (14ed:1012)')).toBe('Shure MV7')
    expect(chromiumAudioInputBaseLabel('ZoomAudioDevice (Virtual)')).toBe('ZoomAudioDevice')
    expect(chromiumAudioInputBaseLabel('iPhone Microphone')).toBe('iPhone Microphone')
  })

  it('keeps parentheses that are part of the device name', () => {
    // Windows names carry the driver in parentheses; that is the name, not a suffix.
    expect(chromiumAudioInputBaseLabel('Microphone (Realtek(R) Audio)')).toBe(
      'Microphone (Realtek(R) Audio)'
    )
    expect(chromiumAudioInputBaseLabel('Mic (Studio)')).toBe('Mic (Studio)')
  })
})

describe('matchStrictAudioInput', () => {
  it('finds the backend-named mic behind Chromium decorations', () => {
    expect(
      matchStrictAudioInput(
        'AirPods Pro',
        inputs('MacBook Pro Microphone (Built-in)', 'AirPods Pro (Bluetooth)')
      )
    ).toEqual({ deviceId: 'mic-1' })
    expect(
      matchStrictAudioInput(
        'MacBook Pro Microphone',
        inputs('MacBook Pro Microphone (Built-in)', 'AirPods Pro (Bluetooth)')
      )
    ).toEqual({ deviceId: 'mic-0' })
    expect(matchStrictAudioInput('Shure MV7', inputs('Shure MV7 (14ed:1012)'))).toEqual({
      deviceId: 'mic-0'
    })
  })

  it('never picks the synthetic default entry, even when it names the device', () => {
    expect(
      matchStrictAudioInput('MacBook Pro Microphone', [
        { deviceId: 'default', label: 'Default - MacBook Pro Microphone (Built-in)' },
        { deviceId: 'mic-real', label: 'MacBook Pro Microphone (Built-in)' }
      ])
    ).toEqual({ deviceId: 'mic-real' })
    expect(
      matchStrictAudioInput('MacBook Pro Microphone', [
        { deviceId: 'default', label: 'Default - MacBook Pro Microphone (Built-in)' }
      ])
    ).toEqual({ failure: 'device-missing' })
  })

  it('prefers an undecorated exact label over a decorated one', () => {
    expect(matchStrictAudioInput('Studio', inputs('Studio (USB)', 'Studio'))).toEqual({
      deviceId: 'mic-1'
    })
  })

  it('refuses to guess: containment, duplicates and hidden labels are failures', () => {
    expect(matchStrictAudioInput('Studio', inputs('Studio Plus (USB)'))).toEqual({
      failure: 'no-label-match'
    })
    expect(
      matchStrictAudioInput('USB Mic', inputs('USB Mic (Virtual)', 'USB Mic (Virtual)'))
    ).toEqual({ failure: 'ambiguous-label' })
    expect(matchStrictAudioInput('Studio', inputs('Studio', 'Studio'))).toEqual({
      failure: 'ambiguous-label'
    })
    expect(matchStrictAudioInput('Studio', inputs('', ''))).toEqual({ failure: 'labels-hidden' })
    expect(matchStrictAudioInput('Studio', [])).toEqual({ failure: 'device-missing' })
    expect(matchStrictAudioInput(undefined, inputs('Studio'))).toEqual({
      failure: 'no-label-match'
    })
  })
})
