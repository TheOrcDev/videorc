import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import { defaultCaptureConfig } from '@/lib/capture'
import type { MeterInput } from '@/lib/mic-meter-input'
import { systemAudioSwitchView, type SystemAudioSwitchInput } from '@/lib/system-audio'
import {
  applySyncChange,
  MicrophoneChannel,
  SyncCalibrationView,
  SystemAudioSettings
} from './sources-audio-mixer'

const noop = (): void => {}

const NO_READING: MeterInput = { kind: 'value', peakDb: Number.NaN }

function render(
  input: Partial<SystemAudioSwitchInput>,
  macOS = true,
  echoGuard = true,
  meter: MeterInput = NO_READING
): string {
  const view = systemAudioSwitchView({
    device: { status: 'available' },
    requested: false,
    sessionActive: false,
    confirmed: null,
    issue: null,
    ...input
  })
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(SystemAudioSettings, {
        view,
        gainDb: -6,
        macOS,
        echoGuard,
        meter,
        toggleShortcut: [],
        onEnabledChange: noop,
        onGainChange: noop,
        onEchoGuardChange: noop,
        onOpenPermissions: noop,
        onResume: noop
      })
    )
  )
}

describe('Sources System audio settings (plan 069)', () => {
  it('shows the switch, the level at -6 dB and the helper line', () => {
    const markup = render({})
    expect(markup).toContain('System audio')
    expect(markup).toContain('aria-label="System audio"')
    // Plan 093: Level is a fader now; its hidden input carries a 0..1
    // position, so the value reads from the strip's value text.
    expect(markup).toContain('aria-label="System audio gain"')
    expect(markup).toContain('>\u22126.0 dB<')
    expect(markup).toContain('aria-valuetext="\u22126.0 dB"')
    expect(markup).toContain(
      'Everything your computer plays, except Videorc, including your own stream if it is open in a browser tab: mute that tab, because headphones don&#x27;t stop it.'
    )
    expect(markup).toContain('Use headphones so your mic doesn&#x27;t pick up your speakers.')
    expect(markup).toContain(
      'Your Mac&#x27;s volume and mute don&#x27;t change what&#x27;s recorded.'
    )
  })

  it('states the Mac volume fact only on macOS', () => {
    expect(render({}, false)).not.toContain('volume and mute')
  })

  it('keeps Windows copy free of Mac and Screen Recording wording', () => {
    const idle = render({}, false)
    expect(idle).toContain('Everything your computer plays, except Videorc,')
    expect(idle).not.toContain('Screen Recording')
    const failed = render(
      { requested: true, sessionActive: true, confirmed: false, issue: 'unavailable' },
      false
    )
    expect(failed).toContain('System audio could not start.')
    expect(failed).not.toContain('Open Settings')
    const bypassed = render(
      { requested: true, sessionActive: true, confirmed: false, issue: 'bypassed' },
      false
    )
    expect(bypassed).toContain(
      'System audio is off for this session because the microphone is on a fallback input.'
    )
  })

  it('has the echo guard On by default, and it can be turned off (plan 076)', () => {
    const guard = /<button[^>]*aria-label="Pause System audio if your stream echoes back"[^>]*>/
    expect(render({}).match(guard)?.[0]).toContain('aria-checked="true"')
    expect(render({}, true, false).match(guard)?.[0]).toContain('aria-checked="false"')
  })

  it('offers Resume when the echo guard paused it (plan 076)', () => {
    const markup = render({ requested: true, sessionActive: true, confirmed: false, issue: 'echo' })
    expect(markup).toContain('coming back as an echo. Mute that tab, then resume.')
    expect(markup).toContain('>Resume<')
  })

  it('disables the switch and the level without Screen Recording permission', () => {
    const markup = render({ device: { status: 'permission-required' } })
    expect(markup).toContain('Needs Screen Recording permission')
    expect(markup).toContain('Open Settings')
    expect(markup).toMatch(/role="switch"[^>]*disabled=""/)
    expect(markup).toMatch(
      /data-slot="channel-strip"[^>]*data-disabled=""|data-disabled=""[^>]*data-slot="channel-strip"/
    )
    expect(markup).toMatch(
      /data-disabled=""[^>]*data-slot="fader"|data-slot="fader"[^>]*data-disabled=""/
    )
  })
})

describe('Sources System audio strip (plan 093)', () => {
  it('rests with no reading outside a session, and says when it moves', () => {
    const markup = render({ requested: true })
    expect(markup).toContain('data-videorc-system-audio-visualizer=""')
    expect(markup).toContain('title="Shows while recording or live"')
    expect(markup).toContain('aria-label="System audio level"')
  })

  it('drops the hint once the bus level drives it', () => {
    const source = createFrameEmitter<MeterFrame>()
    const markup = render({ requested: true, sessionActive: true, confirmed: true }, true, true, {
      kind: 'source',
      source
    })
    expect(markup).not.toContain('Shows while recording or live')
  })

  it('shows the state beside the title, never a permanent "Unavailable"', () => {
    expect(render({ requested: true })).toContain('data-slot="channel-strip-description">On<')
    expect(render({})).toContain('data-slot="channel-strip-description">Off<')
    expect(render({ device: { status: 'permission-required' } })).not.toContain(
      'data-slot="channel-strip-description"'
    )
  })
})

function renderMicrophone(
  overrides: Partial<Parameters<typeof MicrophoneChannel>[0]> = {}
): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(MicrophoneChannel, {
        microphoneSelected: true,
        meter: { kind: 'value', peakDb: -18 },
        monitorLabel: 'Monitoring',
        unavailableReason: undefined,
        gainDb: 0,
        muted: false,
        muteShortcut: [],
        syncOffsetMs: 0,
        sessionActive: false,
        calibration: null,
        onGainChange: noop,
        onMutedChange: noop,
        onSyncChange: noop,
        ...overrides
      })
    )
  )
}

describe('Sources microphone strip (plan 093)', () => {
  it('is one channel strip: state, level, Gain fader and the mute toggle', () => {
    const markup = renderMicrophone()
    expect(markup).toContain('data-slot="channel-strip"')
    expect(markup).toContain('>Microphone<')
    expect(markup).toContain('data-videorc-mic-monitor-state="monitoring"')
    expect(markup).toMatch(/data-slot="channel-strip-meter"[^>]*data-videorc-mic-preview=""/)
    expect(markup).toContain('aria-label="Microphone level"')
    expect(markup).toContain('data-slot="fader"')
    expect(markup).toContain('aria-label="Microphone gain"')
    expect(markup).toMatch(/<button[^>]*aria-label="Mute microphone"/)
  })

  it('shows the gain in dB with a typographic minus, and no number box', () => {
    expect(renderMicrophone({ gainDb: 0 })).toContain('>0.0 dB<')
    expect(renderMicrophone({ gainDb: 6 })).toContain('>+6.0 dB<')
    expect(renderMicrophone({ gainDb: -12 })).toContain('>\u221212.0 dB<')
    // The Gain fader has no number box; the only typed field is Sync's.
    const markup = renderMicrophone()
    const strip = markup.slice(0, markup.indexOf('data-slot="parameter-slider"'))
    expect(strip).not.toMatch(/type="(number|text)"/)
  })

  it('presses the mute toggle and marks the strip muted while muted', () => {
    const toggle = /<button[^>]*aria-label="Mute microphone"[^>]*>/
    expect(renderMicrophone({ muted: false }).match(toggle)?.[0]).toContain('aria-pressed="false"')
    const muted = renderMicrophone({ muted: true, monitorLabel: 'Muted' })
    expect(muted.match(toggle)?.[0]).toContain('aria-pressed="true"')
    expect(muted).toMatch(
      /data-slot="channel-strip"[^>]*data-muted=""|data-muted=""[^>]*data-slot="channel-strip"/
    )
  })

  it('says "No microphone" when none is selected, and names a dead level honestly', () => {
    const none = renderMicrophone({ microphoneSelected: false, meter: NO_READING })
    expect(none).toContain('>No microphone<')
    expect(none).toContain('data-videorc-mic-monitor-state="none"')
    const busy = renderMicrophone({ meter: NO_READING, unavailableReason: 'device-busy' })
    expect(busy).toContain('Another app is using this mic.')
    expect(renderMicrophone()).not.toContain('data-videorc-mic-level-reason')
  })

  it('gives Sync a typed millisecond field, and says when a change waits for the next session', () => {
    const idle = renderMicrophone({ syncOffsetMs: 150 })
    expect(idle).toContain('data-slot="parameter-slider"')
    expect(idle).toContain('>Sync<')
    expect(idle).toContain('>ms<')
    expect(idle).toContain('value="150"')
    expect(idle).not.toContain('Applies from the next recording or stream.')
    expect(renderMicrophone({ sessionActive: true })).toContain(
      'Applies from the next recording or stream.'
    )
  })
})

describe('applySyncChange (plan 093)', () => {
  const audio = {
    ...defaultCaptureConfig.audio,
    microphoneSyncOffsetMs: 150,
    microphoneSyncOffsetUserSet: true
  }

  it('a drag, a keypress or a typed value is a manual trim', () => {
    for (const reason of ['drag', 'keyboard', 'input'] as const) {
      expect(applySyncChange({ ...audio, microphoneSyncOffsetUserSet: false }, 40, reason)).toEqual(
        {
          ...audio,
          microphoneSyncOffsetMs: 40,
          microphoneSyncOffsetUserSet: true
        }
      )
    }
  })

  it('clamps to the backend range and stores whole milliseconds', () => {
    expect(applySyncChange(audio, 5000, 'input').microphoneSyncOffsetMs).toBe(1000)
    expect(applySyncChange(audio, 12.6, 'drag').microphoneSyncOffsetMs).toBe(13)
  })

  it('a reset restores the structural default and clears the user-set flag', () => {
    expect(applySyncChange(audio, 0, 'reset')).toEqual({
      ...audio,
      microphoneSyncOffsetMs: 0,
      microphoneSyncOffsetUserSet: false
    })
  })
})

describe('Sync calibration (plan 093, D3)', () => {
  function renderCalibration(
    overrides: Partial<Parameters<typeof SyncCalibrationView>[0]> = {}
  ): string {
    return renderToStaticMarkup(
      createElement(SyncCalibrationView, {
        developer: false,
        status: 'unavailable',
        measuredLagLabel: 'No paired flash/click measurement',
        detail: 'Record a flash/click sample before applying calibration.',
        canApply: false,
        onImport: async () => {},
        onApply: noop,
        ...overrides
      })
    )
  }

  it('is folded by default: only the Calibrate button shows', () => {
    const markup = renderCalibration()
    expect(markup).toContain('>Calibrate<')
    expect(markup).not.toContain('Import JSON')
  })

  it('opens to the measurement, Import JSON and Apply, without a second Reset', () => {
    const markup = renderCalibration({ defaultOpen: true })
    expect(markup).toContain('No paired flash/click measurement')
    expect(markup).toContain('Import JSON')
    expect(markup).toContain('>Apply<')
    expect(markup).not.toContain('>Reset<')
    expect(markup).toContain('Record a flash/click sample before applying calibration.')
  })

  it('offers the pnpm stimulus only in development builds', () => {
    expect(renderCalibration({ defaultOpen: true })).not.toContain('Stimulus')
    expect(renderCalibration({ defaultOpen: true, developer: true })).toContain('Stimulus')
  })
})
