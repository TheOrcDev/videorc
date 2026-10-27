// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import type { Device, ReplayBufferState } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import { micMeterInput, type MeterInput } from '@/lib/mic-meter-input'
import { systemAudioSwitchView, type SystemAudioSwitchInput } from '@/lib/system-audio'
import {
  AudioSection,
  AudioSectionView,
  SystemAudioIdleLine,
  type MicrophoneRowProps,
  type SystemAudioRowProps
} from './audio-section'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  clips: { armed: true, state: { state: 'on' as string, seconds: 60, bufferedSeconds: 12 } },
  openSettings: (() => {}) as (tab: string) => void
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioReplay: () => mocked.clips
}))
vi.mock('@/hooks/use-studio-mic-sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-studio-mic-sources')>()),
  useMicrophoneMeter: () => ({ meter: { kind: 'value', peakDb: -12 }, monitorState: 'live' }),
  useBackendAudioLevelsLive: () => false
}))
vi.mock('@/components/workspace-nav', () => ({
  useWorkspaceNav: () => ({ openSettings: mocked.openSettings })
}))

const noop = (): void => {}
const microphones: Device[] = [
  { id: 'mic-1', name: 'Studio Mic', kind: 'microphone', status: 'available' },
  { id: 'mic-2', name: 'MacBook Pro Microphone', kind: 'microphone', status: 'available' }
]
const systemAudioDevice: Device = {
  id: 'system-audio:default',
  name: 'System audio',
  kind: 'system-audio',
  status: 'available'
}
const NO_READING: MeterInput = { kind: 'value', peakDb: Number.NaN }

function microphoneProps(overrides: Partial<MicrophoneRowProps> = {}): MicrophoneRowProps {
  return {
    devices: microphones,
    value: 'mic-1',
    selectedName: 'Studio Mic',
    disabled: false,
    discoveryPending: false,
    meter: { kind: 'value', peakDb: -12 },
    monitorState: 'live',
    muted: false,
    gainDb: 0,
    onChange: noop,
    onMutedChange: noop,
    onGainChange: noop,
    ...overrides
  }
}

function systemAudioProps(
  input: Partial<SystemAudioSwitchInput> = {},
  overrides: Partial<SystemAudioRowProps> = {}
): SystemAudioRowProps {
  return {
    view: systemAudioSwitchView({
      device: { status: 'available' },
      requested: true,
      sessionActive: false,
      audioBusActive: false,
      confirmed: null,
      issue: null,
      ...input
    }),
    gainDb: -6,
    meter: NO_READING,
    sessionActive: input.sessionActive ?? false,
    platform: 'darwin',
    onEnabledChange: noop,
    onGainChange: noop,
    onOpenPermissions: noop,
    onResume: noop,
    ...overrides
  }
}

function render(
  microphone: Partial<MicrophoneRowProps> = {},
  systemAudio: SystemAudioRowProps | null = null
): string {
  return renderToStaticMarkup(
    createElement(AudioSectionView, { microphone: microphoneProps(microphone), systemAudio })
  )
}

/** The markup of one row, by its `data-source`. */
function row(markup: string, source: 'studio-microphone' | 'studio-system-audio'): string {
  const start = markup.indexOf(`data-source="${source}"`)
  expect(start).toBeGreaterThan(-1)
  const end = markup.indexOf('data-slot="channel-strip"', start)
  return markup.slice(start, end === -1 ? undefined : end)
}

describe('micMeterInput (plan 092)', () => {
  const analyser = createFrameEmitter<MeterFrame>()
  const backend = createFrameEmitter<MeterFrame>()
  const base = {
    microphoneSelected: true,
    muted: false,
    backendSource: null,
    analyserDriven: false,
    source: analyser,
    backendPeakDb: null
  }

  it('prefers the backend levels, session or standby, then the analyser, then the 1 Hz level', () => {
    expect(micMeterInput({ ...base, backendSource: backend, analyserDriven: true })).toEqual({
      kind: 'source',
      source: backend
    })
    expect(micMeterInput({ ...base, analyserDriven: true, backendPeakDb: -20 })).toEqual({
      kind: 'source',
      source: analyser
    })
    expect(micMeterInput({ ...base, backendPeakDb: -20 })).toEqual({
      kind: 'value',
      peakDb: -20
    })
  })

  it('reads silence while muted, and nothing without a microphone or a reading', () => {
    expect(micMeterInput({ ...base, muted: true, backendSource: backend })).toEqual({
      kind: 'value',
      peakDb: Number.NEGATIVE_INFINITY
    })
    expect(micMeterInput({ ...base, microphoneSelected: false, backendSource: backend }).kind).toBe(
      'value'
    )
    expect(Number.isNaN((micMeterInput(base) as { peakDb: number }).peakDb)).toBe(true)
  })
})

describe('Audio section (plan 201 S2)', () => {
  it('is titled Audio, with the Microphone then System audio on one scale', () => {
    const markup = render({}, systemAudioProps())
    expect(markup).toContain('>Audio</h2>')
    expect(markup).not.toContain('>Microphone</h2>')
    // One audiocn Mixer around both rows, one channel strip each.
    expect(markup.match(/data-slot="mixer"/g)).toHaveLength(1)
    expect(markup.match(/data-slot="channel-strip"/g)).toHaveLength(2)
    expect(markup.indexOf('data-source="studio-microphone"')).toBeLessThan(
      markup.indexOf('data-source="studio-system-audio"')
    )
    expect(markup).toContain('data-videorc-studio-system-audio=""')
    expect(markup).toContain('data-videorc-studio-system-audio-level=""')
  })

  it('puts each meter above its Gain fader, at its value, with a typographic minus', () => {
    const markup = render({}, systemAudioProps())
    const microphone = row(markup, 'studio-microphone')
    const systemAudio = row(markup, 'studio-system-audio')
    expect(microphone.indexOf('aria-label="Microphone level"')).toBeLessThan(
      microphone.indexOf('aria-label="Microphone gain"')
    )
    expect(systemAudio.indexOf('aria-label="System audio level"')).toBeLessThan(
      systemAudio.indexOf('aria-label="System audio gain"')
    )
    expect(microphone).toMatch(/data-slot="source-control-value"[^>]*>0\.0 dB</)
    expect(systemAudio).toMatch(/data-slot="source-control-value"[^>]*>−6\.0 dB</)
    // At their defaults the readouts are plain text, with nothing to reset.
    expect(markup).not.toContain('Reset to')
  })

  it('drops the System audio row where it cannot run, and stays Audio (Linux, older Windows)', () => {
    const markup = render()
    expect(markup).toContain('>Audio</h2>')
    expect(markup).not.toContain('System audio')
    expect(markup.match(/data-slot="channel-strip"/g)).toHaveLength(1)
  })

  it('holds the picker, the level, the mute and Gain in the Microphone row', () => {
    const markup = row(render(), 'studio-microphone')
    expect(markup).toContain('>Microphone</span>')
    // The picker keeps its label for screen readers under the row title.
    expect(markup).toMatch(/<label[^>]*class="[^"]*sr-only[^"]*"[^>]*>Microphone<\/label>/)
    expect(markup).toContain('role="combobox"')
    expect(markup).toMatch(
      /role="meter"[^>]*data-videorc-mic-visualizer=""|data-videorc-mic-visualizer=""[^>]*role="meter"/
    )
    // The mute sits in the row's header, after the title (plan 174 S3.3).
    const mute = /<button[^>]*aria-label="Mute microphone"[^>]*>/.exec(markup)?.[0]
    expect(mute).toContain('aria-pressed="false"')
    expect(mute).toContain('data-videorc-studio-mic-mute=""')
    expect(markup.indexOf('>Microphone</span>')).toBeLessThan(markup.indexOf('Mute microphone'))
    expect(markup.indexOf('Mute microphone')).toBeLessThan(markup.indexOf('role="combobox"'))
    expect(markup).not.toContain('>Muted<')
  })

  it('says Muted in words and dims the meter, so a mute never reads as silence (D16)', () => {
    const markup = render({
      meter: { kind: 'value', peakDb: Number.NEGATIVE_INFINITY },
      muted: true
    })
    expect(markup).toContain('>Muted</span>')
    expect(/<button[^>]*aria-label="Mute microphone"[^>]*>/.exec(markup)?.[0]).toContain(
      'aria-pressed="true"'
    )
    expect(markup).toMatch(
      /class="[^"]*opacity-50[^"]*"[^>]*data-muted=""[^>]*data-videorc-mic-level/
    )
    // Gain stays editable while muted.
    expect(markup).toContain('aria-label="Microphone gain"')
    expect(render()).not.toContain('data-muted')
  })

  it('shows the mute hotkey as a key chip only when one is bound', () => {
    expect(render()).not.toContain('data-accelerator')
    const bound = render({ muteShortcut: 'CmdOrCtrl+Shift+M', platform: 'darwin' })
    expect(bound).toContain('data-accelerator="CmdOrCtrl+Shift+M"')
    expect(bound).toContain('⇧⌘M')
  })

  it('turns the microphone Off in words, and shows the live switch status (S1.9)', () => {
    const off = render({ value: undefined, selectedName: undefined })
    expect(off).toContain('>Off</span>')
    expect(off).not.toContain('>None<')
    const switching = render({
      switchStatus: createElement('span', { role: 'status' }, 'Preparing Studio Mic…')
    })
    expect(switching).toContain('Preparing Studio Mic…')
    expect(switching.indexOf('role="combobox"')).toBeLessThan(switching.indexOf('Preparing'))
    expect(switching.indexOf('Preparing')).toBeLessThan(switching.indexOf('role="meter"'))
  })

  it('spans the picker with the meter alone: the only dB readout is Gain', () => {
    for (const meter of [
      { kind: 'value', peakDb: -12 } as const,
      { kind: 'source', source: createFrameEmitter<MeterFrame>() } as const
    ]) {
      const markup = render({ meter })
      expect(markup).not.toContain('data-slot="db-readout"')
      expect(markup.match(/ dB</g)).toHaveLength(1)
      expect(markup).toMatch(/class="[^"]*\bflex-1\b[^"]*"[^>]*data-slot="level-meter"/)
      expect(markup).not.toContain('data-slot="lcd-display"')
    }
  })

  it('names the signal state for screen readers and the perf probe, off screen', () => {
    const markup = render({
      meter: { kind: 'source', source: createFrameEmitter<MeterFrame>() },
      monitorState: 'live'
    })
    expect(markup).toContain(
      '<span class="sr-only" data-videorc-mic-monitor-state="live">Receiving</span>'
    )
    expect(render({ monitorState: 'muted' })).toContain(
      'data-videorc-mic-monitor-state="muted">Muted</span>'
    )
  })
})

describe('Audio section: System audio row (plan 201 S2)', () => {
  const systemAudioRow = (
    input: Partial<SystemAudioSwitchInput> = {},
    overrides: Partial<SystemAudioRowProps> = {}
  ): string => row(render({}, systemAudioProps(input, overrides)), 'studio-system-audio')
  const toggle = (markup: string): string =>
    /<button[^>]*role="switch"[^>]*>/.exec(markup)?.[0] ?? ''

  it('shows the switch, and while On its meter and Gain; Off, neither', () => {
    const on = systemAudioRow()
    expect(toggle(on)).toContain('aria-label="System audio"')
    expect(toggle(on)).toContain('aria-checked="true"')
    expect(on).toContain('>On</span>')
    expect(on).toContain('aria-label="System audio level"')
    expect(on).toContain('aria-label="System audio gain"')
    const off = systemAudioRow({ requested: false })
    expect(toggle(off)).toContain('aria-checked="false"')
    expect(off).not.toContain('aria-label="System audio level"')
    expect(off).not.toContain('aria-label="System audio gain"')
  })

  it('puts the idle line under the resting meter, above Gain', () => {
    const markup = systemAudioRow(
      {},
      { idleLine: createElement(SystemAudioIdleLine, { reason: 'clips-off' }) }
    )
    const line = markup.indexOf('Level shows while you record, go live, or keep Clips on.')
    expect(line).toBeGreaterThan(markup.indexOf('aria-label="System audio level"'))
    expect(line).toBeLessThan(markup.indexOf('aria-label="System audio gain"'))
    expect(markup).toMatch(
      /class="text-xs text-muted-foreground" data-videorc-studio-system-audio-idle/
    )
  })

  it('says the line only when Clips is off, never while it restarts', () => {
    expect(
      renderToStaticMarkup(createElement(SystemAudioIdleLine, { reason: 'clips-off' }))
    ).toContain('keep Clips on')
    expect(renderToStaticMarkup(createElement(SystemAudioIdleLine, { reason: null }))).toBe('')
  })

  it('disables the switch and Gain with the reason, and opens Permissions, without the grant', () => {
    const section = render(
      {},
      systemAudioProps({ device: { status: 'permission-required' } }, { gainDb: -12 })
    )
    const markup = row(section, 'studio-system-audio')
    expect(toggle(markup)).toContain('disabled=""')
    expect(section).toMatch(
      /data-disabled="true"[^>]*data-slot="source-item"[^>]*data-source="studio-system-audio"/
    )
    expect(markup).toContain('>Needs permission</span>')
    expect(markup).toContain('System audio needs Screen Recording permission.')
    expect(markup).toContain('>Open Permissions</button>')
    // Sources' hint points at that page's alert; the Studio row has its own.
    expect(markup).not.toContain('Turn it on above')
    expect(markup).not.toContain('aria-label="System audio level"')
    expect(markup).toContain('aria-label="System audio gain"')
    expect(markup).toMatch(
      /data-disabled=""[^>]*data-slot="fader"|data-slot="fader"[^>]*data-disabled=""/
    )
    // No reset on a disabled fader.
    expect(markup).not.toContain('Reset to')
  })

  it('shows Paused with Resume after the echo guard, on a Clips bus too (plan 076)', () => {
    const markup = systemAudioRow({ audioBusActive: true, confirmed: false, issue: 'echo' })
    expect(markup).toContain('>Paused</span>')
    expect(markup).toContain('coming back as an echo')
    expect(markup).toContain('>Resume</button>')
    expect(toggle(markup)).toContain('aria-checked="true"')
  })

  it('says a lost or bypassed source in words, with no action', () => {
    const lost = systemAudioRow({ audioBusActive: true, confirmed: false, issue: 'lost' })
    expect(lost).toContain('>Stopped</span>')
    expect(lost).toContain('System audio stopped. Your recording or livestream keeps going.')
    expect(lost).not.toContain('<button class="[^"]*"[^>]*>Resume')
    const bypassed = systemAudioRow({ audioBusActive: true, confirmed: false, issue: 'bypassed' })
    expect(bypassed).toContain('>Off until you stop</span>')
    expect(bypassed).toContain(
      'System audio is off until you stop, because the microphone is on a fallback input.'
    )
    for (const markup of [lost, bypassed]) {
      expect(markup).not.toContain('>Resume</button>')
      expect(markup).not.toContain('>Open Permissions</button>')
    }
  })

  it('offers Open Permissions for a failed start on macOS only', () => {
    const failed = { audioBusActive: true, confirmed: false, issue: 'unavailable' as const }
    expect(systemAudioRow(failed)).toContain('>Open Permissions</button>')
    expect(systemAudioRow(failed, { platform: 'win32' })).not.toContain('Open Permissions')
  })

  it('shows Turning on… while a session confirms the change', () => {
    const markup = systemAudioRow({ audioBusActive: true, confirmed: false })
    expect(markup).toContain('>Turning on…</span>')
  })
})

describe('Audio section: resets (plan 201 S2)', () => {
  let container: HTMLDivElement | null = null
  afterEach(() => {
    container?.remove()
    container = null
    vi.unstubAllGlobals()
  })

  async function mount(
    microphone: Partial<MicrophoneRowProps>,
    systemAudio: SystemAudioRowProps
  ): Promise<() => Promise<void>> {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(AudioSectionView, {
            microphone: microphoneProps(microphone),
            systemAudio
          })
        )
      )
    })
    return () => act(async () => root.unmount())
  }

  it('resets Microphone Gain to 0 dB and System audio Gain to −6 dB', async () => {
    const microphoneGain: number[] = []
    const systemAudioGain: number[] = []
    const unmount = await mount(
      { gainDb: 6, onGainChange: (gainDb) => microphoneGain.push(gainDb) },
      systemAudioProps({}, { gainDb: -12, onGainChange: (gainDb) => systemAudioGain.push(gainDb) })
    )
    const resets = [...(container?.querySelectorAll('button') ?? [])].filter((button) =>
      button.textContent?.includes('Reset to')
    )
    expect(resets.map((button) => button.textContent)).toEqual([
      '+6.0 dB. Reset to 0.0 dB',
      '−12.0 dB. Reset to −6.0 dB'
    ])
    await act(async () => resets.forEach((button) => button.click()))
    expect(microphoneGain).toEqual([0])
    expect(systemAudioGain).toEqual([-6])
    await unmount()
  })
})

describe('AudioSection (plan 201 S2)', () => {
  function setCore(overrides: Record<string, unknown> = {}): void {
    mocked.core = {
      captureConfig: {
        ...defaultCaptureConfig,
        sources: {
          ...defaultCaptureConfig.sources,
          microphoneId: 'mic-1',
          microphoneName: 'Studio Mic'
        },
        audio: { ...defaultCaptureConfig.audio, systemAudioEnabled: true }
      },
      setCaptureConfig: vi.fn(),
      switchSourceDeviceLive: vi.fn(),
      sourceSwitchReason: () => null,
      sourceSelectionState: { pending: null, checking: false, error: null, snapshot: null },
      retrySourceStatus: vi.fn(),
      deviceList: { devices: [...microphones, systemAudioDevice], warnings: [] },
      selectedMicrophone: microphones[0],
      settings: {},
      runtimeInfo: { platform: 'darwin' },
      wsStatus: 'connected',
      isSessionActive: false,
      audioBusActive: false,
      systemAudioConfirmed: null,
      systemAudioIssue: null,
      ...overrides
    }
  }
  function setClips(armed: boolean, state: ReplayBufferState): void {
    mocked.clips = { armed, state: { state, seconds: 60, bufferedSeconds: 0 } }
  }
  const renderSection = (): string => renderToStaticMarkup(createElement(AudioSection))
  const IDLE_LINE = 'data-videorc-studio-system-audio-idle'

  it('says when the level moves while Clips is off or gave up, under a resting meter', () => {
    setCore()
    for (const [armed, state] of [
      [false, 'off'],
      [true, 'error']
    ] as const) {
      setClips(armed, state)
      const markup = renderSection()
      expect(markup).toContain(IDLE_LINE)
      expect(markup).toContain('data-videorc-studio-system-audio-level=""')
    }
  })

  it('keeps the line away while Clips starts, restarts or runs', () => {
    setCore()
    setClips(true, 'starting')
    expect(renderSection()).not.toContain(IDLE_LINE)
    // Armed but off for a moment: a source change restarts the ring.
    setClips(true, 'off')
    expect(renderSection()).not.toContain(IDLE_LINE)
    setCore({ audioBusActive: true, systemAudioConfirmed: true })
    setClips(true, 'on')
    const running = renderSection()
    expect(running).not.toContain(IDLE_LINE)
    expect(running).toContain('data-videorc-studio-system-audio-level=""')
  })

  it('follows the running Clips bus for System audio while transport stays idle', () => {
    setCore({ audioBusActive: true, systemAudioConfirmed: false, systemAudioIssue: 'echo' })
    setClips(true, 'on')
    const markup = renderSection()
    expect(markup).toContain('>Paused</span>')
    expect(markup).toContain('>Resume</button>')
    expect(mocked.core.isSessionActive).toBe(false)
  })

  it('shows the Microphone only where System audio is not listed', () => {
    setCore({ deviceList: { devices: microphones, warnings: [] } })
    const markup = renderSection()
    expect(markup).toContain('>Audio</h2>')
    expect(markup).not.toContain('data-videorc-studio-system-audio')
  })

  it('keeps the Retro LCD Microphone screen until S3 draws Audio there', () => {
    setCore({ settings: { retroLcdStudio: true } })
    const markup = renderSection()
    expect(markup).toContain('data-videorc-studio-mic-mute=""')
    expect(markup).not.toContain('>Audio</h2>')
    expect(markup).not.toContain('data-videorc-studio-system-audio')
  })
})
