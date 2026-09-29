import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { BackendMeterReading } from '@/lib/mic-meter'
import { systemAudioSwitchView, type SystemAudioSwitchInput } from '@/lib/system-audio'
import { audioMixerNotice, audioMixerSignalLive, SystemAudioMixerRowView } from './audio-mixer'

describe('audioMixerNotice', () => {
  it.each(['silent', 'no-frames'] as const)(
    'lets an exact permission action outrank stale %s meter evidence',
    (meterStatus) => {
      expect(audioMixerNotice('open-settings', meterStatus, true)).toBe('permission')
    }
  )

  it('retains meter and device recovery copy when no permission action exists', () => {
    expect(audioMixerNotice(null, 'no-frames', true)).toBe('no-frames')
    expect(audioMixerNotice(null, 'unavailable', true)).toBe('device-issue')
  })
})

describe('audioMixerSignalLive', () => {
  it('never labels a muted microphone Live even when backend telemetry is stale', () => {
    expect(audioMixerSignalLive(true, true, 0.8)).toBe(false)
    expect(audioMixerSignalLive(true, false, 0.8)).toBe(false)
    expect(audioMixerSignalLive(false, false, 0.8)).toBe(true)
  })
})

describe('System audio mixer row (plan 069)', () => {
  const noop = (): void => {}
  const render = (
    input: Partial<SystemAudioSwitchInput>,
    reading: BackendMeterReading | null = null,
    macOS = true
  ): string => {
    const view = systemAudioSwitchView({
      device: { status: 'available' },
      requested: false,
      sessionActive: false,
      confirmed: null,
      issue: null,
      ...input
    })
    return view.visible
      ? renderToStaticMarkup(
          createElement(SystemAudioMixerRowView, {
            view,
            reading,
            macOS,
            onEnabledChange: noop,
            onOpenPermissions: noop,
            onResume: noop
          })
        )
      : ''
  }

  it('renders nothing when the device is missing or unsupported', () => {
    expect(render({ device: undefined })).toBe('')
    expect(render({ device: { status: 'unavailable' }, requested: true })).toBe('')
  })

  it('shows an idle Off switch with its label and no meter', () => {
    const markup = render({})
    expect(markup).toContain('System audio')
    expect(markup).toContain('data-videorc-system-audio-row="off"')
    expect(markup).toContain('aria-label="System audio"')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).toContain('>Off<')
    expect(markup).not.toContain('data-videorc-system-audio-visualizer')
  })

  it('shows an idle On switch without a meter', () => {
    const markup = render({ requested: true })
    expect(markup).toContain('data-videorc-system-audio-row="on"')
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain('>On<')
    expect(markup).not.toContain('data-videorc-system-audio-visualizer')
  })

  it('shows the meter and the backend peak while a session mixes system audio', () => {
    const markup = render(
      { requested: true, sessionActive: true, confirmed: true },
      { level: 0.6, peakDb: -14.5 }
    )
    expect(markup).toContain('data-videorc-system-audio-row="live"')
    expect(markup).toContain('data-videorc-system-audio-visualizer')
    expect(markup).toContain('-14.5 dB')
    expect(markup).toContain('Live')
  })

  it('shows the confirmed state while the session has not taken the click yet', () => {
    const markup = render({ requested: true, sessionActive: true, confirmed: false })
    expect(markup).toContain('data-videorc-system-audio-row="pending-on"')
    expect(markup).toContain('aria-checked="false"')
    expect(markup).toContain('Turning on…')
    expect(markup).not.toContain('data-videorc-system-audio-visualizer')
  })

  it('asks for Screen Recording permission with a disabled switch and a Settings button', () => {
    const markup = render({ device: { status: 'permission-required' }, requested: true })
    expect(markup).toContain('data-videorc-system-audio-row="permission-required"')
    expect(markup).toContain('Needs Screen Recording permission')
    expect(markup).toContain('Open Settings')
    expect(markup).toMatch(/role="switch"[^>]*disabled=""/)
  })

  it('offers Resume when the echo guard paused it (plan 076)', () => {
    const markup = render({ requested: true, sessionActive: true, confirmed: false, issue: 'echo' })
    expect(markup).toContain('data-videorc-system-audio-row="issue-echo"')
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain('>Paused<')
    expect(markup).toContain('coming back as an echo. Mute that tab, then resume.')
    expect(markup).toContain('>Resume<')
  })

  it('says what happened on a health issue and keeps the switch On', () => {
    const lost = render({ requested: true, sessionActive: true, confirmed: false, issue: 'lost' })
    expect(lost).toContain('data-videorc-system-audio-row="issue-lost"')
    expect(lost).toContain('aria-checked="true"')
    expect(lost).toContain('System audio stopped. The session keeps going.')
    const unavailable = render({
      requested: true,
      sessionActive: true,
      confirmed: false,
      issue: 'unavailable'
    })
    expect(unavailable).toContain('System audio could not start.')
    expect(unavailable).toContain('Open Settings')
  })

  it('offers Settings for a failed start only on macOS, where a grant can fix it', () => {
    const windows = render(
      { requested: true, sessionActive: true, confirmed: false, issue: 'unavailable' },
      null,
      false
    )
    expect(windows).toContain('System audio could not start.')
    expect(windows).not.toContain('Open Settings')
    expect(windows).not.toContain('Screen Recording')
  })

  it('says a fallback microphone keeps system audio out of this session (Windows, plan 069 S8)', () => {
    const markup = render(
      { requested: true, sessionActive: true, confirmed: false, issue: 'bypassed' },
      null,
      false
    )
    expect(markup).toContain('data-videorc-system-audio-row="issue-bypassed"')
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain(
      'System audio is off for this session because the microphone is on a fallback input.'
    )
    expect(markup).not.toContain('Open Settings')
    expect(markup).not.toContain('data-videorc-system-audio-visualizer')
  })
})
