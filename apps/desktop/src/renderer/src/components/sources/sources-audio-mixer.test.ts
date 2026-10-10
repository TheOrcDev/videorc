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
  syncOffsetTag,
  SystemAudioSettings
} from './sources-audio-mixer'

const noop = (): void => {}

const NO_READING: MeterInput = { kind: 'value', peakDb: Number.NaN }

function render(
  input: Partial<SystemAudioSwitchInput>,
  {
    macOS = true,
    echoGuard = true,
    meter = NO_READING,
    open = false
  }: { macOS?: boolean; echoGuard?: boolean; meter?: MeterInput; open?: boolean } = {}
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
        sessionActive: input.sessionActive ?? false,
        toggleShortcut: [],
        defaultMoreOpen: open,
        onEnabledChange: noop,
        onGainChange: noop,
        onEchoGuardChange: noop,
        onOpenPermissions: noop,
        onResume: noop
      })
    )
  )
}

describe('Sources System audio row (plans 069, 173)', () => {
  it('is one row: the switch in the header and one line on what it captures', () => {
    const markup = render({})
    expect(markup).toContain('data-slot="source-item"')
    expect(markup).toContain('data-videorc-system-audio-settings=""')
    expect(markup).toContain('>System audio<')
    expect(markup).toMatch(/<button[^>]*aria-label="System audio"/)
    expect(markup).toContain('Everything your Mac plays, except Videorc.')
    // Plan 173, D4: the long explanation is folded into More.
    expect(markup).not.toContain('browser tab')
  })

  it('shows its level and the Level fader only while On', () => {
    const off = render({})
    expect(off).not.toContain('aria-label="System audio gain"')
    expect(off).not.toContain('Level shows while recording or live.')
    const on = render({ requested: true })
    expect(on).toContain('aria-label="System audio gain"')
    expect(on).toContain('>−6.0 dB<')
    expect(on).toContain('aria-valuetext="−6.0 dB"')
  })

  it('says when the level moves instead of drawing a dead meter (plan 173)', () => {
    const idle = render({ requested: true })
    expect(idle).toContain('Level shows while recording or live.')
    expect(idle).not.toContain('data-videorc-system-audio-visualizer')
    expect(idle).not.toContain('aria-label="System audio level"')
  })

  it('draws the meter once the bus level drives it', () => {
    const source = createFrameEmitter<MeterFrame>()
    const markup = render(
      { requested: true, sessionActive: true, confirmed: true },
      { meter: { kind: 'source', source } }
    )
    expect(markup).toContain('data-videorc-system-audio-visualizer=""')
    expect(markup).toContain('aria-label="System audio level"')
    expect(markup).not.toContain('Level shows while recording or live.')
  })

  it('opens More to the echo guard and the three facts', () => {
    const markup = render({}, { open: true })
    expect(markup).toContain('Pause if your stream echoes back')
    expect(markup).toContain(
      'Your own stream open in a browser tab is captured too. Mute that tab: headphones don&#x27;t stop it.'
    )
    expect(markup).toContain('Use headphones so your mic doesn&#x27;t pick up your speakers.')
    expect(markup).toContain(
      'Your Mac&#x27;s volume and mute don&#x27;t change what&#x27;s recorded.'
    )
  })

  it('states the Mac volume fact only on macOS', () => {
    expect(render({}, { macOS: false, open: true })).not.toContain('volume and mute')
  })

  it('keeps Windows copy free of Mac and Screen Recording wording', () => {
    const idle = render({}, { macOS: false, open: true })
    expect(idle).toContain('Everything your computer plays, except Videorc.')
    expect(idle).not.toContain('Mac')
    expect(idle).not.toContain('Screen Recording')
    const failed = render(
      { requested: true, sessionActive: true, confirmed: false, issue: 'unavailable' },
      { macOS: false }
    )
    expect(failed).toContain('System audio could not start.')
    expect(failed).not.toContain('Open Settings')
    const bypassed = render(
      { requested: true, sessionActive: true, confirmed: false, issue: 'bypassed' },
      { macOS: false }
    )
    expect(bypassed).toContain(
      'System audio is off for this session because the microphone is on a fallback input.'
    )
  })

  it('has the echo guard On by default, and it can be turned off (plan 076)', () => {
    const guard = /<button[^>]*aria-label="Pause System audio if your stream echoes back"[^>]*>/
    expect(render({}, { open: true }).match(guard)?.[0]).toContain('aria-checked="true"')
    expect(render({}, { open: true, echoGuard: false }).match(guard)?.[0]).toContain(
      'aria-checked="false"'
    )
  })

  it('offers Resume when the echo guard paused it (plan 076)', () => {
    const markup = render({ requested: true, sessionActive: true, confirmed: false, issue: 'echo' })
    expect(markup).toContain('coming back as an echo. Mute that tab, then resume.')
    expect(markup).toContain('>Resume<')
    expect(markup).toContain('>Paused<')
  })

  it('locks the row with one reason without Screen Recording permission', () => {
    const markup = render({ device: { status: 'permission-required' } }, { open: true })
    expect(markup).toContain('Needs Screen Recording permission')
    expect(markup).toContain('Open Settings')
    expect(markup).toContain('>Needs permission<')
    const onSwitch = markup.match(/<button[^>]*aria-label="System audio"[^>]*>/)?.[0]
    expect(onSwitch).toContain('disabled=""')
    expect(markup).toMatch(/data-disabled="true"[^>]*data-slot="source-item"/)
    const guard = markup.match(
      /<button[^>]*aria-label="Pause System audio if your stream echoes back"[^>]*>/
    )?.[0]
    expect(guard).toContain('disabled=""')
  })

  it('keeps the On switch styled by its own state under the shortcut tooltip', () => {
    // Radix TooltipTrigger asChild writes data-state onto its child; on the
    // Switch that replaced checked/unchecked, the only hook its track styles use.
    const onSwitch = /<button[^>]*aria-label="System audio"[^>]*>/
    expect(render({ requested: true }).match(onSwitch)?.[0]).toContain('data-state="checked"')
    expect(render({}).match(onSwitch)?.[0]).toContain('data-state="unchecked"')
  })

  it('chips On outside a session, Live while mixed, and nothing while Off', () => {
    expect(render({ requested: true })).toContain('>On<')
    const source = createFrameEmitter<MeterFrame>()
    expect(
      render(
        { requested: true, sessionActive: true, confirmed: true },
        { meter: { kind: 'source', source } }
      )
    ).toContain('>Live<')
    expect(render({})).not.toContain('data-slot="source-status"')
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
        picker: createElement('div', { 'data-test-picker': '' }),
        microphoneSelected: true,
        status: null,
        meter: { kind: 'value', peakDb: -18 },
        monitorLabel: 'Monitoring',
        unavailableReason: undefined,
        gainDb: 0,
        muted: false,
        muteShortcut: [],
        syncOffsetMs: 0,
        syncUserSet: false,
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

describe('Sources Microphone row (plans 093, 173)', () => {
  it('is one row: Mute in the header; picker, level and Gain in the body', () => {
    const markup = renderMicrophone()
    expect(markup).toContain('data-slot="source-item"')
    expect(markup).toContain('>Microphone<')
    expect(markup).toContain('data-videorc-mic-channel=""')
    expect(markup).toContain('data-videorc-mic-monitor-state="monitoring"')
    expect(markup).toMatch(/data-videorc-mic-preview=""[^]*aria-label="Microphone level"/)
    expect(markup).toContain('data-slot="fader"')
    expect(markup).toContain('aria-label="Microphone gain"')
    expect(markup).toContain('>Gain<')
    expect(markup).toMatch(/<button[^>]*aria-label="Mute microphone"/)
    // Header first (Mute), then the body (picker, then the meter).
    const order = [
      'aria-label="Mute microphone"',
      'data-test-picker',
      'data-videorc-mic-preview'
    ].map((needle) => markup.indexOf(needle))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The device name lives in the picker only: no second "Monitoring" label.
    expect(markup).not.toContain('>Monitoring<')
  })

  it('shows the gain in dB with a typographic minus, and no number box', () => {
    expect(renderMicrophone({ gainDb: 0 })).toContain('>0.0 dB<')
    expect(renderMicrophone({ gainDb: 6 })).toContain('>+6.0 dB<')
    expect(renderMicrophone({ gainDb: -12 })).toContain('>−12.0 dB<')
    expect(renderMicrophone()).not.toMatch(/type="(number|text)"/)
  })

  it('presses the mute toggle and marks the row muted while muted', () => {
    const toggle = /<button[^>]*aria-label="Mute microphone"[^>]*>/
    expect(renderMicrophone({ muted: false }).match(toggle)?.[0]).toContain('aria-pressed="false"')
    const muted = renderMicrophone({
      muted: true,
      monitorLabel: 'Muted',
      status: { label: 'Muted', tone: 'neutral' }
    })
    expect(muted.match(toggle)?.[0]).toContain('aria-pressed="true"')
    expect(muted).toMatch(
      /data-muted=""[^>]*data-slot="source-item"|data-slot="source-item"[^>]*data-muted=""/
    )
    expect(muted).toContain('data-videorc-mic-monitor-state="muted"')
    expect(muted).toContain('>Muted<')
  })

  it('says "No microphone selected" with none picked, and names a dead level honestly', () => {
    const none = renderMicrophone({ microphoneSelected: false, meter: NO_READING })
    expect(none).toContain('No microphone selected.')
    expect(none).toContain('data-videorc-mic-monitor-state="none"')
    const busy = renderMicrophone({ meter: NO_READING, unavailableReason: 'device-busy' })
    expect(busy).toContain('Another app is using this mic.')
    expect(busy).toContain('data-videorc-mic-level-reason="device-busy"')
    expect(renderMicrophone()).not.toContain('data-videorc-mic-level-reason')
  })

  it('folds Sync into More, closed by default (plan 173, D2)', () => {
    const closed = renderMicrophone({ syncOffsetMs: 150, syncUserSet: true })
    expect(closed).not.toContain('data-slot="parameter-slider"')
    expect(closed).toContain('aria-label="More microphone settings"')
  })

  it('gives Sync a typed millisecond field, and says when a change waits for the next session', () => {
    const idle = renderMicrophone({ syncOffsetMs: 150, defaultMoreOpen: true })
    expect(idle).toContain('data-slot="parameter-slider"')
    expect(idle).toContain('>Sync<')
    expect(idle).toContain('>ms<')
    expect(idle).toContain('value="150"')
    expect(idle).toContain('Delays your voice to line up with the video.')
    expect(idle).not.toContain('Applies from the next recording or stream.')
    expect(renderMicrophone({ sessionActive: true, defaultMoreOpen: true })).toContain(
      'Applies from the next recording or stream.'
    )
  })

  it('tags the header while Sync is off its default, so a folded setting never surprises', () => {
    expect(renderMicrophone({ syncOffsetMs: 150, syncUserSet: true })).toContain('>Sync +150 ms<')
    expect(renderMicrophone({ syncOffsetMs: 0, syncUserSet: true })).not.toContain('Sync +')
  })

  it('shows Calibrate only when given (development builds, plan 173 D3)', () => {
    expect(renderMicrophone({ defaultMoreOpen: true })).not.toContain('Calibrate')
    expect(
      renderMicrophone({
        defaultMoreOpen: true,
        calibration: createElement('span', null, 'Calibrate')
      })
    ).toContain('Calibrate')
  })
})

describe('syncOffsetTag (plan 173)', () => {
  it('is null at the default, signed with a typographic minus otherwise', () => {
    expect(syncOffsetTag(150, true)).toBe('Sync +150 ms')
    expect(syncOffsetTag(-40, true)).toBe('Sync −40 ms')
    expect(syncOffsetTag(0, true)).toBeNull()
    expect(syncOffsetTag(150, false)).toBeNull()
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
