// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { Device } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import { normalizeSceneVisual, type SavedScene } from '@/lib/scene-presets'
import { SRT_CAMERA_ID } from '@/lib/srt-input-view'
import {
  screenSceneLine,
  VideoSources,
  VideoSourcesView,
  type VideoSourcesViewProps
} from './video-sources'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioPreview: () => ({
    previewCameraStatus: { state: 'idle' },
    previewCameraLowFrameRate: false,
    previewScreenStatus: { state: 'live', width: 1920, height: 1080 }
  }),
  useStudioDiagnostics: () => ({ diagnosticStats: null })
}))
const openWorkspaceTab = vi.hoisted(() => vi.fn())
vi.mock('@/lib/workspace-navigation', () => ({ openWorkspaceTab }))

// Plan 173: the Video column, Screen and Camera as SourceItems.

const noop = (): void => {}

const screens: Device[] = [
  { id: 'screen:1', name: 'Display 1', kind: 'screen', status: 'available' },
  { id: 'window:9', name: 'Notes - Script', kind: 'window', status: 'available' }
]
const cameras: Device[] = [
  { id: 'cam:built-in', name: 'MacBook Pro Camera', kind: 'camera', status: 'available' }
]

function render(overrides: Partial<VideoSourcesViewProps> = {}): string {
  const props: VideoSourcesViewProps = {
    sessionActive: false,
    discoveryPending: false,
    screen: {
      devices: screens,
      value: 'screen:1',
      selectedName: 'Display 1',
      allowNone: true,
      disabled: false,
      status: { label: 'Receiving', tone: 'good' },
      facts: '2560 × 1664',
      onChange: noop
    },
    camera: {
      devices: cameras,
      value: 'cam:built-in',
      selectedName: 'MacBook Pro Camera',
      disabled: false,
      status: { label: 'Receiving', tone: 'good' },
      facts: '1920 × 1080 · 30 fps',
      shortfall: null,
      onChange: noop
    },
    synthetic: null,
    ...overrides
  }
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(VideoSourcesView, props))
  )
}

describe('Sources Video column (plan 173)', () => {
  it('is one Video section with a Screen row, then a Camera row', () => {
    const markup = render()
    expect(markup).toContain('>Video<')
    expect(markup).toContain('data-slot="grouped-list"')
    const screen = markup.indexOf('data-source="screen"')
    const camera = markup.indexOf('data-source="camera"')
    expect(screen).toBeGreaterThan(-1)
    expect(camera).toBeGreaterThan(screen)
    expect(markup).toContain('>Screen<')
    expect(markup).toContain('>Camera<')
  })

  it('keeps each picker’s accessible name while the row title names it', () => {
    const markup = render()
    expect(markup).toMatch(/<label[^>]*class="[^"]*sr-only[^"]*"[^>]*>Screen \/ window<\/label>/)
    expect(markup).toMatch(/<label[^>]*class="[^"]*sr-only[^"]*"[^>]*>Camera<\/label>/)
  })

  it('shows each live source’s status and facts', () => {
    const markup = render()
    expect(markup.match(/>Receiving</g)).toHaveLength(2)
    expect(markup).toContain('>2560 × 1664<')
    expect(markup).toContain('>1920 × 1080 · 30 fps<')
  })

  it('replaces the camera facts with its format shortfall', () => {
    const markup = render({
      camera: {
        devices: cameras,
        value: 'cam:built-in',
        disabled: false,
        status: { label: 'Receiving', tone: 'good' },
        facts: '3840 × 2160 · 25 fps',
        shortfall: 'This camera only offers 3840×2160 at 25 fps.',
        onChange: noop
      }
    })
    expect(markup).toContain('This camera only offers 3840×2160 at 25 fps.')
    expect(markup).not.toContain('3840 × 2160 · 25 fps')
    // A warning is an Alert, never amber text (plan 174 S3.8).
    expect(markup).toMatch(/data-slot="alert"[^>]*data-variant="warning"/)
  })

  it('says Not found with its hint for a missing camera', () => {
    const markup = render({
      camera: {
        devices: cameras,
        value: 'cam:unplugged',
        selectedName: 'Cam Link 4K',
        disabled: false,
        status: {
          label: 'Not found',
          tone: 'warn',
          hint: "It isn't connected. Reconnect it, or choose another."
        },
        facts: null,
        shortfall: null,
        onChange: noop
      }
    })
    expect(markup).toContain('>Not found<')
    expect(markup).toContain('It isn&#x27;t connected. Reconnect it, or choose another.')
  })

  it('locks the screen picker while nothing can be captured, with no alert in the column', () => {
    const markup = render({
      screen: {
        devices: screens.map((device) => ({ ...device, status: 'permission-required' as const })),
        value: undefined,
        allowNone: true,
        disabled: true,
        status: null,
        facts: null,
        onChange: noop
      }
    })
    // The page's permission alert carries the fix (plan 174 S3.8).
    expect(markup).not.toContain('data-slot="alert"')
    expect(markup).toMatch(
      /data-disabled="true"[^>]*data-slot="source-item"[^>]*data-source="screen"/
    )
  })

  it('says how a live switch lands only while a session runs', () => {
    expect(render()).not.toContain('takes over once it sends fresh frames')
    expect(render({ sessionActive: true })).toContain(
      'A new source takes over once it sends fresh frames.'
    )
  })

  it('keeps the development synthetic switch visible for the smokes', () => {
    expect(render()).not.toContain('data-videorc-synthetic-source-toggle')
    const markup = render({ synthetic: { checked: false, disabled: false, onChange: noop } })
    const toggle = markup.match(/<span[^>]*data-videorc-synthetic-source-toggle[^>]*>/)?.[0]
    expect(toggle).toContain('role="switch"')
    expect(toggle).toContain('aria-checked="false"')
  })

  it('shows the low-light switch only for a camera that has the control (issue #1066)', () => {
    expect(render()).not.toContain('Low-light compensation')
    const camera = {
      devices: cameras,
      value: 'cam:built-in',
      selectedName: 'MacBook Pro Camera',
      disabled: false,
      status: { label: 'Receiving', tone: 'good' as const },
      facts: null,
      shortfall: null,
      onChange: noop
    }
    const off = render({
      camera: { ...camera, lowLight: { checked: false, disabled: false, onChange: noop } }
    })
    expect(off).toContain('>Low-light compensation<')
    expect(off).toContain('may drop to half its frame rate')
    const offToggle = off.match(/<span[^>]*data-videorc-camera-low-light-toggle[^>]*>/)?.[0]
    expect(offToggle).toContain('role="switch"')
    expect(offToggle).toContain('aria-checked="false"')
    const on = render({
      camera: { ...camera, lowLight: { checked: true, disabled: false, onChange: noop } }
    })
    const onToggle = on.match(/<span[^>]*data-videorc-camera-low-light-toggle[^>]*>/)?.[0]
    expect(onToggle).toContain('aria-checked="true"')
  })

  // Plan 250 option B: Sources is the home of every camera, so the SRT
  // Camera's own settings sit on the Camera row, only while it is picked.
  it("shows the SRT Camera's settings on the Camera row only while it is picked", () => {
    const srtFields = createElement('div', { 'data-testid': 'srt-fields' })
    const base = {
      devices: cameras,
      disabled: false,
      status: null,
      facts: 'Waiting for SRT stream on port 9000',
      shortfall: null,
      onChange: noop,
      srtFields
    }
    const picked = render({
      camera: { ...base, value: SRT_CAMERA_ID, selectedName: 'SRT Camera (port 9000)' }
    })
    const row = picked.slice(picked.indexOf('data-source="camera"'))
    expect(row).toContain('data-testid="srt-fields"')
    expect(row.indexOf('srt-fields')).toBeGreaterThan(row.indexOf('Waiting for SRT stream'))
    const other = render({
      camera: { ...base, value: 'cam:built-in', selectedName: 'MacBook Pro Camera' }
    })
    expect(other).not.toContain('srt-fields')
  })
})

describe('Sources → Screen names the scene it belongs to (plan 231 D2, D8)', () => {
  const scene = { name: 'Figma', showsScreen: true }

  it('says the screen is the scene on stream’s, and that each scene keeps its own', () => {
    expect(screenSceneLine(scene)).toBe(
      'Shown by “Figma”, the scene on stream. Each scene keeps its own screen.'
    )
    // A layout that draws no screen: the capture running under it (D18) isn't its screen.
    expect(screenSceneLine({ name: 'Camera only', showsScreen: false })).toBe(
      '“Camera only”, the scene on stream, shows no screen. Each scene keeps its own screen.'
    )
  })

  it('puts the line under the picker, with Open Scenes, and keeps the facts', () => {
    const markup = render({
      screen: {
        devices: screens,
        value: 'screen:1',
        selectedName: 'Display 1',
        allowNone: true,
        disabled: false,
        status: { label: 'Receiving', tone: 'good' },
        facts: '2560 × 1664',
        scene,
        onOpenScenes: noop,
        onChange: noop
      }
    })
    const line = markup.match(/<p[^>]*data-slot="screen-scene"[^>]*>(.*?)<\/p>/)?.[1] ?? ''
    expect(line).toContain(
      'Shown by “Figma”, the scene on stream. Each scene keeps its own screen.'
    )
    expect(line).toMatch(/<button[^>]*>Open Scenes<\/button>/)
    expect(markup.indexOf('data-slot="screen-scene"')).toBeGreaterThan(
      markup.indexOf('Screen / window')
    )
    expect(markup).toContain('>2560 × 1664<')
    // Before the library is read, no line.
    expect(render()).not.toContain('data-slot="screen-scene"')
  })

  it('keeps the permission lock: the picker stays locked, the line still says whose it is', () => {
    const markup = render({
      screen: {
        devices: screens.map((device) => ({ ...device, status: 'permission-required' as const })),
        value: undefined,
        allowNone: true,
        disabled: true,
        status: null,
        facts: null,
        scene,
        onChange: noop
      }
    })
    expect(markup).toMatch(
      /data-disabled="true"[^>]*data-slot="source-item"[^>]*data-source="screen"/
    )
    expect(markup).toContain('Shown by “Figma”')
  })
})

describe('Sources → Screen, wired to the studio (plan 231 D2)', () => {
  let root: Root
  let container: HTMLDivElement
  const listed = (id: string, name: string, layoutPreset: 'screen-camera' | 'camera-only') =>
    ({
      id,
      name,
      createdAt: '2026-11-15',
      updatedAt: '2026-11-15',
      visual: normalizeSceneVisual({
        layout: { ...defaultCaptureConfig.layout, layoutPreset },
        sources: { screenId: 'screen:screencapturekit:1', screenName: 'Display 1' },
        background: null
      })
    }) satisfies SavedScene
  const devices: Device[] = [
    { id: 'screen:screencapturekit:1', name: 'Display 1', kind: 'screen', status: 'available' },
    { id: 'screen:screencapturekit:2', name: 'Display 2', kind: 'screen', status: 'available' }
  ]

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    openWorkspaceTab.mockClear()
    mocked.core = {
      deviceList: { devices },
      captureConfig: {
        ...defaultCaptureConfig,
        sources: {
          ...defaultCaptureConfig.sources,
          screenId: 'screen:screencapturekit:1',
          screenName: 'Display 1'
        }
      },
      setCaptureConfig: vi.fn(),
      isSessionActive: false,
      layoutSwitchPending: null,
      sourceDeviceSwitchPending: null,
      switchSourceDeviceLive: vi.fn(async () => undefined),
      sourceSwitchReason: () => null,
      sourceSelectionState: { pending: null, checking: false, error: null, snapshot: null },
      retrySourceStatus: vi.fn(),
      allowCaptureNone: true,
      runtimeInfo: { platform: 'darwin' },
      mediaAccess: null,
      wsStatus: 'connected',
      requestCameraLowLight: vi.fn(),
      savedScenes: [
        listed('figma', 'Figma', 'screen-camera'),
        listed('break', 'Break', 'camera-only')
      ],
      activeSavedSceneId: 'figma'
    }
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })
  const show = async (): Promise<void> => {
    await act(async () =>
      root.render(createElement(TooltipProvider, null, createElement(VideoSources)))
    )
  }
  const line = () => container.querySelector('[data-slot="screen-scene"]')?.textContent

  it('follows the scene on stream as it changes', async () => {
    await show()
    expect(line()).toContain('Shown by “Figma”, the scene on stream.')
    mocked.core.activeSavedSceneId = 'break'
    await show()
    expect(line()).toContain('“Break”, the scene on stream, shows no screen.')
    mocked.core.savedScenes = [
      ...(mocked.core.savedScenes as SavedScene[]),
      listed('t3', 'T3 Code', 'screen-camera')
    ]
    mocked.core.activeSavedSceneId = 't3'
    await show()
    expect(line()).toContain('Shown by “T3 Code”, the scene on stream.')
  })

  it('changes that scene’s screen through the Screen pick, and opens Studio’s Scenes', async () => {
    await show()
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-source="screen"] button[aria-haspopup]'
    )!
    await act(async () => trigger.click())
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
      entry.textContent?.includes('Display 2')
    )!
    expect(option).toBeTruthy()
    await act(async () => option.click())
    // D2: the pick S2 made edit the scene on stream (switchSourceDeviceLive).
    expect(mocked.core.switchSourceDeviceLive).toHaveBeenCalledExactlyOnceWith(
      'capture',
      expect.objectContaining({ screenId: 'screen:screencapturekit:2' })
    )

    const open = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Open Scenes'
    )!
    await act(async () => open.click())
    expect(openWorkspaceTab).toHaveBeenCalledExactlyOnceWith('studio')
  })
})
