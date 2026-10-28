// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultCaptureConfig } from '@/lib/capture'
import { normalizeSceneVisual, type SavedScene, type VisualSources } from '@/lib/scene-presets'
import { SceneList } from './scene-list'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioAudio: () => ({ audioMeter: null })
}))

let root: Root
let container: HTMLDivElement
const figmaApp = { bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }
const scene = (id: string, name: string, sources: VisualSources): SavedScene => ({
  id,
  name,
  createdAt: '2026-10-28',
  updatedAt: '2026-10-28',
  visual: normalizeSceneVisual({
    layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-camera' },
    sources: { cameraId: 'camera', ...sources },
    background: null
  })
})
const figma = () => scene('figma', 'Figma', { windowId: 'window:7', app: figmaApp })
const t3 = () =>
  scene('t3', 'T3 Code', {
    windowId: 'window:8',
    app: { bundleId: 'com.t3.code', name: 'T3 Code', follows: false }
  })
const display = () =>
  scene('display', 'Desk', { screenId: 'screen:screencapturekit:1', screenName: 'Display 1' })
const workingAudio = {
  microphoneId: 'mic',
  microphoneName: 'Shure',
  microphoneOff: false,
  systemAudioEnabled: true
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Element.prototype.scrollIntoView = vi.fn()
  mocked.core = {
    savedScenes: [figma(), t3(), display()],
    activeSavedSceneId: 'figma',
    savedScenePendingId: null,
    savedSceneAppStates: { figma: 'ready', t3: 'not-running' },
    savedSceneWindowApps: {},
    sceneLibraryError: null,
    sceneLibraryActions: {
      readOnly: false,
      workingOrigin: 'saved',
      workingVisual: figma().visual,
      workingAudio,
      insert: vi.fn(() => true),
      move: vi.fn(() => true),
      replace: vi.fn(() => true),
      listAppPreviews: vi.fn(async () => ({ apps: [] }))
    },
    captureConfig: {
      ...defaultCaptureConfig,
      layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-camera' },
      sources: { ...defaultCaptureConfig.sources, cameraId: 'camera', windowId: 'window:7' }
    },
    deviceList: {
      devices: [
        { id: 'camera', name: 'FaceTime', kind: 'camera', status: 'available' },
        {
          id: 'window:7',
          name: 'Figma - Board',
          kind: 'window',
          status: 'available',
          app: { bundleId: 'com.figma.Desktop', name: 'Figma', pid: 4 }
        },
        {
          id: 'screen:screencapturekit:1',
          name: 'Display 1',
          kind: 'screen',
          status: 'available'
        }
      ]
    },
    settings: { globalShortcuts: { scenes: { figma: 'Control+Alt+F' } } },
    setSettings: vi.fn(),
    runtimeInfo: { platform: 'darwin' },
    isSessionActive: false,
    layoutSwitchPending: null,
    applyCameraPreset: vi.fn(),
    canSaveScene: true,
    wsStatus: 'connected',
    scene: { id: 'scene:default', sources: [] },
    saveScene: vi.fn(() => true),
    renameSavedScene: vi.fn(() => true),
    deleteSavedScene: vi.fn(() => true),
    applySavedSceneResult: vi.fn(async () => ({ ok: true })),
    refreshDevices: vi.fn(async () => undefined)
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  await act(async () => root.render(createElement(SceneList)))
}
const actions = () => mocked.core.sceneLibraryActions as Record<string, ReturnType<typeof vi.fn>>
const rowButton = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-slot="list-row-button"]')].find(
    (button) => button.textContent === name
  )!
const savedRows = () =>
  [...container.querySelectorAll('[data-saved-scene]')].map((row) =>
    row.getAttribute('data-saved-scene')
  )
async function menu(name: string, item: string): Promise<void> {
  const trigger = container.querySelector(`button[aria-label="Actions for ${name}"]`)!
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  const entry = [...document.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent === item
  ) as HTMLElement | undefined
  expect(entry, item).toBeTruthy()
  await act(async () => entry!.click())
}
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((entry) => entry.textContent === label)

describe('the Scene page scene list (plan 210 D6)', () => {
  it('lists saved scenes in library order, then the orientation’s layouts', async () => {
    await render()
    expect(savedRows()).toEqual(['figma', 't3', 'display'])
    const layouts = [...container.querySelectorAll('[data-scene-preset]')].map((row) =>
      row.getAttribute('data-scene-preset')
    )
    expect(layouts).toEqual(['screen-camera', 'screen-only', 'camera-only', 'side-by-side'])
    // Saved scenes lead, in their own group.
    const text = container.textContent ?? ''
    expect(text.indexOf('Saved scenes')).toBeLessThan(text.indexOf('Layouts'))
  })

  it('shows what each scene shows, its key, Follows, and marks the one on stream', async () => {
    await render()
    const figmaRow = container.querySelector('[data-saved-scene="figma"]')!
    expect(figmaRow.textContent).toContain('Figma · front window')
    expect(figmaRow.textContent).toContain('Follows')
    expect(figmaRow.querySelector('[data-accelerator="Control+Alt+F"]')).toBeTruthy()
    expect(rowButton('Figma').getAttribute('aria-current')).toBe('true')
    expect(container.querySelector('[data-saved-scene="display"]')!.textContent).toContain(
      'Display 1'
    )
    // T3 Code doesn't follow: no tag.
    expect(container.querySelector('[data-saved-scene="t3"]')!.textContent).not.toContain('Follows')
  })

  it('says Switching… on the scene going on stream, and holds the others', async () => {
    mocked.core.savedScenePendingId = 'display'
    await render()
    expect(container.querySelector('[data-saved-scene="display"]')!.textContent).toContain(
      'Switching…'
    )
    expect(rowButton('Desk').disabled).toBe(true)
    expect(container.querySelector('[data-saved-scene="figma"]')!.textContent).not.toContain(
      'Switching…'
    )
  })

  it("disables a scene whose app isn't open, saying so on the row", async () => {
    await render()
    const t3Row = container.querySelector('[data-saved-scene="t3"]')!
    expect(t3Row.textContent).toContain("T3 Code isn't open")
    expect(rowButton('T3 Code').disabled).toBe(true)
    expect(rowButton('T3 Code').closest('[aria-describedby]')).toBeTruthy()
  })

  it('puts a scene on stream with a click, as Studio does', async () => {
    await render()
    await act(async () => rowButton('Desk').click())
    expect(mocked.core.applySavedSceneResult).toHaveBeenCalledExactlyOnceWith('display', undefined)
    await act(async () => rowButton('Screen only').click())
    expect(mocked.core.applyCameraPreset).toHaveBeenCalledExactlyOnceWith({
      layoutPreset: 'screen-only'
    })
  })

  it('moves a focused row with ⌥↑ and ⌥↓, and by dragging', async () => {
    await render()
    await act(async () =>
      rowButton('Desk').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })
      )
    )
    expect(actions().move).toHaveBeenLastCalledWith('display', 1)
    await act(async () =>
      rowButton('Figma').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })
      )
    )
    expect(actions().move).toHaveBeenLastCalledWith('figma', 1)
    const rows = container.querySelectorAll('[data-saved-scene]')
    const drag = (target: Element, type: string) =>
      target.dispatchEvent(
        Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
          dataTransfer: { effectAllowed: '' }
        })
      )
    await act(async () => drag(rows[2]!, 'dragstart'))
    await act(async () => drag(rows[0]!, 'dragenter'))
    await act(async () => drag(rows[0]!, 'drop'))
    expect(actions().move).toHaveBeenLastCalledWith('display', 0)
  })

  it('shows an Unsaved scene row once a saved scene is left (D3)', async () => {
    mocked.core.activeSavedSceneId = null
    await render()
    const unsaved = container.querySelector('[data-unsaved-scene]')!
    expect(unsaved.textContent).toContain('Unsaved scene')
    expect(unsaved.textContent).toContain('Save scene…')
    expect(rowButton('Figma').getAttribute('aria-current')).toBeNull()
    // A built-in on stream marks its layout row instead.
    mocked.core = {
      ...mocked.core,
      sceneLibraryActions: { ...actions(), workingOrigin: 'builtin' }
    }
    await render()
    expect(container.querySelector('[data-unsaved-scene]')).toBeNull()
    expect(rowButton('Screen + camera').getAttribute('aria-current')).toBe('true')
  })

  it('says why Save scene… is off', async () => {
    mocked.core.canSaveScene = false
    mocked.core.wsStatus = 'connecting'
    await render()
    const save = container.querySelector<HTMLButtonElement>('[data-testid="scene-save"]')!
    expect(save.disabled).toBe(true)
    const reason = document.getElementById(
      save.closest('[aria-describedby]')!.getAttribute('aria-describedby')!
    )
    expect(reason?.textContent).toBe('Videorc is reconnecting. Try again in a moment.')
  })

  it('never offers Update or Modified', async () => {
    await render()
    expect(container.textContent).not.toMatch(/Update|Modified/)
  })
})

describe('a saved scene’s ⋯ menu', () => {
  it('holds the plan’s actions, app ones only for app scenes', async () => {
    await render()
    const trigger = container.querySelector('button[aria-label="Actions for Figma"]')!
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    ).toEqual([
      'Rename…',
      'Set key…',
      'Change app…',
      'Duplicate',
      'Save audio to scene',
      'Stop following',
      'Delete'
    ])
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
  })

  it('renames, duplicates after the original, and saves audio without a toast', async () => {
    await render()
    await menu('Desk', 'Rename…')
    const input = document.querySelector<HTMLInputElement>('#scene-preset-name')!
    expect(input.value).toBe('Desk')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Desk wide'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Rename')!.click())
    expect(mocked.core.renameSavedScene).toHaveBeenCalledExactlyOnceWith('display', 'Desk wide')

    await menu('Figma', 'Duplicate')
    expect(actions().insert).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'Figma 2', visual: figma().visual })],
      'figma'
    )

    await menu('Figma', 'Save audio to scene')
    expect(actions().replace).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'figma', audio: workingAudio })
    )
  })

  it('stops following and follows again', async () => {
    await render()
    await menu('Figma', 'Stop following')
    expect(actions().replace).toHaveBeenLastCalledWith(
      expect.objectContaining({
        visual: expect.objectContaining({
          sources: expect.objectContaining({ app: { ...figmaApp, follows: false } })
        })
      })
    )
    await menu('T3 Code', 'Follow the app')
    expect(actions().replace).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 't3',
        visual: expect.objectContaining({
          sources: expect.objectContaining({ app: expect.objectContaining({ follows: true }) })
        })
      })
    )
  })

  it('asks before deleting, and Cancel deletes nothing', async () => {
    await render()
    await menu('Figma', 'Delete')
    expect(document.body.textContent).toContain('Delete scene?')
    expect(document.body.textContent).toContain('“Figma” and its key are deleted.')
    await act(async () => button('Cancel')!.click())
    expect(mocked.core.deleteSavedScene).not.toHaveBeenCalled()
    await menu('Figma', 'Delete')
    await act(async () => button('Delete scene')!.click())
    expect(mocked.core.deleteSavedScene).toHaveBeenCalledExactlyOnceWith('figma')
  })

  it('Set key… records the scene’s global key', async () => {
    const setShortcutRecorderArmed = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('videorc', {
      setShortcutRecorderArmed,
      onShortcutRecorderKey: () => () => undefined,
      onShortcutRecorderDisarmed: () => () => undefined
    })
    await render()
    await menu('Desk', 'Set key…')
    expect(document.body.textContent).toContain('Puts “Desk” on stream from any app.')
    expect(document.querySelector('#scene-key-display')).toBeTruthy()
    await act(async () => button('Done')!.click())
    expect(document.body.textContent).not.toContain('Puts “Desk” on stream')
  })
})
