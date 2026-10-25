import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import type { Device, SourceSelection } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import type { MeterInput } from '@/lib/mic-meter-input'
import {
  RetroMicrophoneSectionView,
  RetroQuickSettings,
  RetroTakeoverSection
} from './retro-lcd-studio'

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

function renderMicrophone(
  meter: MeterInput,
  overrides: Partial<Parameters<typeof RetroMicrophoneSectionView>[0]> = {}
): string {
  return renderToStaticMarkup(
    createElement(RetroMicrophoneSectionView, {
      devices: microphones,
      value: 'mic-1',
      selectedName: 'Studio Mic',
      disabled: false,
      discoveryPending: false,
      meter,
      monitorState: 'live',
      muted: false,
      onChange: noop,
      onMutedChange: noop,
      ...overrides
    })
  )
}

const screens = (markup: string): number => markup.match(/data-slot="lcd-display"/g)?.length ?? 0
const rowLabels = (markup: string): string[] =>
  [...markup.matchAll(/data-slot="lcd-display-row"[^>]*><(?:label|span)[^>]*>([^<]+)</g)].map(
    (match) => match[1] as string
  )

describe('Retro LCD Microphone (plan 197)', () => {
  it('puts the title, the mute, the dropdown and the level on one screen', () => {
    for (const meter of [
      { kind: 'value', peakDb: -12 } as const,
      { kind: 'source', source: createFrameEmitter<MeterFrame>() } as const
    ]) {
      const markup = renderMicrophone(meter)
      expect(screens(markup)).toBe(1)
      // The title is on the screen, still the section's h2.
      expect(markup).toMatch(/<h2[^>]*>Microphone<\/h2>/)
      const order = ['<h2', 'Mute microphone', 'role="combobox"', 'role="meter"'].map((part) =>
        markup.indexOf(part)
      )
      expect(order).toEqual([...order].sort((left, right) => left - right))
      // The row says Mic; the dropdown keeps Microphone as its name.
      expect(rowLabels(markup)).toEqual(['Mic'])
      expect(/<button[^>]*role="combobox"[^>]*>/.exec(markup)?.[0]).toContain(
        'aria-label="Microphone"'
      )
      // The probes' hooks are where they always were.
      expect(markup).toMatch(/data-videorc-mic-visualizer=""/)
      expect(markup).toContain('data-videorc-mic-monitor-state="live"')
      expect(markup).not.toContain('data-slot="lcd-meter-scale"')
    }
  })

  it('says Muted in words on an inverted key, and dims the level', () => {
    const markup = renderMicrophone(
      { kind: 'value', peakDb: Number.NEGATIVE_INFINITY },
      { muted: true, muteShortcut: 'CmdOrCtrl+Shift+M', platform: 'darwin' }
    )
    const mute = /<button[^>]*aria-label="Mute microphone"[^>]*>/.exec(markup)?.[0] ?? ''
    expect(mute).toContain('aria-pressed="true"')
    expect(mute).toContain('data-videorc-studio-mic-mute=""')
    expect(markup).toContain('<span>Muted</span>')
    expect(markup).toContain('⇧⌘M')
    expect(markup).toMatch(/class="opacity-50"[^>]*data-muted=""[^>]*data-videorc-mic-level/)
  })

  it('shows the live switch status on the screen, under the dropdown', () => {
    const markup = renderMicrophone(
      { kind: 'value', peakDb: -12 },
      { switchStatus: createElement('span', { role: 'status' }, 'Preparing Studio Mic…') }
    )
    expect(markup.indexOf('role="combobox"')).toBeLessThan(markup.indexOf('Preparing'))
    expect(markup.indexOf('Preparing')).toBeLessThan(markup.indexOf('role="meter"'))
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
    expect(rowLabels(sources ?? '')).toEqual(['Screen', 'Camera', 'System audio'])
    for (const label of ['Screen', 'Camera']) {
      expect(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(markup)?.[0]).toContain(
        'role="combobox"'
      )
    }
    expect(sources).toContain('title="Display 2"')
    // System audio is a switch that reads On or Off itself.
    expect(sources).toMatch(/role="switch"[^>]*>Off</)
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
