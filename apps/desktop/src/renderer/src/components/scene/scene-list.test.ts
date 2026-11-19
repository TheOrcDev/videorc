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
const openWorkspaceTab = vi.hoisted(() => vi.fn())
vi.mock('@/lib/workspace-navigation', () => ({ openWorkspaceTab }))
// The stills (S5's hook), as Studio's section asks for them (plan 231 D7).
const stills = vi.hoisted(() => ({
  answer: new Map<string, string>(),
  asked: [] as { targets: unknown[]; hidden: boolean; busy: boolean }[]
}))
vi.mock('@/hooks/use-scene-pictures', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-scene-pictures')>()),
  useScenePictures: (input: { targets: unknown[]; hidden: boolean; busy: boolean }) => {
    stills.asked.push(input)
    return stills.answer
  }
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
  stills.answer = new Map()
  stills.asked = []
  openWorkspaceTab.mockClear()
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
    screenPrivacy: { hidden: false },
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
    // Studio's card words (plan 231 D8): never the name twice.
    expect(figmaRow.querySelector('[data-slot="list-row-context"]')!.textContent).toBe(
      'Front window'
    )
    expect(figmaRow.textContent).toContain('Follows')
    expect(figmaRow.querySelector('[data-accelerator="Control+Alt+F"]')).toBeTruthy()
    expect(figmaRow.querySelector('[data-accelerator="Control+Alt+1"]')).toBeTruthy()
    expect(rowButton('Figma').getAttribute('aria-current')).toBe('true')
    expect(figmaRow.querySelector('[aria-label="On stream"]')).toBeTruthy()
    expect(container.querySelector('[data-saved-scene="display"]')!.textContent).toContain(
      'Display 1'
    )
    // T3 Code doesn't follow: no tag.
    expect(container.querySelector('[data-saved-scene="t3"]')!.textContent).not.toContain('Follows')
  })

  it('reads its scenes as Studio’s cards do: the same words, keys and pictures (plan 231 D8)', async () => {
    const renamed = scene('renamed', 'Design review', { windowId: 'window:7', app: figmaApp })
    const pause = scene('pause', 'Break', { screenId: 'screen:screencapturekit:1' })
    pause.visual.layout = { ...pause.visual.layout, layoutPreset: 'camera-only' }
    mocked.core.savedScenes = [figma(), display(), renamed, pause]
    stills.answer = new Map([
      ['app:com.figma.Desktop', 'data:image/jpeg;base64,FIGMA'],
      ['display:screen:screencapturekit:1', 'data:image/jpeg;base64,DISPLAY']
    ])
    await render()
    // One still per thing shown, as in Studio: both Figma scenes share one,
    // and a scene whose layout draws no screen asks for none.
    expect(stills.asked.at(-1)).toEqual({
      targets: [
        { kind: 'app', bundleId: 'com.figma.Desktop' },
        { kind: 'display', screenId: 'screen:screencapturekit:1' }
      ],
      hidden: false,
      busy: false
    })
    const thumb = (id: string) =>
      container.querySelector(`[data-saved-scene="${id}"] [data-slot="scene-row-thumb"]`)!
    const picture = (id: string) => thumb(id).querySelector('img')?.getAttribute('src')
    expect(picture('figma')).toBe('data:image/jpeg;base64,FIGMA')
    expect(picture('renamed')).toBe('data:image/jpeg;base64,FIGMA')
    expect(picture('display')).toBe('data:image/jpeg;base64,DISPLAY')
    // Camera only draws its layout, with no screen to picture.
    expect(thumb('pause').querySelector('[data-slot="layout-thumb-screen"]')).toBeNull()
    expect(thumb('pause').querySelector('[data-slot="layout-thumb-camera"]')).not.toBeNull()
    const words = (id: string) =>
      container.querySelector(`[data-saved-scene="${id}"] [data-slot="list-row-context"]`)
        ?.textContent
    expect(words('renamed')).toBe('Figma · front window')
    expect(words('pause')).toBe('No screen')
    // Each row's keys follow its place: the fourth answers to ⌃⌥4.
    expect(
      container.querySelector('[data-saved-scene="pause"] [data-accelerator="Control+Alt+4"]')
    ).toBeTruthy()

    // Hide screen holding freezes them; a recording or livestream takes none.
    mocked.core.screenPrivacy = { hidden: true }
    mocked.core.isSessionActive = true
    await render()
    expect(stills.asked.at(-1)).toMatchObject({ hidden: true, busy: true })
  })

  it('turns off the scenes that need a camera that is off, saying so once (plan 231 D9)', async () => {
    const pause = scene('pause', 'Break', { screenId: 'screen:screencapturekit:1' })
    pause.visual.layout = { ...pause.visual.layout, layoutPreset: 'camera-only' }
    pause.visual.sources = { ...pause.visual.sources, cameraId: undefined }
    const desk = display()
    desk.visual.layout = { ...desk.visual.layout, layoutPreset: 'screen-only' }
    mocked.core.savedScenes = [desk, pause]
    mocked.core.deviceList = {
      devices: (mocked.core.deviceList as { devices: { kind: string }[] }).devices.filter(
        (device) => device.kind !== 'camera'
      )
    }
    await render()
    expect(rowButton('Break').disabled).toBe(true)
    expect(rowButton('Desk').disabled).toBe(false)
    // Said once under the list, as under Studio's cards, and on the row's hover.
    const line = container.querySelector('[data-slot="scene-gallery-reason"]')!
    expect(line.textContent).toContain('Camera is off. Choose one in Sources to use Break.')
    expect(rowButton('Break').closest('[aria-describedby]')).toBeTruthy()
    await act(async () => button('Open Sources')!.click())
    expect(openWorkspaceTab).toHaveBeenCalledExactlyOnceWith('sources')
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

  // Review #7: a scene that can't go on now still moves with ⌥↑ ⌥↓, from
  // the focusable reason around its button, and keeps the focus there. Its
  // ⋯ never moves it.
  it("moves a row whose app isn't open with ⌥↑ and ⌥↓, from its reason", async () => {
    await render()
    const reason = () => rowButton('T3 Code').closest<HTMLElement>('[data-slot="disabled-reason"]')!
    expect(rowButton('T3 Code').disabled).toBe(true)
    await act(async () => {
      reason().focus()
      reason().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })
      )
    })
    expect(actions().move).toHaveBeenLastCalledWith('t3', 0)
    ;(document.activeElement as HTMLElement | null)?.blur()
    mocked.core.savedScenes = [t3(), figma(), display()]
    await render()
    expect(document.activeElement).toBe(reason())
    // The hover and focus reason stays.
    expect(document.getElementById(reason().getAttribute('aria-describedby')!)?.textContent).toBe(
      "T3 Code isn't open"
    )
    actions().move.mockClear()
    const menu = container.querySelector<HTMLElement>(
      '[data-saved-scene="t3"] [aria-label="Actions for T3 Code"]'
    )!
    await act(async () =>
      menu.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })
      )
    )
    expect(actions().move).not.toHaveBeenCalled()
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
    expect(rowButton('Desk').getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown')
    // The library moved it: the row keeps the focus where it lands.
    ;(document.activeElement as HTMLElement | null)?.blur()
    mocked.core.savedScenes = [figma(), display(), t3()]
    await render()
    expect(document.activeElement).toBe(rowButton('Desk'))
    mocked.core.savedScenes = [figma(), t3(), display()]
    await render()
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
      'Guests in the room…',
      'Duplicate',
      'Delete'
    ])
    expect(await items('Desk')).toEqual([
      'Rename…',
      'Change screen…',
      'Set key…',
      'Save audio to scene',
      'Guests in the room…',
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

  // Plan 249 S12 (D7): a talk show's guest roles, chosen and saved per scene.
  it('saves where guests go in the room, keeping the scene itself', async () => {
    await render()
    await menu('Figma', 'Guests in the room…')
    expect(document.body.textContent).toContain('Guests in the room')
    const over = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (option) => option.textContent === 'Over the scene'
    )!
    expect(
      [...document.querySelectorAll('[role="radio"]')].map((option) => [
        option.textContent,
        option.getAttribute('aria-checked')
      ])
    ).toEqual([
      ['Beside', 'true'],
      ['Below', 'false'],
      ['Over the scene', 'false']
    ])
    await act(async () => over.click())
    await act(async () => button('Save')!.click())
    expect(actions().replace).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'figma',
        visual: figma().visual,
        cloud: expect.objectContaining({
          version: 1,
          placement: 'over',
          guests: expect.objectContaining({ slots: expect.any(Array) })
        })
      })
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
      // The Screen pick of D2. The scene shows it from now on, written at
      // once (review #4: D19's layout must find it, also while live).
      expect(mocked.core.switchSourceDeviceLive).toHaveBeenCalledExactlyOnceWith(
        'capture',
        expect.objectContaining({ windowId: 'window:8', screenId: undefined })
      )
      expect(actions().edit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          id: 'figma',
          shows: { kind: 'window', windowId: 'window:8', windowName: 'Figma - Notes' }
        }),
        undefined
      )
      expect(actions().edit.mock.invocationCallOrder[0]).toBeLessThan(
        (mocked.core.switchSourceDeviceLive as ReturnType<typeof vi.fn>).mock
          .invocationCallOrder[0]!
      )
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

    it('No screen explicitly stops the screen and puts the scene on Camera only (D18)', async () => {
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
      expect(mocked.core.switchSourceDeviceLive).toHaveBeenCalledExactlyOnceWith(
        'capture',
        expect.objectContaining({ captureOff: true, screenId: undefined, windowId: undefined })
      )
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

  // Review #2: a scene going on stream can't be deleted under its switch.
  it('turns Delete off for the scene that is switching, saying why', async () => {
    mocked.core.savedScenePendingId = 'display'
    await render()
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Desk"]'
    )!
    await act(async () => trigger.click())
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (entry) => entry.textContent === 'Delete'
    )!
    expect(item.getAttribute('aria-disabled') ?? item.getAttribute('data-disabled')).not.toBeNull()
    expect(document.body.textContent).toContain(
      'This scene is going on stream. Try again in a moment.'
    )
    await act(async () => trigger.click())
    // Another scene still deletes.
    await menu('T3 Code', 'Delete')
    expect(document.body.textContent).toContain('Delete scene?')
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
