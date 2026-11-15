// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultCaptureConfig } from '@/lib/capture'
import { normalizeSceneVisual, type SavedScene, type VisualSources } from '@/lib/scene-presets'
import { showsFromSources, type Scene } from '@/lib/scenes'
import { SceneList } from './scene-list'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown>, editScene: vi.fn() }))
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
/** A listed scene as the library stores it: its screen and both layouts. */
const storedFor = (listed: SavedScene): Scene => ({
  id: listed.id,
  name: listed.name,
  createdAt: listed.createdAt,
  updatedAt: listed.updatedAt,
  shows: showsFromSources(listed.visual.sources),
  layouts: {
    horizontal: listed.visual.layout,
    vertical: { ...defaultCaptureConfig.layout, layoutPreset: 'vertical-camera-top' }
  },
  background: null
})
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
      workingAudio,
      stored: (id: string) =>
        [figma(), t3(), display()].map(storedFor).find((scene) => scene.id === id),
      add: vi.fn(() => true),
      edit: vi.fn(() => true),
      move: vi.fn(() => true),
      replace: vi.fn(() => true),
      listAppPreviews: vi.fn(async () => ({
        apps: [
          {
            bundleId: 'com.google.Chrome',
            name: 'Chrome',
            pid: 7,
            windowCount: 3,
            frontWindowId: 'window:9'
          }
        ]
      }))
    },
    sceneOnStream: storedFor(figma()),
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
          id: 'window:8',
          name: 'Figma - Notes',
          windowTitle: 'Notes',
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
    sourceSwitchReason: () => null,
    switchSourceDeviceLive: vi.fn(async () => undefined),
    wsStatus: 'connected',
    scene: { id: 'scene:default', sources: [] },
    sceneEditMode: false,
    renameSavedScene: vi.fn(() => true),
    deleteSavedScene: vi.fn(async () => true),
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
  await act(async () => root.render(createElement(SceneList, { onEditScene: mocked.editScene })))
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
  const trigger = container.querySelector<HTMLButtonElement>(
    `button[aria-label="Actions for ${name}"]`
  )!
  await act(async () => trigger.click())
  const entry = [...document.querySelectorAll('[role="menuitem"]')].find(
    (candidate) => candidate.textContent === item
  ) as HTMLElement | undefined
  expect(entry, item).toBeTruthy()
  await act(async () => entry!.click())
}
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((entry) => entry.textContent === label)

describe('the Scene page scene list (plan 210 D6)', () => {
  it('lists the scenes in library order, and no layouts (plan 231 D2)', async () => {
    await render()
    expect(savedRows()).toEqual(['figma', 't3', 'display'])
    // A layout is a choice inside a scene, never a row to switch to.
    expect(container.querySelector('[data-scene-preset]')).toBeNull()
    const text = container.textContent ?? ''
    expect(text).not.toContain('Layouts')
    expect(text).not.toContain('Screen only')
  })

  it('shows what each scene shows, its key, Follows, and marks the one on stream', async () => {
    await render()
    const figmaRow = container.querySelector('[data-saved-scene="figma"]')!
    expect(figmaRow.textContent).toContain('Figma · front window')
    expect(figmaRow.textContent).toContain('Follows')
    expect(figmaRow.querySelector('[data-accelerator="Control+Alt+F"]')).toBeTruthy()
    expect(figmaRow.querySelector('[data-accelerator="Control+Alt+1"]')).toBeTruthy()
    expect(rowButton('Figma').getAttribute('aria-current')).toBe('true')
    expect(container.querySelector('[data-saved-scene="display"]')!.textContent).toContain(
      'Display 1'
    )
    // T3 Code doesn't follow: no tag.
    expect(container.querySelector('[data-saved-scene="t3"]')!.textContent).not.toContain('Follows')
  })

  it('keeps the name of the scene going on stream, says Applying…, and lets another take over', async () => {
    mocked.core.savedScenePendingId = 'display'
    await render()
    const desk = container.querySelector('[data-saved-scene="display"]')!
    expect(desk.textContent).toContain('Desk')
    expect(desk.textContent).toContain('Applying…')
    expect(rowButton('Desk').disabled).toBe(true)
    expect(container.querySelector('[data-saved-scene="figma"]')!.textContent).not.toContain(
      'Applying…'
    )
    // Issue #1275: a click on another scene takes the pending switch over.
    expect(rowButton('Figma').disabled).toBe(false)
    await act(async () => rowButton('Figma').click())
    expect(mocked.core.applySavedSceneResult).toHaveBeenCalledExactlyOnceWith('figma', undefined)
  })

  it('opens no repair dialog for a switch a newer click took over', async () => {
    mocked.core.applySavedSceneResult = vi.fn(async () => ({ ok: false, superseded: true }))
    await render()
    await act(async () => rowButton('Desk').click())
    expect(document.body.textContent).not.toContain("couldn't be put on stream")
    mocked.core.applySavedSceneResult = vi.fn(async () => ({ ok: false }))
    await act(async () => rowButton('Desk').click())
    expect(document.body.textContent).toContain("couldn't be put on stream")
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
    expect(mocked.core.applyCameraPreset).not.toHaveBeenCalled()
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

  it('never shows an unsaved row: a scene is always on stream (plan 231 D2)', async () => {
    mocked.core.activeSavedSceneId = 'display'
    await render()
    expect(container.querySelector('[data-unsaved-scene]')).toBeNull()
    expect(document.body.textContent).not.toContain('Unsaved scene')
    expect(rowButton('Figma').getAttribute('aria-current')).toBeNull()
    expect(rowButton('Desk').getAttribute('aria-current')).toBe('true')
  })

  it('never offers Save scene…: Add scene… makes scenes (plan 231 D6)', async () => {
    await render()
    expect(container.querySelector('[data-testid="scene-save"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Save scene')
    await act(async () => button('Add scene…')!.click())
    expect(document.querySelector('[data-testid="add-scene-dialog"]')).not.toBeNull()
  })

  // Plan 215 D4 (B2): the editor's door beside Add scene…, until it's on.
  it('offers Edit scene beside Add scene… while the editor is off', async () => {
    mocked.editScene.mockClear()
    await render()
    const edit = container.querySelector<HTMLButtonElement>('[data-testid="scene-edit"]')!
    expect(edit.textContent).toBe('Edit scene')
    const header = [...edit.parentElement!.querySelectorAll('button')].map(
      (button) => button.textContent
    )
    expect(header.slice(-2)).toEqual(['Edit scene', 'Add scene…'])
    await act(async () => edit.click())
    expect(mocked.editScene).toHaveBeenCalledOnce()

    mocked.core.sceneEditMode = true
    await render()
    const held = container.querySelector<HTMLButtonElement>('[data-testid="scene-edit"]')!
    expect(held.classList.contains('invisible')).toBe(true)
    expect(held.disabled).toBe(true)
  })

  // The stage's first grab turns the editor on. A header that lost a button
  // at that pointerdown would rewrap, scroll the pane and end the gesture.
  it('keeps the header’s buttons in place when the editor turns on', async () => {
    const header = (): string[] =>
      [
        ...container
          .querySelector('[data-testid="scene-edit"]')!
          .parentElement!.querySelectorAll('button')
      ].map((button) => button.textContent ?? '')
    await render()
    const off = header()
    mocked.core.sceneEditMode = true
    await render()
    expect(header()).toEqual(off)
  })

  it('still offers Edit scene while recording or live', async () => {
    mocked.core.isSessionActive = true
    await render()
    const edit = container.querySelector<HTMLButtonElement>('[data-testid="scene-edit"]')!
    expect(edit.disabled).toBe(false)
  })

  it('never offers Update or Modified', async () => {
    await render()
    expect(container.textContent).not.toMatch(/Update|Modified/)
  })
})

describe('a scene’s ⋯ menu', () => {
  const items = async (name: string) => {
    const trigger = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Actions for ${name}"]`
    )!
    await act(async () => trigger.click())
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent
    )
    await act(async () => trigger.click())
    return labels
  }

  it('reads in the plan’s order, Follow only for app scenes (plan 231 D11)', async () => {
    await render()
    expect(await items('Figma')).toEqual([
      'Rename…',
      'Change screen…',
      'Set key…',
      'Stop following',
      'Save audio to scene',
      'Duplicate',
      'Delete'
    ])
    expect(await items('Desk')).toEqual([
      'Rename…',
      'Change screen…',
      'Set key…',
      'Save audio to scene',
      'Duplicate',
      'Delete'
    ])
    expect(document.body.textContent).not.toContain('Change app')
  })

  it('renames, duplicates at the end, and saves audio without a toast', async () => {
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
    expect(actions().add).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        name: 'Figma 2',
        shows: { kind: 'app', ...figmaApp },
        layouts: storedFor(figma()).layouts
      })
    ])

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
    // Plan 231 D16: Figma is on stream, so the scene after it goes on.
    expect(document.body.textContent).toContain(
      '“Figma” and its key are deleted. “T3 Code” goes on stream.'
    )
    await act(async () => button('Cancel')!.click())
    expect(mocked.core.deleteSavedScene).not.toHaveBeenCalled()
    await menu('Figma', 'Delete')
    await act(async () => button('Delete scene')!.click())
    expect(mocked.core.deleteSavedScene).toHaveBeenCalledExactlyOnceWith('figma')
  })

  describe('Change screen… (plan 231 D2, D6)', () => {
    const settle = async () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const choose = async (key: string) => {
      await settle()
      await act(async () =>
        document.querySelector<HTMLButtonElement>(`[data-pick="${key}"]`)!.click()
      )
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[data-testid="change-screen-apply"]')!.click()
      )
    }
    const stream = () => [
      mocked.core.applySavedSceneResult,
      mocked.core.switchSourceDeviceLive,
      mocked.core.applyCameraPreset
    ]

    it('changes only that scene when it isn’t on stream', async () => {
      await render()
      await menu('Desk', 'Change screen…')
      expect(document.body.textContent).toContain(
        'Choose what “Desk” shows. It keeps its layout, keys and audio.'
      )
      await choose('app:com.google.chrome')
      expect(actions().edit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          id: 'display',
          name: 'Desk',
          shows: { kind: 'app', bundleId: 'com.google.Chrome', name: 'Chrome', follows: true }
        }),
        'window:9'
      )
      for (const call of stream()) expect(call).not.toHaveBeenCalled()
    })

    it('keeps a specific window for a scene that isn’t on stream', async () => {
      await render()
      await menu('T3 Code', 'Change screen…')
      await settle()
      await act(async () => button('A specific window')!.click())
      await choose('window:window:8')
      expect(actions().edit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          id: 't3',
          // Named after its app before, after the window's app now (Figma is taken).
          name: 'Figma 2',
          shows: { kind: 'window', windowId: 'window:8', windowName: 'Figma - Notes' }
        }),
        undefined
      )
      for (const call of stream()) expect(call).not.toHaveBeenCalled()
    })

    it('changes the stream for the scene on stream: a window through the Screen pick', async () => {
      await render()
      await menu('Figma', 'Change screen…')
      expect(document.body.textContent).toContain('It’s on stream, so the stream changes too.')
      await settle()
      await act(async () => button('A specific window')!.click())
      await choose('window:window:8')
      // The Screen pick of D2: it writes the scene's screen itself.
      expect(mocked.core.switchSourceDeviceLive).toHaveBeenCalledExactlyOnceWith(
        'capture',
        expect.objectContaining({ windowId: 'window:8', screenId: undefined })
      )
      expect(actions().edit).not.toHaveBeenCalled()
      expect(mocked.core.applySavedSceneResult).not.toHaveBeenCalled()
    })

    it('changes the stream for the scene on stream: an app goes on with its front window', async () => {
      await render()
      await menu('Figma', 'Change screen…')
      await choose('app:com.google.chrome')
      expect(actions().edit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          id: 'figma',
          name: 'Chrome',
          shows: expect.objectContaining({ bundleId: 'com.google.Chrome' })
        }),
        'window:9'
      )
      expect(mocked.core.applySavedSceneResult).toHaveBeenCalledExactlyOnceWith(
        'figma',
        expect.objectContaining({
          sources: expect.objectContaining({
            windowId: 'window:9',
            app: { bundleId: 'com.google.Chrome', name: 'Chrome', follows: true }
          })
        })
      )
      expect(mocked.core.switchSourceDeviceLive).not.toHaveBeenCalled()
    })

    it('No screen puts the scene on stream on Camera only, keeping the capture (D18)', async () => {
      await render()
      await menu('Figma', 'Change screen…')
      await choose('none')
      expect(actions().edit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          id: 'figma',
          shows: { kind: 'none' },
          layouts: expect.objectContaining({
            horizontal: expect.objectContaining({ layoutPreset: 'camera-only' }),
            vertical: expect.objectContaining({ layoutPreset: 'vertical-camera-only' })
          })
        }),
        undefined
      )
      expect(mocked.core.applyCameraPreset).toHaveBeenCalledExactlyOnceWith({
        layoutPreset: 'camera-only'
      })
      expect(mocked.core.switchSourceDeviceLive).not.toHaveBeenCalled()
      expect(mocked.core.applySavedSceneResult).not.toHaveBeenCalled()
    })

    it('is off for the scene on stream while its screen can’t change, saying why', async () => {
      mocked.core.sourceSwitchReason = () => 'Stop recording to change the screen.'
      await render()
      const trigger = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Actions for Figma"]'
      )!
      await act(async () => trigger.click())
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (entry) => entry.textContent === 'Change screen…'
      )!
      expect(
        item.getAttribute('aria-disabled') ?? item.getAttribute('data-disabled')
      ).not.toBeNull()
      await act(async () => trigger.click())
      // Another scene's screen can still change.
      await menu('Desk', 'Change screen…')
      expect(document.querySelector('[data-testid="change-screen-dialog"]')).not.toBeNull()
    })
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

describe('Follow the app in front (plan 210 D10, D12)', () => {
  it('lives in Studio’s Scenes section now, not on the Scene page (plan 231 D8)', async () => {
    await render()
    expect(container.querySelector('[data-videorc-follow-front-app]')).toBeNull()
    expect(container.textContent).not.toContain('Follow the app in front')
  })
})
