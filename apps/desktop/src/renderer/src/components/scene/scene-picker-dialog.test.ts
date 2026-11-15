// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BackendRequestError } from '@/backendClient'
import { resetAppIconsForTest } from '@/hooks/use-app-icons'
import type { Device } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import type { Scene } from '@/lib/scenes'
import { ScenePickerDialog, type ScenePickerMode } from './scene-picker-dialog'

// Plan 231 D6 (S7): Add scene… and Change screen…, one picker. Apps (macOS),
// Displays and the camera; several new scenes, or what one scene shows, with
// "A specific window" under Apps and No screen.

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioAudio: () => ({ audioMeter: null })
}))

let root: Root
let container: HTMLDivElement
const window = (id: string, bundleId: string, name: string, title = `${name} title`): Device => ({
  id,
  name: `${name} - ${id}`,
  windowTitle: title,
  kind: 'window',
  status: 'available',
  app: { bundleId, name, pid: 4 }
})
const display: Device = {
  id: 'screen:screencapturekit:1',
  name: 'Built-in Retina Display · 3024 × 1964',
  kind: 'screen',
  status: 'available',
  width: 3024,
  height: 1964
}
const devices: Device[] = [
  window('window:1', 'com.google.Chrome', 'Chrome', 'Inbox'),
  window('window:2', 'com.google.Chrome', 'Chrome', 'Docs'),
  window('window:3', 'com.google.Chrome', 'Chrome', 'Calendar'),
  window('window:4', 'com.figma.Desktop', 'Figma', 'Board'),
  window('window:5', 'com.t3tools.t3code', 'T3 Code', 'videorc'),
  window('window:6', 'dev.theorcdev.videorc', 'Videorc', 'Notes'),
  display,
  { id: 'camera:1', name: 'FaceTime HD Camera', kind: 'camera', status: 'available' }
]
const figmaScene = (extra: Partial<Scene> = {}): Scene => ({
  id: 'figma',
  name: 'Figma',
  createdAt: '2026-11-15',
  updatedAt: '2026-11-15',
  shows: { kind: 'app', bundleId: 'com.figma.Desktop', name: 'Figma', follows: true },
  layouts: {
    horizontal: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-camera' },
    vertical: { ...defaultCaptureConfig.layout, layoutPreset: 'vertical-camera-top' }
  },
  background: null,
  ...extra
})
const onAdd = vi.fn()
const onChange = vi.fn()
const onOpenChange = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('videorc', {
    getSelfBundleIds: async () => ['dev.theorcdev.videorc'],
    getAppIcons: async (ids: string[]) =>
      Object.fromEntries(
        ids.filter((id) => id === 'com.figma.Desktop').map((id) => [id, 'data:image/png;base64,AA'])
      )
  })
  resetAppIconsForTest()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  onAdd.mockReset()
  onChange.mockReset()
  mocked.core = {
    runtimeInfo: { platform: 'darwin' },
    deviceList: { devices },
    captureConfig: {
      ...defaultCaptureConfig,
      sources: { cameraId: 'camera:1', cameraName: 'FaceTime HD Camera' }
    },
    refreshDevices: vi.fn(async () => undefined),
    sceneLibraryActions: {
      listAppPreviews: vi.fn(async () => {
        throw new BackendRequestError('unknown-method', 'Unknown backend method')
      })
    }
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(mode: ScenePickerMode = { kind: 'add' }): Promise<void> {
  await act(async () =>
    root.render(
      createElement(ScenePickerDialog, { open: true, mode, onOpenChange, onAdd, onChange })
    )
  )
  // The previews request, the self ids and the icons settle.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}
const card = (bundleId: string) =>
  document.querySelector<HTMLButtonElement>(`[data-app-choice="${bundleId}"]`)
const pick = (key: string) => document.querySelector<HTMLButtonElement>(`[data-pick="${key}"]`)!
const cards = () =>
  [...document.querySelectorAll('[data-app-choice]')].map((entry) =>
    entry.getAttribute('data-app-choice')
  )
const groups = () =>
  [...document.querySelectorAll('[data-picker-group]')].map((entry) =>
    entry.getAttribute('data-picker-group')
  )
const primary = () =>
  document.querySelector<HTMLButtonElement>(
    '[data-testid="new-scene-add"], [data-testid="change-screen-apply"]'
  )!
const reason = () =>
  document.getElementById(
    primary().closest('[aria-describedby]')!.getAttribute('aria-describedby')!
  )?.textContent
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent === label
  )

describe('Add scene… (plan 231 D6)', () => {
  it('offers Apps, Displays and the camera, never Videorc', async () => {
    await render()
    expect(document.querySelector('[data-testid="add-scene-dialog"]')?.textContent).toContain(
      'Add scene'
    )
    expect(groups()).toEqual(['Apps', 'Displays', 'Camera'])
    expect(cards()).toEqual(['com.google.Chrome', 'com.figma.Desktop', 'com.t3tools.t3code'])
    // "Chrome · 3 windows": the count under the app with several.
    expect(card('com.google.Chrome')!.textContent).toContain('Chrome')
    expect(card('com.google.Chrome')!.textContent).toContain('3 windows')
    expect(card('com.figma.Desktop')!.textContent).toContain('Board')
    // No pictures yet: the icon sits in the picture's place, the glyph without one.
    expect(card('com.figma.Desktop')!.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,AA'
    )
    expect(card('com.t3tools.t3code')!.querySelector('[data-testid="app-icon-glyph"]')).toBeTruthy()
    // A display has a picture slot; its glyph stands in until the pictures come.
    // macOS's name carries the size: the card says the name, then the size once.
    const displayCard = pick(`display:${display.id}`)
    expect(displayCard.textContent).toBe('Built-in Retina Display3024 × 1964')
    expect(displayCard.querySelector('img')).toBeNull()
    expect(pick('none').textContent).toContain('Camera only')
    expect(pick('none').textContent).toContain('FaceTime HD Camera')
    // A Change screen… choice is not an Add scene… one.
    expect(document.body.textContent).not.toContain('A specific window')
    expect(document.body.textContent).not.toContain('No screen')
    expect(mocked.core.refreshDevices).toHaveBeenCalled()
  })

  it('chooses several: Add 3 scenes; nothing chosen says why', async () => {
    await render()
    expect(primary().disabled).toBe(true)
    expect(primary().textContent).toBe('Add scene')
    expect(reason()).toBe('Choose at least one.')
    await act(async () => card('com.t3tools.t3code')!.click())
    expect(primary().textContent).toBe('Add scene')
    await act(async () => card('com.google.Chrome')!.click())
    await act(async () => pick('none').click())
    expect(card('com.t3tools.t3code')!.getAttribute('aria-pressed')).toBe('true')
    expect(primary().textContent).toBe('Add 3 scenes')
    // A second click takes one back.
    await act(async () => pick('none').click())
    expect(primary().textContent).toBe('Add 2 scenes')
    await act(async () => pick(`display:${display.id}`).click())
    await act(async () => primary().click())
    expect(onAdd).toHaveBeenCalledExactlyOnceWith([
      { kind: 'app', app: expect.objectContaining({ bundleId: 'com.google.Chrome' }) },
      {
        kind: 'app',
        app: expect.objectContaining({ bundleId: 'com.t3tools.t3code', frontWindowId: 'window:5' })
      },
      { kind: 'display', device: display }
    ])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('searches apps and displays', async () => {
    await render()
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search apps and displays"]'
    )!
    const type = async (text: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          search,
          text
        )
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
    await type('fig')
    expect(cards()).toEqual(['com.figma.Desktop'])
    expect(groups()).toEqual(['Apps'])
    await type('retina')
    expect(groups()).toEqual(['Displays'])
    await type('zzz')
    expect(document.body.textContent).toContain('Nothing matches “zzz”.')
  })

  it('shows app pictures when Videorc can take them', async () => {
    mocked.core.sceneLibraryActions = {
      listAppPreviews: vi.fn(async () => ({
        apps: [
          {
            bundleId: 'com.figma.Desktop',
            name: 'Figma',
            pid: 4,
            windowCount: 2,
            frontWindowId: 'window:4',
            picture: 'data:image/jpeg;base64,BB'
          }
        ]
      }))
    }
    await render()
    expect(
      (mocked.core.sceneLibraryActions as { listAppPreviews: ReturnType<typeof vi.fn> })
        .listAppPreviews
    ).toHaveBeenCalledWith({ maxWidth: 320 })
    expect(cards()).toEqual(['com.figma.Desktop'])
    const images = [...card('com.figma.Desktop')!.querySelectorAll('img')].map((img) =>
      img.getAttribute('src')
    )
    expect(images).toEqual(['data:image/jpeg;base64,BB', 'data:image/png;base64,AA'])
    expect(card('com.figma.Desktop')!.textContent).toContain('2 windows')
    expect(mocked.core.refreshDevices).not.toHaveBeenCalled()
  })

  it('says what to do when no app has a window, and still offers the rest', async () => {
    mocked.core.deviceList = { devices: [display] }
    await render()
    expect(document.querySelector('[data-testid="scene-picker-no-apps"]')?.textContent).toContain(
      'No app windows found'
    )
    expect(pick(`display:${display.id}`)).toBeTruthy()
    expect(pick('none')).toBeTruthy()
  })

  it('asks for Screen Recording in Sources’ words, and still offers Camera only', async () => {
    mocked.core = {
      ...mocked.core,
      deviceList: {
        devices: [
          {
            id: 'screen:screencapturekit-permission',
            name: 'Primary Display',
            kind: 'screen',
            status: 'permission-required'
          }
        ]
      },
      captureConfig: { sources: {} },
      mediaAccess: { screen: 'denied', camera: 'granted', microphone: 'granted' },
      systemAccessContext: {},
      handleSystemPermission: vi.fn(),
      revealPermissionTarget: vi.fn()
    }
    await render()
    expect(cards()).toEqual([])
    expect(document.body.textContent).toContain('Screen Recording permission is required')
    expect(groups()).toEqual(['Camera'])
    expect(pick('none').textContent).toContain('Camera is off')
  })

  it('offers Displays and Camera only on Windows and Linux, never Apps (plan 210 D12)', async () => {
    mocked.core = {
      ...mocked.core,
      runtimeInfo: { platform: 'win32' },
      deviceList: {
        devices: [
          { id: 'screen:dxgi:1', name: 'Display 1', kind: 'screen', status: 'available' },
          { id: 'screen:dxgi:2', name: 'Display 2', kind: 'screen', status: 'available' }
        ]
      }
    }
    await render()
    expect(groups()).toEqual(['Displays', 'Camera'])
    expect(cards()).toEqual([])
    expect(document.querySelector('input[aria-label^="Search"]')).toBeNull()
    expect(
      (mocked.core.sceneLibraryActions as { listAppPreviews: ReturnType<typeof vi.fn> })
        .listAppPreviews
    ).not.toHaveBeenCalled()
    await act(async () => pick('display:screen:dxgi:1').click())
    await act(async () => pick('display:screen:dxgi:2').click())
    expect(primary().textContent).toBe('Add 2 scenes')
    await act(async () => primary().click())
    expect(onAdd).toHaveBeenCalledExactlyOnceWith([
      { kind: 'display', device: expect.objectContaining({ id: 'screen:dxgi:1' }) },
      { kind: 'display', device: expect.objectContaining({ id: 'screen:dxgi:2' }) }
    ])
  })
})

describe('Change screen… (plan 231 D6)', () => {
  it('starts on what the scene shows, chooses one, and says when nothing changes', async () => {
    await render({ kind: 'change', scene: figmaScene(), onStream: false })
    const dialog = document.querySelector('[data-testid="change-screen-dialog"]')!
    expect(dialog.textContent).toContain('Change screen')
    expect(dialog.textContent).toContain(
      'Choose what “Figma” shows. It keeps its layout, keys and audio.'
    )
    expect(groups()).toEqual(['Apps', 'A specific window', 'Displays', 'Camera'])
    expect(card('com.figma.Desktop')!.getAttribute('aria-pressed')).toBe('true')
    expect(primary().textContent).toBe('Change screen')
    expect(reason()).toBe('“Figma” already shows this.')
    // One at a time.
    await act(async () => card('com.t3tools.t3code')!.click())
    await act(async () => pick(`display:${display.id}`).click())
    expect(card('com.t3tools.t3code')!.getAttribute('aria-pressed')).toBe('false')
    expect(card('com.figma.Desktop')!.getAttribute('aria-pressed')).toBe('false')
    await act(async () => primary().click())
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ kind: 'display', device: display })
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('says the stream changes for the scene on stream', async () => {
    await render({ kind: 'change', scene: figmaScene(), onStream: true })
    expect(document.body.textContent).toContain('It’s on stream, so the stream changes too.')
  })

  it('keeps one window with A specific window, folded until it’s opened', async () => {
    await render({ kind: 'change', scene: figmaScene(), onStream: false })
    expect(document.querySelector('[data-window-choice]')).toBeNull()
    await act(async () => button('A specific window')!.click())
    const windows = [...document.querySelectorAll('[data-window-choice]')]
    expect(
      windows.map((row) => row.querySelector('[data-slot="list-row-title"]')?.textContent)
    ).toEqual(['Calendar', 'Docs', 'Inbox', 'Board', 'videorc'])
    expect(document.body.textContent).toContain(
      'The scene keeps this one window, whichever window of its app is in front.'
    )
    await act(async () => pick('window:window:2').click())
    expect(pick('window:window:2').getAttribute('aria-pressed')).toBe('true')
    await act(async () => primary().click())
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      kind: 'window',
      device: expect.objectContaining({ id: 'window:2' })
    })
  })

  it('opens A specific window on a scene that keeps one', async () => {
    await render({
      kind: 'change',
      scene: figmaScene({ shows: { kind: 'window', windowId: 'window:4', windowName: 'Board' } }),
      onStream: false
    })
    expect(pick('window:window:4').getAttribute('aria-pressed')).toBe('true')
  })

  it('offers No screen, which puts a screen layout on Camera only', async () => {
    await render({ kind: 'change', scene: figmaScene(), onStream: false })
    expect(pick('none').textContent).toContain('No screen')
    expect(pick('none').textContent).toContain('Puts the scene on Camera only')
    await act(async () => pick('none').click())
    await act(async () => primary().click())
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ kind: 'none' })
  })

  it('says a screen won’t show while the scene’s layout draws none', async () => {
    const cameraOnly = figmaScene({
      name: 'Camera only',
      shows: { kind: 'none' },
      layouts: {
        horizontal: { ...defaultCaptureConfig.layout, layoutPreset: 'camera-only' },
        vertical: { ...defaultCaptureConfig.layout, layoutPreset: 'vertical-camera-only' }
      }
    })
    await render({ kind: 'change', scene: cameraOnly, onStream: false })
    expect(pick('none').getAttribute('aria-pressed')).toBe('true')
    await act(async () => card('com.t3tools.t3code')!.click())
    expect(document.querySelector('[data-slot="scene-picker-layout-note"]')?.textContent).toBe(
      '“Camera only” uses Camera only, which shows no screen. Change its layout to show it.'
    )
  })

  it('asks for the screen a layout needs, without No screen (D19)', async () => {
    const cameraOnly = figmaScene({
      shows: { kind: 'none' },
      layouts: {
        horizontal: { ...defaultCaptureConfig.layout, layoutPreset: 'camera-only' },
        vertical: { ...defaultCaptureConfig.layout, layoutPreset: 'vertical-camera-only' }
      }
    })
    await render({
      kind: 'change',
      scene: cameraOnly,
      onStream: true,
      forLayout: 'screen-camera'
    })
    expect(document.body.textContent).toContain(
      'Screen + camera shows a screen, and “Figma” shows none yet. Choose the screen it shows.'
    )
    expect(document.querySelector('[data-pick="none"]')).toBeNull()
    expect(reason()).toBe('Choose what “Figma” shows.')
    await act(async () => button('Cancel')!.click())
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    expect(onChange).not.toHaveBeenCalled()
  })
})
