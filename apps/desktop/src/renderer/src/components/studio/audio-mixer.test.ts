import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import { systemAudioSwitchView, type SystemAudioSwitchInput } from '@/lib/system-audio'
import {
  audioMixerNotice,
  audioMixerSignalLive,
  micMeterInput,
  MicrophoneStripView,
  SystemAudioMixerRowView,
  type MeterInput
} from './audio-mixer'

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
    peakDb: number | null = null,
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
            peakDb,
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
    const markup = render({ requested: true, sessionActive: true, confirmed: true }, -14.5)
    expect(markup).toContain('data-videorc-system-audio-row="live"')
    expect(markup).toContain('data-videorc-system-audio-visualizer')
    expect(markup).toContain('role="meter"')
    expect(markup).toContain('\u221214.5 dB')
    expect(markup).toContain('>Live<')
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

describe('micMeterInput (plan 092)', () => {
  const source = createFrameEmitter<MeterFrame>()
  const base = {
    microphoneSelected: true,
    muted: false,
    analyserDriven: false,
    source,
    backendPeakDb: null,
    sampledPeakDb: null
  }

  it('prefers the live analyser, then the session level, then a Check level sample', () => {
    expect(micMeterInput({ ...base, analyserDriven: true, backendPeakDb: -20 })).toEqual({
      kind: 'source',
      source
    })
    expect(micMeterInput({ ...base, backendPeakDb: -20, sampledPeakDb: -30 })).toEqual({
      kind: 'value',
      peakDb: -20
    })
    expect(micMeterInput({ ...base, sampledPeakDb: -30 })).toEqual({ kind: 'value', peakDb: -30 })
  })

  it('reads silence while muted, and nothing at all without a microphone or a reading', () => {
    expect(micMeterInput({ ...base, muted: true, analyserDriven: true })).toEqual({
      kind: 'value',
      peakDb: Number.NEGATIVE_INFINITY
    })
    const none = micMeterInput(base)
    expect(none.kind === 'value' && Number.isNaN(none.peakDb)).toBe(true)
    const noMic = micMeterInput({ ...base, microphoneSelected: false, backendPeakDb: -10 })
    expect(noMic.kind === 'value' && Number.isNaN(noMic.peakDb)).toBe(true)
  })
})

describe('Microphone strip (plan 092)', () => {
  const noop = (): void => {}
  const render = (
    overrides: Partial<Parameters<typeof MicrophoneStripView>[0]> = {},
    meter: MeterInput = { kind: 'value', peakDb: -12 }
  ): string =>
    renderToStaticMarkup(
      createElement(MicrophoneStripView, {
        deviceName: 'Studio Mic',
        muted: false,
        monitorLabel: 'Live',
        signalLive: true,
        meter,
        warmReady: false,
        checkLevel: null,
        notice: null,
        permissionLabel: 'Open settings',
        deviceDetail: undefined,
        onPermission: noop,
        onToggleMute: noop,
        ...overrides
      })
    )

  it('keeps the selectors the perf probe and smokes read', () => {
    const markup = render()
    expect(markup).toMatch(
      /role="meter"[^>]*data-videorc-mic-visualizer=""|data-videorc-mic-visualizer=""[^>]*role="meter"/
    )
    expect(markup).toContain('data-videorc-mic-monitor-state="live">Live</span>')
    expect(markup).toContain('data-videorc-mic-clip=""')
    expect(markup).toContain('Studio Mic')
  })

  it('reads the level in dB with a typographic minus', () => {
    expect(render()).toContain('\u221212.0 dB')
  })

  it('lights the clip light from a hot backend reading', () => {
    const hot = render({}, { kind: 'value', peakDb: -0.5 })
    expect(hot).toMatch(
      /data-clipping=""[^>]*data-videorc-mic-clip=""|data-videorc-mic-clip=""[^>]*data-clipping=""/
    )
    expect(render()).not.toContain('data-clipping=""')
  })

  it('dims a muted strip, reads silence and offers Unmute', () => {
    const markup = render(
      { muted: true, monitorLabel: 'Muted', signalLive: false },
      { kind: 'value', peakDb: Number.NEGATIVE_INFINITY }
    )
    expect(markup).toContain('data-muted=""')
    expect(markup).toContain('aria-label="Unmute microphone"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('\u2212\u221e dB')
  })

  it('says No microphone, offers no mute and shows no reading without a device', () => {
    const markup = render(
      { deviceName: undefined, onToggleMute: null, monitorLabel: 'Idle', signalLive: false },
      { kind: 'value', peakDb: Number.NaN }
    )
    expect(markup).toContain('No microphone')
    expect(markup).not.toContain('Mute microphone')
    expect(markup).toContain('-- dB')
  })

  it('puts the warm line, Check level and the notice in one footer', () => {
    const markup = render({
      warmReady: true,
      checkLevel: { disabled: false, loading: true, onCheck: noop },
      notice: 'no-frames'
    })
    expect(markup).toContain('data-videorc-mic-warm="ready"')
    expect(markup).toContain('Checking…')
    expect(markup).toContain('The mic opened but did not send audio frames.')
    expect(markup.match(/data-slot="channel-strip-notice"/g)).toHaveLength(1)
  })

  it('offers the permission action with its label', () => {
    const markup = render({ notice: 'permission', permissionLabel: 'Enable microphone' })
    expect(markup).toContain('Microphone permission is required before levels can be read.')
    expect(markup).toContain('Enable microphone')
  })
})
