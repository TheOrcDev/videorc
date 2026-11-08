// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BackendRequestError } from '@/backendClient'
import { resetAppIconsForTest } from '@/hooks/use-app-icons'
import type { Device } from '@/lib/backend'
import { NewSceneDialog, type NewSceneDialogMode } from './new-scene-dialog'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioAudio: () => ({ audioMeter: null })
}))

let root: Root
let container: HTMLDivElement
const window = (id: string, bundleId: string, name: string): Device => ({
  id,
  name: `${name} - ${id}`,
  windowTitle: `${name} title`,
  kind: 'window',
  status: 'available',
  app: { bundleId, name, pid: 4 }
})
const devices: Device[] = [
  window('window:1', 'com.google.Chrome', 'Chrome'),
  window('window:2', 'com.google.Chrome', 'Chrome'),
  window('window:3', 'com.google.Chrome', 'Chrome'),
  window('window:4', 'com.figma.Desktop', 'Figma'),
  window('window:5', 'com.t3.code', 'T3 Code'),
  window('window:6', 'dev.theorcdev.videorc', 'Videorc')
]
const onChooseApps = vi.fn()
const onChooseCapture = vi.fn()
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
  onChooseApps.mockReset()
  onChooseCapture.mockReset()
  mocked.core = {
    runtimeInfo: { platform: 'darwin' },
    deviceList: { devices },
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

async function render(mode: NewSceneDialogMode = { kind: 'new' }): Promise<void> {
  await act(async () =>
    root.render(
      createElement(NewSceneDialog, {
        open: true,
        mode,
        onOpenChange,
        onChooseApps,
        onChooseCapture
      })
    )
  )
  // The previews request, the self ids and the icons settle.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}
const card = (bundleId: string) =>
  document.querySelector<HTMLButtonElement>(`[data-app-choice="${bundleId}"]`)
const cards = () =>
  [...document.querySelectorAll('[data-app-choice]')].map((entry) =>
    entry.getAttribute('data-app-choice')
  )
const primary = () => document.querySelector<HTMLButtonElement>('[data-testid="new-scene-add"]')!

describe('New scene… (plan 210 D2)', () => {
  it('falls back to the device list, grouped by app, without Videorc', async () => {
    await render()
    expect(cards()).toEqual(['com.google.Chrome', 'com.figma.Desktop', 'com.t3.code'])
    expect(card('com.google.Chrome')!.textContent).toContain('3 windows')
    expect(card('com.figma.Desktop')!.textContent).toContain('Figma title')
    // No pictures: the icon sits in the picture's place, the glyph without one.
    expect(card('com.figma.Desktop')!.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,AA'
    )
    expect(card('com.t3.code')!.querySelector('[data-testid="app-icon-glyph"]')).toBeTruthy()
    expect(mocked.core.refreshDevices).toHaveBeenCalled()
  })

  it('chooses several and adds them all; nothing chosen says why', async () => {
    await render()
    expect(primary().disabled).toBe(true)
    expect(primary().textContent).toBe('Add scene')
    const reason = document.getElementById(
      primary().closest('[aria-describedby]')!.getAttribute('aria-describedby')!
    )
    expect(reason?.textContent).toBe('Choose at least one app.')
    await act(async () => card('com.t3.code')!.click())
    await act(async () => card('com.figma.Desktop')!.click())
    expect(card('com.t3.code')!.getAttribute('aria-pressed')).toBe('true')
    expect(primary().textContent).toBe('Add 2 scenes')
    await act(async () => primary().click())
    expect(onChooseApps).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ bundleId: 'com.figma.Desktop', frontWindowId: 'window:4' }),
      expect.objectContaining({ bundleId: 'com.t3.code', frontWindowId: 'window:5' })
    ])
  })

  it('searches the apps', async () => {
    await render()
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search apps"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'fig')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(cards()).toEqual(['com.figma.Desktop'])
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'zzz')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.textContent).toContain('No open app matches “zzz”.')
  })

  it('shows S4 pictures when Videorc can take them', async () => {
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
    expect(mocked.core.refreshDevices).not.toHaveBeenCalled()
  })

  it('says what to do when no app has a window', async () => {
    mocked.core.deviceList = { devices: [] }
    await render()
    expect(document.querySelector('[data-testid="new-scene-empty"]')?.textContent).toContain(
      'No app windows found'
    )
  })

  it('asks for Screen Recording in Sources’ words when it is missing', async () => {
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
  })

  it('Change app… chooses one, and the same app says so', async () => {
    await render({ kind: 'change-app', sceneName: 'Design', bundleId: 'com.figma.Desktop' })
    expect(document.body.textContent).toContain('Choose the app “Design” shows.')
    await act(async () => card('com.figma.Desktop')!.click())
    expect(primary().disabled).toBe(true)
    await act(async () => card('com.t3.code')!.click())
    expect(card('com.figma.Desktop')!.getAttribute('aria-pressed')).toBe('false')
    expect(primary().textContent).toBe('Change app')
    await act(async () => primary().click())
    expect(onChooseApps).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ bundleId: 'com.t3.code' })
    ])
  })

  it('offers a display on Windows and Linux, never an app grid (D12)', async () => {
    mocked.core = {
      ...mocked.core,
      runtimeInfo: { platform: 'win32' },
      deviceList: {
        devices: [{ id: 'screen:dxgi:1', name: 'Display 1', kind: 'screen', status: 'available' }]
      }
    }
    await render()
    expect(cards()).toEqual([])
    const display = document.querySelector<HTMLButtonElement>('[role="radio"]')!
    expect(display.textContent).toContain('Display 1')
    await act(async () => display.click())
    const add = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add scene')!
    await act(async () => add.click())
    expect(onChooseCapture).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'screen:dxgi:1' })
    )
  })
})
