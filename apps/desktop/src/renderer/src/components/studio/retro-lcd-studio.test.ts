import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import type { Device, SourceSelection } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import type { MeterInput } from '@/lib/mic-meter-input'
import {
  SYSTEM_AUDIO_IDLE_LINE,
  systemAudioSwitchView,
  type SystemAudioSwitchInput
} from '@/lib/system-audio'
import { SystemAudioIdleLine, type SystemAudioRowProps } from './audio-section'
import { RetroAudioSectionView, RetroQuickSettings, RetroTakeoverSection } from './retro-lcd-studio'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/components/workspace-nav', () => ({
  useWorkspaceNav: () => ({ openSettings: vi.fn(), openStudioPanel: vi.fn(), setActive: vi.fn() }),
  WorkspaceNavContext: { Provider: () => null }
}))

const noop = (): void => {}
const microphones: Device[] = [
  { id: 'mic-1', name: 'Studio Mic', kind: 'microphone', status: 'available' },
  { id: 'mic-2', name: 'MacBook Pro Microphone', kind: 'microphone', status: 'available' }
]

const NO_READING: MeterInput = { kind: 'value', peakDb: Number.NaN }

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
      joining: false,
      issue: null,
      ...input
    }),
    gainDb: -6,
    meter: NO_READING,
    sessionActive: false,
    platform: 'darwin',
    onEnabledChange: noop,
    onGainChange: noop,
    onOpenPermissions: noop,
    onResume: noop,
    ...overrides
  }
}

function renderAudio(
  meter: MeterInput,
  overrides: Partial<Parameters<typeof RetroAudioSectionView>[0]['microphone']> = {},
  systemAudio: SystemAudioRowProps | null = null
): string {
  return renderToStaticMarkup(
    createElement(RetroAudioSectionView, {
      microphone: {
        devices: microphones,
        value: 'mic-1',
        selectedName: 'Studio Mic',
        disabled: false,
        discoveryPending: false,
        meter,
        monitorState: 'live',
        muted: false,
        gainDb: 0,
        onChange: noop,
        onMutedChange: noop,
        onGainChange: noop,
        ...overrides
      },
      systemAudio
    })
  )
}

/** The markup from System audio's rows on. */
const systemAudioRows = (markup: string): string =>
  markup.slice(markup.indexOf('data-videorc-studio-system-audio=""'))

const screens = (markup: string): number => markup.match(/data-slot="lcd-display"/g)?.length ?? 0
const rowLabels = (markup: string): string[] =>
  [...markup.matchAll(/data-slot="lcd-display-row"[^>]*><(?:label|span)[^>]*>([^<]+)</g)].map(
    (match) => match[1] as string
  )

describe('Retro LCD Audio (plans 197 and 201)', () => {
  it('puts the title, the mute, the dropdown, the level and Gain on one screen', () => {
    for (const meter of [
      { kind: 'value', peakDb: -12 } as const,
      { kind: 'source', source: createFrameEmitter<MeterFrame>() } as const
    ]) {
      const markup = renderAudio(meter)
      expect(screens(markup)).toBe(1)
      // The section's h2 is Audio; the Microphone is its h3.
      expect(markup).toMatch(/<h2[^>]*>Audio<\/h2>/)
      expect(markup).toMatch(/<h3[^>]*>Microphone<\/h3>/)
      const order = [
        '<h2',
        '<h3',
        'Mute microphone',
        'role="combobox"',
        'role="meter"',
        'aria-label="Microphone gain"'
      ].map((part) => markup.indexOf(part))
      expect(order).toEqual([...order].sort((left, right) => left - right))
      // The row says Device; the dropdown keeps Microphone as its name.
      expect(rowLabels(markup)).toEqual(['Device'])
      expect(/<button[^>]*role="combobox"[^>]*>/.exec(markup)?.[0]).toContain(
        'aria-label="Microphone"'
      )
      // The probes' hooks are where they always were.
      expect(markup).toMatch(/data-videorc-mic-visualizer=""/)
      expect(markup).toContain('data-videorc-mic-monitor-state="live"')
      expect(markup).not.toContain('data-slot="lcd-meter-scale"')
      // Microphone only where System audio can't run.
      expect(markup).not.toContain('data-videorc-studio-system-audio')
    }
  })

  it('says Muted in words on an inverted key, and dims the level', () => {
    const markup = renderAudio(
      { kind: 'value', peakDb: Number.NEGATIVE_INFINITY },
      { muted: true, muteShortcut: 'CmdOrCtrl+Shift+M', platform: 'darwin' }
    )
    const mute = /<button[^>]*aria-label="Mute microphone"[^>]*>/.exec(markup)?.[0] ?? ''
    expect(mute).toContain('aria-pressed="true"')
    expect(mute).toContain('data-videorc-studio-mic-mute=""')
    expect(markup).toContain('<span>Muted</span>')
    expect(markup).toContain('⇧⌘M')
    expect(markup).toMatch(/class="py-1 opacity-50"[^>]*data-muted=""[^>]*data-videorc-mic-level/)
  })

  it('shows the live switch status on the screen, under the dropdown', () => {
    const markup = renderAudio(
      { kind: 'value', peakDb: -12 },
      { switchStatus: createElement('span', { role: 'status' }, 'Preparing Studio Mic…') }
    )
    expect(markup.indexOf('role="combobox"')).toBeLessThan(markup.indexOf('Preparing'))
    expect(markup.indexOf('Preparing')).toBeLessThan(markup.indexOf('role="meter"'))
  })

  it('puts System audio under a rule on the same screen and scale, its level above Gain', () => {
    const markup = renderAudio({ kind: 'value', peakDb: -12 }, {}, systemAudioProps())
    expect(screens(markup)).toBe(1)
    // One Mixer: one scale, and Cmd/Ctrl+Up/Down between the two rows.
    expect(markup.match(/data-slot="mixer"/g)).toHaveLength(1)
    expect(markup.match(/data-slot="channel-strip"/g)).toHaveLength(2)
    const rows = systemAudioRows(markup)
    expect(
      markup.lastIndexOf(
        'data-slot="lcd-display-separator"',
        markup.indexOf('data-videorc-studio-system-audio=""')
      )
    ).toBeGreaterThan(markup.indexOf('aria-label="Microphone gain"'))
    expect(rows).toMatch(/<h3[^>]*>System audio<\/h3>/)
    expect(rows).toMatch(/role="switch"[^>]*>On</)
    const order = [
      'data-videorc-studio-system-audio-level=""',
      'aria-label="System audio level"',
      'aria-label="System audio gain"'
    ].map((part) => rows.indexOf(part))
    expect(order.every((index) => index > -1)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    // Both faders wear the screen's ink (D5), readouts with a typographic minus.
    expect(markup.match(/fader-range\]\]:bg-\(--lcd-display-lit\)/g)).toHaveLength(2)
    expect(markup).toContain('0.0 dB')
    expect(rows).toContain('−6.0 dB')
  })

  it('shows neither level nor Gain while System audio is Off', () => {
    const rows = systemAudioRows(
      renderAudio({ kind: 'value', peakDb: -12 }, {}, systemAudioProps({ requested: false }))
    )
    expect(rows).toMatch(/role="switch"[^>]*>Off</)
    expect(rows).not.toContain('data-videorc-studio-system-audio-level')
    expect(rows).not.toContain('System audio gain')
  })

  it('says when the level shows while Clips is off, in the screen ink, above Gain', () => {
    const rows = systemAudioRows(
      renderAudio(
        { kind: 'value', peakDb: -12 },
        {},
        systemAudioProps(
          {},
          { idleLine: createElement(SystemAudioIdleLine, { look: 'lcd', reason: 'clips-off' }) }
        )
      )
    )
    const line = rows.indexOf(SYSTEM_AUDIO_IDLE_LINE)
    expect(line).toBeGreaterThan(rows.indexOf('aria-label="System audio level"'))
    expect(line).toBeLessThan(rows.indexOf('aria-label="System audio gain"'))
    expect(/<p[^>]*data-videorc-studio-system-audio-idle[^>]*>/.exec(rows)?.[0]).toContain(
      'normal-case'
    )
  })

  it('routes to Permissions without the grant, with Gain disabled and no level', () => {
    const rows = systemAudioRows(
      renderAudio(
        { kind: 'value', peakDb: -12 },
        {},
        systemAudioProps({ device: { status: 'permission-required' } })
      )
    )
    expect(rows).toContain('data-videorc-studio-system-audio-issue="permission"')
    expect(rows).toContain('Needs permission')
    expect(rows).not.toContain('role="switch"')
    expect(rows).not.toContain('data-videorc-studio-system-audio-level')
    expect(/<[^>]*data-slot="fader"[^>]*>/.exec(rows)?.[0]).toContain('data-disabled')
  })

  it('offers Resume after the echo guard paused System audio (plan 076)', () => {
    const rows = systemAudioRows(
      renderAudio(
        { kind: 'value', peakDb: -12 },
        {},
        systemAudioProps({ audioBusActive: true, confirmed: false, issue: 'echo' })
      )
    )
    expect(rows).toContain('data-videorc-studio-system-audio-issue="echo"')
    expect(rows).toMatch(/<button[^>]*>[^<]*<span[^>]*>Resume<\/span>/)
  })
})

describe('Retro LCD Sources and Takeover (plan 197)', () => {
  const display: Device = { id: 'screen:2', name: 'Display 2', kind: 'screen', status: 'available' }
  const camera: Device = {
    id: 'camera:1',
    name: 'MacBook Pro Camera',
    kind: 'camera',
    status: 'available'
  }
  const systemAudio: Device = {
    id: 'system-audio',
    name: 'System audio',
    kind: 'system-audio',
    status: 'available'
  }

  function core(sources: SourceSelection, devices: Device[], extra: Record<string, unknown> = {}) {
    mocked.core = {
      captureConfig: { ...defaultCaptureConfig, sources },
      setCaptureConfig: vi.fn(),
      switchSourceDeviceLive: vi.fn(),
      sourceSwitchReason: () => null,
      sourceSelectionState: { pending: null, checking: false, error: null, snapshot: null },
      retrySourceStatus: vi.fn(),
      allowCaptureNone: true,
      deviceList: { devices, warnings: [] },
      selectedCaptureDevice: devices.find((device) => device.id === sources.screenId),
      selectedCamera: devices.find((device) => device.id === sources.cameraId),
      isSessionActive: false,
      captionsStatus: { state: 'idle' },
      wsStatus: 'connected',
      systemAudioConfirmed: null,
      systemAudioIssue: null,
      ...extra
    }
  }

  it('draws Sources on a screen with its title and the way home, and Captions on its own', () => {
    core({ screenId: 'screen:2', cameraId: 'camera:1' }, [display, camera, systemAudio])
    const markup = renderToStaticMarkup(createElement(RetroQuickSettings))
    const [sources, captions] = markup.split('data-slot="panel-section"').slice(1)
    expect(screens(sources ?? '')).toBe(1)
    expect(sources).toMatch(/<h2[^>]*>Sources<\/h2>/)
    expect(sources).toContain('>Open Sources</span>')
    // System audio is in Audio since plan 201.
    expect(rowLabels(sources ?? '')).toEqual(['Screen', 'Camera'])
    expect(sources).not.toContain('System audio')
    for (const label of ['Screen', 'Camera']) {
      expect(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(markup)?.[0]).toContain(
        'role="combobox"'
      )
    }
    expect(sources).toContain('title="Display 2"')
    expect(sources).not.toContain('role="switch"')
    // Captions: under no heading, a door to its page (B-13, B-15).
    expect(captions).not.toContain('<h2')
    expect(captions).toMatch(/data-slot="lcd-panel-nav-row"[^>]*>[\s\S]*?>Captions</)
  })

  it('switches takeovers from rows that say On or Off, and says what a click does', () => {
    const screenOf = (id: string, name: string) => ({ id, name, status: 'ready' })
    core({ screenId: 'screen:2' }, [display], {
      screens: [screenOf('brb', 'Be right back'), screenOf('end', 'Ending soon')],
      activeScreen: screenOf('brb', 'Be right back'),
      activateScreen: vi.fn(),
      clearActiveScreen: vi.fn()
    })
    const markup = renderToStaticMarkup(createElement(RetroTakeoverSection))
    expect(screens(markup)).toBe(1)
    expect(markup).toMatch(/<h2[^>]*>Takeover<\/h2>/)
    const rows = [...markup.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>/g)].map(
      (match) => match[1]
    )
    expect(rows).toEqual(['true', 'false'])
    expect(markup).toContain('Be right back is covering the output. Click it to return.')
  })

  it('points to Assets when there are no takeovers yet', () => {
    core({ screenId: 'screen:2' }, [display], {
      screens: [],
      activeScreen: null,
      activateScreen: vi.fn(),
      clearActiveScreen: vi.fn()
    })
    const markup = renderToStaticMarkup(createElement(RetroTakeoverSection))
    expect(markup).toContain('>None yet</span>')
    expect(markup).toContain('>Add in Assets</span>')
  })
})
