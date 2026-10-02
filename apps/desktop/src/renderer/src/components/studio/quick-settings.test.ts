import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { Device, SourceSelection } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import { systemAudioSwitchView, type SystemAudioSwitchInput } from '@/lib/system-audio'
import { QuickSettings, SystemAudioInspectorValue } from './quick-settings'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/components/workspace-nav', () => ({
  useWorkspaceNav: () => ({ openSettings: vi.fn() })
}))

const noop = (): void => {}

function render(input: Partial<SystemAudioSwitchInput>): string {
  const view = systemAudioSwitchView({
    device: { status: 'available' },
    requested: false,
    sessionActive: false,
    confirmed: null,
    issue: null,
    ...input
  })
  return renderToStaticMarkup(
    createElement(SystemAudioInspectorValue, {
      view,
      onEnabledChange: noop,
      onOpenPermissions: noop,
      onResume: noop
    })
  )
}

describe('Studio inputs System audio row (plan 069)', () => {
  it('shows Off and On beside a labelled switch', () => {
    expect(render({})).toContain('>Off<')
    expect(render({})).toContain('aria-label="System audio"')
    expect(render({ requested: true })).toContain('>On<')
    expect(render({ requested: true })).toContain('aria-checked="true"')
  })

  it('offers the permission route instead of a switch without Screen Recording', () => {
    const markup = render({ device: { status: 'permission-required' }, requested: true })
    expect(markup).toContain('Needs permission')
    expect(markup).not.toContain('role="switch"')
  })

  it('keeps a lost source On with a short status and the full copy on hover', () => {
    const markup = render({ requested: true, sessionActive: true, confirmed: false, issue: 'lost' })
    expect(markup).toContain('>Stopped<')
    expect(markup).toContain('title="System audio stopped. The session keeps going."')
    expect(markup).toContain('aria-checked="true"')
  })

  it('puts Resume where the status goes when the echo guard paused it (plan 076)', () => {
    const markup = render({ requested: true, sessionActive: true, confirmed: false, issue: 'echo' })
    expect(markup).toContain('>Resume<')
    expect(markup).toContain('coming back as an echo')
    expect(markup).toContain('aria-checked="true"')
  })

  it('says a fallback microphone keeps system audio out of this session', () => {
    const markup = render({
      requested: true,
      sessionActive: true,
      confirmed: false,
      issue: 'bypassed'
    })
    expect(markup).toContain('>Off for this session<')
    expect(markup).toContain(
      'title="System audio is off for this session because the microphone is on a fallback input."'
    )
  })
})

describe('Studio Inputs rows (plan 080 S4)', () => {
  const display: Device = { id: 'screen:2', name: 'Display 2', kind: 'screen', status: 'available' }
  const camera: Device = {
    id: 'camera:1',
    name: 'MacBook Pro Camera',
    kind: 'camera',
    status: 'available'
  }

  function renderInputs(sources: SourceSelection, devices: Device[] = [display, camera]): string {
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
      selectedMicrophone: undefined,
      patchVideo: vi.fn(),
      isSessionActive: false,
      entitlements: null,
      captionsStatus: { state: 'idle' },
      captionsCommandPending: false,
      wsStatus: 'connected',
      systemAudioConfirmed: null,
      systemAudioIssue: null
    }
    return renderToStaticMarkup(createElement(QuickSettings))
  }

  const rowLabels = (markup: string): string[] =>
    [...markup.matchAll(/data-slot="inspector-row".*?<span[^>]*>([^<]+)<\/span>/g)].map(
      (match) => match[1] as string
    )

  it('gives screen and camera their own rows, in order', () => {
    const systemAudio: Device = {
      id: 'system-audio',
      name: 'System audio',
      kind: 'system-audio',
      status: 'available'
    }
    const markup = renderInputs({ screenId: 'screen:2', cameraId: 'camera:1' }, [
      display,
      camera,
      systemAudio
    ])
    // The microphone has one home, the Microphone section above (plan 092).
    expect(rowLabels(markup)).toEqual(['Screen', 'Camera', 'System audio', 'Output', 'Captions'])
    expect(markup).not.toContain('Mute microphone')
    expect(markup).toContain('title="Display 2"')
    expect(markup).toContain('title="MacBook Pro Camera"')
    // The old joined trigger ("Display 2 · MacBook Pro Camera") is gone.
    expect(markup).not.toContain('Display 2 · MacBook Pro Camera')
  })

  it('opens Screen and Camera with one click: the row control is the dropdown', () => {
    // Owner, 2026-09-30: "for screen we're opening two dropdowns, it should
    // just be one ... same for camera". No popover wraps a second select.
    const markup = renderInputs({ screenId: 'screen:2', cameraId: 'camera:1' })
    for (const label of ['Screen', 'Camera']) {
      const trigger = new RegExp(`<button[^>]*role="combobox"[^>]*aria-label="${label}"`)
      expect(markup).toMatch(trigger)
    }
    const rows = markup.split('data-slot="inspector-row"')
    for (const row of rows.slice(1, 3)) {
      expect(row).not.toContain('aria-haspopup="dialog"')
    }
  })

  it('shows Off for no camera, and the saved name for a missing one', () => {
    expect(renderInputs({ screenId: 'screen:2', cameraOff: true })).toContain('title="Off"')
    expect(
      renderInputs({ screenId: 'screen:2', cameraId: 'camera:gone', cameraName: 'Cam Link 4K' })
    ).toContain('title="Cam Link 4K"')
  })

  it('names the test pattern and a missing screen instead of going blank', () => {
    expect(renderInputs({ testPattern: true, cameraOff: true })).toContain('title="Test pattern"')
    expect(renderInputs({ screenId: 'screen:gone', screenName: 'Display 3' })).toContain(
      'title="Display 3"'
    )
  })
})
