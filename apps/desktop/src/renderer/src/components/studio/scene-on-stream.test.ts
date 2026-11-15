// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { Device, LayoutSettings, ScreenPrivacy, SourceSelection } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import type { Scene, SceneShows } from '@/lib/scenes'
import { SCREEN_HIDE_UNAVAILABLE } from '@/lib/studio-actions/privacy'
import { SceneOnStreamFields } from './scene-on-stream'

// Plan 231 D8 (S6): under Studio's scene cards, the scene on stream's own
// fields. Screen says what the scene shows, with Change… and Hide screen
// (moved here from Studio's Screen row, plan 210 S8b); Layout saves into the
// scene on stream (D11), and asks for a screen first on a scene that shows
// none (D19); Fill or Fit; and the 9:16 layout with a vertical stream armed.

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core
}))
// The Screen Recording alert is Sources' own; here it only has to sit under Screen.
vi.mock('@/components/sources/source-permission-alerts', async () => {
  const { createElement: h } = await import('react')
  return {
    SourcePermissionAlerts: ({ only }: { only?: string }) =>
      h('div', { 'data-permission-alert': only })
  }
})
const toastUserError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/user-error', () => ({ toastUserError }))

const display: Device = {
  id: 'screen:screencapturekit:2',
  name: 'Display 2',
  kind: 'screen',
  status: 'available'
}
const display3: Device = {
  id: 'screen:screencapturekit:3',
  name: 'Display 3',
  kind: 'screen',
  status: 'available'
}
const camera: Device = { id: 'camera:1', name: 'FaceTime', kind: 'camera', status: 'available' }

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Element.prototype.scrollIntoView = vi.fn()
  toastUserError.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const figma: SceneShows = {
  kind: 'app',
  bundleId: 'com.figma.Desktop',
  name: 'Figma',
  follows: true
}

function stored(
  shows: SceneShows,
  horizontal: Partial<LayoutSettings> = {},
  vertical: Partial<LayoutSettings> = {}
): Scene {
  return {
    id: 'figma',
    name: 'Figma',
    createdAt: '2026-11-15',
    updatedAt: '2026-11-15',
    shows,
    layouts: {
      horizontal: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-camera', ...horizontal },
      vertical: {
        ...defaultCaptureConfig.layout,
        layoutPreset: 'vertical-camera-top',
        verticalScreenFraming: 'fit',
        ...vertical
      }
    },
    background: null
  }
}

function core(
  extra: {
    privacy?: ScreenPrivacy
    sources?: SourceSelection
    shows?: SceneShows
    layout?: Partial<LayoutSettings>
    screenHideToggle?: string
    wsStatus?: string
    platform?: string
    verticalStream?: boolean
  } = {}
) {
  const sources = extra.sources ?? { screenId: 'screen:screencapturekit:2', cameraId: 'camera:1' }
  const layout = { ...defaultCaptureConfig.layout, ...extra.layout }
  const hideScreen = vi.fn(async () => ({ ok: true }))
  const showScreen = vi.fn(async () => ({ ok: true }))
  const applyCameraPreset = vi.fn()
  const switchSourceDeviceLive = vi.fn(async () => undefined)
  const scene = stored(extra.shows ?? figma, layout)
  mocked.core = {
    captureConfig: {
      ...defaultCaptureConfig,
      sources,
      layout,
      ...(extra.verticalStream
        ? {
            streamEnabled: true,
            streaming: {
              ...defaultCaptureConfig.streaming,
              enabled: true,
              enabledTargetIds: ['vertical'],
              targets: [
                {
                  ...defaultCaptureConfig.streaming.targets[0]!,
                  id: 'vertical',
                  enabled: true,
                  outputOrientation: 'vertical'
                }
              ]
            }
          }
        : {})
    },
    setCaptureConfig: vi.fn(),
    switchSourceDeviceLive,
    sourceSwitchReason: () => null,
    sourceSelectionState: { pending: null, checking: false, error: null, snapshot: null },
    retrySourceStatus: vi.fn(),
    allowCaptureNone: true,
    deviceList: { devices: [display, display3, camera], warnings: [] },
    selectedCaptureDevice: [display, display3].find((device) => device.id === sources.screenId),
    applyCameraPreset,
    sceneOnStream: scene,
    savedScenes: [
      { id: scene.id, name: scene.name, visual: { layout, sources, background: null } }
    ],
    sceneLibraryActions: { readOnly: false, replace: vi.fn(() => true) },
    wsStatus: extra.wsStatus ?? 'connected',
    runtimeInfo: { platform: extra.platform ?? 'darwin' },
    settings: {
      globalShortcuts:
        'screenHideToggle' in extra ? { screenHideToggle: extra.screenHideToggle } : {}
    },
    screenPrivacy: extra.privacy ?? { hidden: false },
    hideScreen,
    showScreen
  }
  return { hideScreen, showScreen, applyCameraPreset, switchSourceDeviceLive }
}

async function render(view: () => ReactElement): Promise<void> {
  await act(async () => root.render(createElement(TooltipProvider, { delay: 0, children: view() })))
}
const fields = (props: Parameters<typeof SceneOnStreamFields>[0] = {}) =>
  createElement(SceneOnStreamFields, props)

const screenField = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-slot="scene-screen-field"]')!
const line = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-slot="screen-privacy"]')!
const button = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-videorc-screen-privacy]')!
const tooltip = (): string | null | undefined =>
  document.querySelector('[data-slot="tooltip-content"]')?.textContent
const buttonNamed = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent === text
  )
async function pick(triggerLabel: string, id: string): Promise<void> {
  const trigger = document.querySelector<HTMLElement>(`button[aria-label="${triggerLabel}"]`)!
  await act(async () => trigger.click())
  await act(async () =>
    document.querySelector<HTMLElement>(`[cmdk-item][data-value="${id}"]`)!.click()
  )
}

describe('the scene on stream’s Screen (plan 231 D8)', () => {
  it('says which scene is on stream and what it shows, in the scene’s words', async () => {
    core()
    await render(fields)
    expect(container.querySelector('[data-slot="scene-on-stream-name"]')?.textContent).toBe(
      'On stream: Figma'
    )
    expect(screenField().textContent).toContain('Screen')
    expect(screenField().textContent).toContain('Figma · front window')
    // The picker's own words never replace the scene's.
    expect(screenField().textContent).not.toContain('Display 2')
  })

  it.each([
    [
      { kind: 'display', screenId: 'screen:screencapturekit:2', screenName: 'Display 2' } as const,
      'Display 2'
    ],
    [
      { kind: 'window', windowId: 'w:1', windowName: 'Notes - Ideas' } as const,
      'Window · Notes - Ideas'
    ],
    [{ kind: 'none' } as const, 'No screen']
  ])('words %j as %s', async (shows, words) => {
    core({ shows, layout: shows.kind === 'none' ? { layoutPreset: 'camera-only' } : {} })
    await render(fields)
    expect(screenField().textContent).toContain(words)
    expect(screenField().textContent).not.toContain('Not shown in')
  })

  it('says a screen its layout doesn’t draw is still the scene’s', async () => {
    core({
      shows: { kind: 'display', screenId: 'screen:screencapturekit:2', screenName: 'Display 2' },
      layout: { layoutPreset: 'camera-only' }
    })
    await render(fields)
    expect(screenField().textContent).toContain('Display 2')
    expect(screenField().textContent).toContain('Not shown in Camera only')
  })

  it('changes the scene’s screen from Change…, the screen picker Sources uses', async () => {
    const { switchSourceDeviceLive } = core()
    await render(fields)
    const trigger = screenField().querySelector<HTMLButtonElement>(
      'button[aria-label="Change screen"]'
    )!
    expect(trigger.getAttribute('role')).toBe('combobox')
    expect(trigger.textContent).toBe('Change…')
    await pick('Change screen', 'screen:screencapturekit:3')
    expect(switchSourceDeviceLive).toHaveBeenCalledExactlyOnceWith(
      'capture',
      expect.objectContaining({ screenId: 'screen:screencapturekit:3' })
    )
  })

  it('hands Change… to the dialog a later slice gives it', async () => {
    core()
    const onChangeScreen = vi.fn()
    await render(() => fields({ onChangeScreen }))
    expect(screenField().querySelector('button[aria-label="Change screen"]')).toBeNull()
    await act(async () => buttonNamed('Change screen…')!.click())
    expect(onChangeScreen).toHaveBeenCalledOnce()
  })

  it('keeps the Screen Recording alert with the Screen', async () => {
    core()
    await render(fields)
    expect(screenField().querySelector('[data-permission-alert="screen-recording"]')).not.toBeNull()
  })

  it('shows nothing without a scene on stream', async () => {
    core()
    mocked.core.sceneOnStream = null
    await render(fields)
    expect(container.querySelector('[data-slot="scene-on-stream"]')).toBeNull()
  })
})

describe('Hide screen, under the scene’s Screen (plan 210 S8b, plan 231 D8)', () => {
  it('hides from a 24 px button with the key beside it and in its tooltip', async () => {
    const { hideScreen, showScreen } = core({ privacy: { hidden: false } })
    await render(fields)
    // With the Screen, never in the transport.
    expect(screenField().contains(line())).toBe(true)
    expect(button().textContent).toBe('Hide screen')
    expect(button().dataset.size).toBe('xs')
    expect(line().querySelector('[data-slot="status-badge"]')).toBeNull()
    expect(line().querySelector('kbd')?.dataset.accelerator).toBe('Control+Alt+H')
    await act(async () => button().focus())
    expect(tooltip()).toContain('Hide screen')
    expect(document.querySelector('[data-slot="tooltip-content"] kbd')?.textContent).toBe('⌃⌥H')
    await act(async () => button().click())
    expect(hideScreen).toHaveBeenCalledTimes(1)
    expect(showScreen).not.toHaveBeenCalled()
  })

  it('reads Show screen in the same place while hidden, and says Screen hidden', async () => {
    const { hideScreen, showScreen } = core({ privacy: { hidden: true, reason: 'you' } })
    await render(fields)
    expect(button().textContent).toBe('Show screen')
    const chip = line().querySelector<HTMLElement>('[data-slot="status-badge"]')!
    expect(chip.textContent).toBe('Screen hidden')
    // A privacy state, not an error: the attention tone on its icon, no tint.
    expect(chip.dataset.tone).toBe('warn')
    expect(chip.className).not.toContain('glass-chip-tinted')
    // The button keeps the right edge, after the chip.
    expect(line().lastElementChild?.contains(button())).toBe(true)
    await act(async () => button().click())
    expect(showScreen).toHaveBeenCalledTimes(1)
    expect(hideScreen).not.toHaveBeenCalled()
  })

  it('is disabled with the legacy recording’s reason, and shows again even then', async () => {
    core({ privacy: { hidden: false, unavailable: SCREEN_HIDE_UNAVAILABLE } })
    await render(fields)
    expect(button().disabled).toBe(true)
    const wrapper = line().querySelector<HTMLElement>('[data-slot="disabled-reason"]')!
    expect(
      document.getElementById(wrapper.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe("Hide screen isn't available on this recording. Stop and record again.")
    await act(async () => wrapper.focus())
    expect(tooltip()).toContain('Stop and record again.')

    core({ privacy: { hidden: true, unavailable: SCREEN_HIDE_UNAVAILABLE } })
    await render(fields)
    expect(button().disabled).toBe(false)
  })

  it('says Videorc is reconnecting instead of failing quietly', async () => {
    core({ wsStatus: 'connecting' })
    await render(fields)
    expect(button().disabled).toBe(true)
    expect(line().querySelector('[data-slot="disabled-reason"]')).not.toBeNull()
  })

  it('stays on a scene that shows no screen: hiding is allowed', async () => {
    core({
      shows: { kind: 'none' },
      sources: { cameraOff: true },
      layout: { layoutPreset: 'camera-only' }
    })
    await render(fields)
    expect(button().textContent).toBe('Hide screen')
    expect(button().disabled).toBe(false)
  })

  it('drops the key once it is cleared in Settings, and says a failure', async () => {
    const { hideScreen } = core({ screenHideToggle: '' })
    hideScreen.mockRejectedValueOnce(new Error('socket closed'))
    await render(fields)
    expect(line().querySelector('kbd')).toBeNull()
    await act(async () => button().focus())
    expect(document.querySelector('[data-slot="tooltip-content"] kbd')).toBeNull()
    await act(async () => button().click())
    expect(toastUserError).toHaveBeenCalledWith(
      expect.any(Error),
      { action: 'hide', object: 'your screen' },
      { id: 'screen-privacy' }
    )
  })
})

describe('the scene on stream’s Layout (plan 231 D8, D11, D19)', () => {
  const layoutRadio = (name: string): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(
      `[data-slot="scene-layout-field"] [role="radio"][aria-label="${name}"]`
    )!

  it('offers the four 16:9 layouts and saves the choice into the scene on stream', async () => {
    const { applyCameraPreset } = core()
    await render(fields)
    const field = container.querySelector('[data-slot="scene-layout-field"]')!
    expect(
      [...field.querySelectorAll('[role="radio"]')].map((radio) => radio.getAttribute('aria-label'))
    ).toEqual(['Screen + camera', 'Screen only', 'Camera only', 'Side by side'])
    expect(layoutRadio('Screen + camera').getAttribute('aria-checked')).toBe('true')
    expect(field.textContent).toContain('Screen + camera')
    await act(async () => layoutRadio('Side by side').click())
    expect(applyCameraPreset).toHaveBeenCalledExactlyOnceWith({ layoutPreset: 'side-by-side' })
  })

  it('turns off the camera layouts while the camera is off, saying why', async () => {
    core({
      sources: { screenId: 'screen:screencapturekit:2', cameraOff: true },
      layout: { layoutPreset: 'screen-only' }
    })
    await render(fields)
    expect(layoutRadio('Screen only').disabled).toBe(false)
    expect(layoutRadio('Camera only').disabled).toBe(true)
    expect(layoutRadio('Side by side').disabled).toBe(true)
    expect(layoutRadio('Screen + camera').disabled).toBe(true)
    expect(container.querySelector('[data-slot="scene-layout-field"]')!.textContent).toContain(
      'Choose a camera in Sources to use Screen + camera, Camera only, and Side by side.'
    )
  })

  it('asks for a screen first on a scene that shows none, and Cancel keeps the layout (D19)', async () => {
    const { applyCameraPreset, switchSourceDeviceLive } = core({
      shows: { kind: 'none' },
      layout: { layoutPreset: 'camera-only' }
    })
    await render(fields)
    await act(async () => layoutRadio('Screen + camera').click())
    expect(applyCameraPreset).not.toHaveBeenCalled()
    const dialog = document.querySelector('[data-testid="scene-screen-dialog"]')!
    expect(dialog.textContent).toContain('Choose a screen')
    expect(dialog.textContent).toContain(
      'Screen + camera shows a screen, and “Figma” shows none yet.'
    )
    expect(buttonNamed('Use this screen')!.disabled).toBe(true)
    await act(async () => buttonNamed('Cancel')!.click())
    expect(document.querySelector('[data-testid="scene-screen-dialog"]')).toBeNull()
    expect(applyCameraPreset).not.toHaveBeenCalled()
    expect(switchSourceDeviceLive).not.toHaveBeenCalled()

    // Again, and choose: the screen goes on first, then the layout.
    await act(async () => layoutRadio('Screen + camera').click())
    await pick('Screen', 'screen:screencapturekit:3')
    await act(async () => buttonNamed('Use this screen')!.click())
    expect(switchSourceDeviceLive).toHaveBeenCalledExactlyOnceWith(
      'capture',
      expect.objectContaining({ screenId: 'screen:screencapturekit:3' })
    )
    expect(applyCameraPreset).not.toHaveBeenCalled()
    // The pick landed: the scene shows Display 3, and the layout follows.
    mocked.core = {
      ...mocked.core,
      captureConfig: {
        ...(mocked.core.captureConfig as object),
        sources: { screenId: 'screen:screencapturekit:3', cameraId: 'camera:1' }
      },
      sceneOnStream: stored(
        { kind: 'display', screenId: 'screen:screencapturekit:3', screenName: 'Display 3' },
        { layoutPreset: 'camera-only' }
      )
    }
    await render(fields)
    expect(applyCameraPreset).toHaveBeenCalledExactlyOnceWith({ layoutPreset: 'screen-camera' })
  })

  it('needs no screen for a camera layout on a scene that shows none', async () => {
    const { applyCameraPreset } = core({
      shows: { kind: 'none' },
      layout: { layoutPreset: 'screen-only' }
    })
    await render(fields)
    await act(async () => layoutRadio('Camera only').click())
    expect(applyCameraPreset).toHaveBeenCalledExactlyOnceWith({ layoutPreset: 'camera-only' })
    expect(document.querySelector('[data-testid="scene-screen-dialog"]')).toBeNull()
  })

  it('offers Fill or Fit as Framing for the screen layouts that have it', async () => {
    const { applyCameraPreset } = core({ layout: { layoutPreset: 'screen-only' } })
    await render(fields)
    const framing = container.querySelector<HTMLElement>(
      '[data-slot="scene-on-stream"] [data-videorc-screen-framing="horizontal"]'
    )!
    expect(framing.textContent).toContain('Framing')
    const fill = [...framing.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (radio) => radio.textContent === 'Fill'
    )!
    await act(async () => fill.click())
    expect(applyCameraPreset).toHaveBeenCalledWith({ horizontalScreenFraming: 'fill' })

    core({ layout: { layoutPreset: 'side-by-side' } })
    await render(fields)
    expect(container.querySelector('[data-videorc-screen-framing]')).toBeNull()
  })

  it('in a 9:16 studio, offers the six 9:16 layouts and their Fill or Fit', async () => {
    core({ layout: { layoutPreset: 'vertical-camera-top', verticalScreenFraming: 'fill' } })
    await render(fields)
    const trigger = container.querySelector<HTMLElement>(
      '[data-slot="scene-layout-field"] [aria-label="Layout"]'
    )!
    expect(trigger.textContent).toContain('Camera top')
    expect(
      container.querySelector(
        '[data-slot="scene-on-stream"] [data-videorc-screen-framing="vertical"]'
      )
    ).not.toBeNull()
    expect(container.querySelector('[data-slot="scene-layout-field"] [role="radio"]')).toBeNull()
  })

  it('adds the scene’s 9:16 layout with a vertical stream armed beside a 16:9 studio', async () => {
    core()
    await render(fields)
    expect(container.querySelector('[data-slot="vertical-stream-layout"]')).toBeNull()
    core({ verticalStream: true })
    await render(fields)
    const vertical = container.querySelector<HTMLElement>('[data-slot="vertical-stream-layout"]')!
    expect(vertical.parentElement!.textContent).toContain('Vertical stream')
    expect(vertical.querySelector('[data-videorc-vertical-stream-layout]')?.textContent).toContain(
      'Camera top'
    )
    expect(vertical.querySelector('[data-slot="screen-framing-control"]')?.textContent).toContain(
      'Framing'
    )
  })
})

describe('Retro LCD: the scene on stream on a screen (plan 197, plan 231 S6)', () => {
  const pressRow = (): HTMLButtonElement =>
    [...container.querySelectorAll<HTMLButtonElement>('[data-slot="lcd-panel-press-row"]')].find(
      (row) => row.textContent?.startsWith('Hide screen')
    )!

  it('puts On stream, Screen, Hide screen and Layout on one screen', async () => {
    core()
    await render(() => fields({ look: 'lcd' }))
    const screen = container.querySelector(
      '[data-slot="scene-on-stream"] [data-slot="lcd-display"]'
    )!
    expect(screen).not.toBeNull()
    expect(screen.textContent).toContain('On stream')
    expect(screen.textContent).toContain('Figma')
    // On a screen a value is its own dropdown: the scene's words open the list.
    const trigger = screen.querySelector<HTMLButtonElement>('button[aria-label="Screen"]')!
    expect(trigger.getAttribute('role')).toBe('combobox')
    expect(trigger.textContent).toContain('Figma · front window')
    expect(screen.querySelector('button[aria-label="Layout"]')?.textContent).toContain(
      'Screen + camera'
    )
  })

  it('saves a layout chosen on the screen into the scene on stream', async () => {
    const { applyCameraPreset } = core()
    await render(() => fields({ look: 'lcd' }))
    await pick('Layout', 'screen-only')
    expect(applyCameraPreset).toHaveBeenCalledExactlyOnceWith({ layoutPreset: 'screen-only' })
  })

  it('hides from the screen’s own row: Off, then On lit while hidden', async () => {
    const { hideScreen } = core({ privacy: { hidden: false } })
    await render(() => fields({ look: 'lcd' }))
    expect(pressRow().textContent).toBe('Hide screenOff')
    expect(pressRow().getAttribute('aria-pressed')).toBe('false')
    await act(async () => pressRow().focus())
    expect(tooltip()).toContain('Hide screen')
    expect(document.querySelector('[data-slot="tooltip-content"] kbd')?.textContent).toBe('⌃⌥H')
    await act(async () => pressRow().click())
    expect(hideScreen).toHaveBeenCalledTimes(1)

    const shown = core({ privacy: { hidden: true, reason: 'you' } })
    await render(() => fields({ look: 'lcd' }))
    expect(pressRow().textContent).toBe('Hide screenOn')
    expect(pressRow().getAttribute('aria-pressed')).toBe('true')
    await act(async () => pressRow().click())
    expect(shown.showScreen).toHaveBeenCalledTimes(1)
  })

  it('says why a hide is refused on the screen', async () => {
    core({ privacy: { hidden: false, unavailable: SCREEN_HIDE_UNAVAILABLE } })
    await render(() => fields({ look: 'lcd' }))
    expect(pressRow().disabled).toBe(true)
    const wrapper = pressRow().closest<HTMLElement>('[data-slot="disabled-reason"]')!
    expect(
      document.getElementById(wrapper.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe(SCREEN_HIDE_UNAVAILABLE)
  })
})
