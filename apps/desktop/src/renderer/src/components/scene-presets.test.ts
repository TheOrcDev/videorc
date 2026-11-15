// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeSceneVisual } from '@/lib/scene-presets'
import { defaultCaptureConfig } from '@/lib/capture'
import {
  FOLLOW_SETTINGS_STORAGE_KEY,
  getFollowSettings,
  resetFollowSettingsForTest
} from '@/lib/follow-settings'
import { ScenesSection } from './scene-presets'
const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioAudio: () => ({ audioMeter: null }),
  useStudioBanners: () => ({ selectBanner: vi.fn() }),
  useStudioPreview: () => ({ previewCameraLowFrameRate: false })
}))
const openWorkspaceTab = vi.hoisted(() => vi.fn())
vi.mock('@/lib/workspace-navigation', () => ({ openWorkspaceTab }))
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.core = {
    savedScenes: [],
    activeSavedSceneId: null,
    savedScenePendingId: null,
    savedSceneAppStates: {},
    savedSceneWindowApps: {},
    canSaveScene: true,
    sceneLibraryError: null,
    sceneLibraryActions: {
      readOnly: false,
      workingVisual: saved().visual,
      workingAudio: { microphoneOff: false, systemAudioEnabled: false },
      insert: vi.fn(() => true),
      move: vi.fn(() => true),
      replace: vi.fn(() => true),
      listAppPreviews: vi.fn(async () => ({ apps: [] }))
    },
    deviceList: { devices: [] },
    captureConfig: defaultCaptureConfig,
    settings: {},
    runtimeInfo: { platform: 'darwin' },
    isSessionActive: false,
    wsStatus: 'connected',
    scene: { id: 'scene:default', sources: [] },
    sceneOnStream: null,
    applyCameraPreset: vi.fn(),
    sourceSwitchReason: () => null,
    switchSourceDeviceLive: vi.fn(async () => undefined),
    allowCaptureNone: true,
    screenPrivacy: { hidden: false },
    hideScreen: vi.fn(async () => ({ ok: true })),
    showScreen: vi.fn(async () => ({ ok: true })),
    setSceneEditMode: vi.fn(),
    setSelectedSceneSourceId: vi.fn(),
    saveScene: vi.fn(() => true),
    deleteSavedScene: vi.fn(async () => true),
    renameSavedScene: vi.fn(() => true),
    applySavedSceneResult: vi.fn(async () => ({ ok: true })),
    applySavedScene: vi.fn(async () => true)
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  localStorage.removeItem(FOLLOW_SETTINGS_STORAGE_KEY)
  resetFollowSettingsForTest()
})
async function render(props: Parameters<typeof ScenesSection>[0] = {}): Promise<void> {
  await act(async () => root.render(createElement(ScenesSection, props)))
}
async function click(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent === label
  )!
  expect(button).toBeTruthy()
  await act(async () => button.click())
}
async function input(value: string): Promise<void> {
  // The dialog's name field, not the Follow switch's input in the header.
  const element = document.querySelector<HTMLInputElement>('#scene-preset-name')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function saved() {
  return {
    id: 'scene-a',
    name: 'Presentation',
    createdAt: '2026-09-22',
    updatedAt: '2026-09-22',
    visual: normalizeSceneVisual({
      layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-only' },
      sources: { testPattern: true },
      background: null
    })
  }
}
async function menu(action: string): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Actions for Presentation"]'
  )!
  await act(async () => trigger.click())
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((entry) =>
    entry.textContent?.includes(action)
  )!
  expect(item).toBeTruthy()
  await act(async () => (item as HTMLElement).click())
}
describe("Studio's Scenes section (plan 231 D8)", () => {
  it('shows the position key beside its custom key', async () => {
    mocked.core.savedScenes = [saved()]
    mocked.core.settings = { globalShortcuts: { scenes: { 'scene-a': 'F13' } } }
    await render()
    const card = container.querySelector('[data-saved-scene="scene-a"]')!
    expect(
      [...card.querySelectorAll('[data-accelerator]')].map((key) =>
        key.getAttribute('data-accelerator')
      )
    ).toEqual(['Control+Alt+1', 'F13'])
  })
  it('heads the section with Edit scene and Add scene…, never Save scene… (plan 231 D8)', async () => {
    mocked.core.savedScenes = [saved()]
    mocked.core.activeSavedSceneId = 'scene-a'
    await render()
    const header = container.querySelector('[data-slot="panel-section-action"]')!
    expect([...header.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Edit scene',
      'Add scene…'
    ])
    expect(container.textContent).not.toMatch(/Save scene|New scene|Update|Modified|Layouts/)
    // Until S7's dialog, Add scene… opens New scene…, which adds at the end.
    await click('Add scene…')
    expect(document.querySelector('[data-testid="new-scene-dialog"]')).not.toBeNull()
  })

  it('duplicates from ⋯ after the original', async () => {
    mocked.core.savedScenes = [saved()]
    mocked.core.activeSavedSceneId = 'scene-a'
    await render()
    await menu('Duplicate')
    expect(
      (mocked.core.sceneLibraryActions as { insert: ReturnType<typeof vi.fn> }).insert
    ).toHaveBeenCalledWith([expect.objectContaining({ name: 'Presentation 2' })], 'scene-a')
  })

  it('hands Add scene… to the dialog a later slice gives it', async () => {
    const onAddScene = vi.fn()
    await render({ onAddScene })
    await click('Add scene…')
    expect(onAddScene).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-testid="new-scene-dialog"]')).toBeNull()
  })

  it('says why Add scene… is off and shows future-version recovery', async () => {
    mocked.core.sceneLibraryActions = {
      ...(mocked.core.sceneLibraryActions as object),
      readOnly: true
    }
    mocked.core.sceneLibraryError =
      'Update Videorc to open these scenes. Your saved data is preserved.'
    await render()
    const add = container.querySelector<HTMLButtonElement>('[data-testid="scene-add"]')!
    expect(add.disabled).toBe(true)
    expect(
      document.getElementById(add.closest('[aria-describedby]')!.getAttribute('aria-describedby')!)
        ?.textContent
    ).toBe('Update Videorc to change your scenes.')
    expect(container.textContent).toContain('saved data is preserved')
  })

  it('teaches the position keys in the platform’s words (plan 231 D5)', async () => {
    await render()
    const description = () =>
      container.querySelector('[data-slot="panel-section-description"]')!.textContent
    expect(description()).toBe(
      'Each scene shows its own screen. ⌃⌥1 to ⌃⌥9 switch them from any app.'
    )
    mocked.core.runtimeInfo = { platform: 'win32' }
    await render()
    expect(description()).toBe(
      'Each scene shows its own screen. Ctrl+Alt+Shift+1 to Ctrl+Alt+Shift+9 switch them from any app.'
    )
    mocked.core.settings = { globalShortcuts: { sceneSlots: { 1: 'F13' } } }
    await render()
    expect(description()).toBe(
      "Each scene shows its own screen. A scene's key switches to it from any app."
    )
  })

  it('lists every scene in order as one set of cards, the one on stream checked', async () => {
    mocked.core.savedScenes = [
      saved(),
      { ...saved(), id: 'scene-b', name: 'Desk' },
      { ...saved(), id: 'scene-c', name: 'Figma' }
    ]
    mocked.core.activeSavedSceneId = 'scene-b'
    await render()
    expect(
      [...container.querySelectorAll('[data-saved-scene]')].map((card) =>
        card.getAttribute('data-saved-scene')
      )
    ).toEqual(['scene-a', 'scene-b', 'scene-c'])
    expect(container.querySelectorAll('[data-testid="scene-card-check"]')).toHaveLength(1)
    expect(
      container
        .querySelector('[data-saved-scene="scene-b"] [data-slot="scene-card-button"]')!
        .getAttribute('aria-pressed')
    ).toBe('true')
    expect(container.textContent).not.toContain('Saved scenes')
  })

  it('moves a focused card with ⌥← and ⌥→, keeps its focus, and moves by dragging', async () => {
    mocked.core.savedScenes = [
      saved(),
      { ...saved(), id: 'scene-b', name: 'Desk' },
      { ...saved(), id: 'scene-c', name: 'Figma' }
    ]
    const move = (mocked.core.sceneLibraryActions as { move: ReturnType<typeof vi.fn> }).move
    await render()
    const button = (id: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-saved-scene="${id}"] [data-slot="scene-card-button"]`
      )!
    expect(button('scene-c').getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowLeft Alt+ArrowRight')
    const key = async (id: string, key: string, extra = {}) =>
      act(async () => {
        button(id).focus()
        button(id).dispatchEvent(
          new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, ...extra })
        )
      })
    await key('scene-c', 'ArrowLeft')
    expect(move).toHaveBeenLastCalledWith('scene-c', 1)
    // The library moved it: the card keeps the focus where it lands.
    ;(document.activeElement as HTMLElement | null)?.blur()
    mocked.core.savedScenes = [
      saved(),
      { ...saved(), id: 'scene-c', name: 'Figma' },
      { ...saved(), id: 'scene-b', name: 'Desk' }
    ]
    await render()
    expect(document.activeElement).toBe(button('scene-c'))
    await key('scene-a', 'ArrowRight')
    expect(move).toHaveBeenLastCalledWith('scene-a', 1)
    move.mockClear()
    await key('scene-a', 'ArrowRight', { shiftKey: true })
    await key('scene-a', 'ArrowUp')
    expect(move).not.toHaveBeenCalled()

    const cards = container.querySelectorAll('[data-scene-drag]')
    const drag = (target: Element, type: string) =>
      target.dispatchEvent(
        Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
          dataTransfer: { effectAllowed: '' }
        })
      )
    await act(async () => drag(cards[2]!, 'dragstart'))
    await act(async () => drag(cards[0]!, 'dragenter'))
    expect(cards[0]!.className).toContain('before:-left-[5px]')
    await act(async () => drag(cards[0]!, 'drop'))
    expect(move).toHaveBeenLastCalledWith('scene-b', 0)
  })

  it('never moves a card in a library this build can’t change', async () => {
    mocked.core.savedScenes = [saved(), { ...saved(), id: 'scene-b', name: 'Desk' }]
    mocked.core.sceneLibraryActions = {
      ...(mocked.core.sceneLibraryActions as object),
      readOnly: true
    }
    await render()
    const card = container.querySelector('[data-scene-drag="scene-b"]')!
    expect(card.getAttribute('draggable')).toBe('false')
    const button = card.querySelector<HTMLButtonElement>('[data-slot="scene-card-button"]')!
    expect(button.getAttribute('aria-keyshortcuts')).toBeNull()
    await act(async () =>
      button.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true })
      )
    )
    expect(
      (mocked.core.sceneLibraryActions as { move: ReturnType<typeof vi.fn> }).move
    ).not.toHaveBeenCalled()
  })

  it('draws the scene’s picture in its screen area, else what it shows (plan 231 D7)', async () => {
    mocked.core.savedScenes = [saved(), { ...saved(), id: 'scene-b', name: 'Desk' }]
    await render({ pictures: new Map([['scene-a', 'data:image/jpeg;base64,AAAA']]) })
    const screen = (id: string) =>
      container.querySelector(`[data-saved-scene="${id}"] [data-slot="layout-thumb-screen"]`)!
    expect(screen('scene-a').querySelector('img')?.getAttribute('src')).toBe(
      'data:image/jpeg;base64,AAAA'
    )
    expect(screen('scene-a').hasAttribute('data-picture')).toBe(true)
    // No picture yet (or not macOS): the layout keeps its glyph.
    expect(screen('scene-b').querySelector('img')).toBeNull()
    expect(screen('scene-b').querySelector('svg')).not.toBeNull()
  })

  it('turns off the scenes that need a camera that is off, saying so once (plan 231 D9)', async () => {
    const cameraScene = (
      id: string,
      name: string,
      layoutPreset: 'camera-only' | 'side-by-side'
    ) => ({
      ...saved(),
      id,
      name,
      visual: normalizeSceneVisual({
        layout: { ...defaultCaptureConfig.layout, layoutPreset },
        sources: { testPattern: true, cameraOff: true },
        background: null
      })
    })
    mocked.core.savedScenes = [
      saved(),
      cameraScene('cam', 'Camera only', 'camera-only'),
      cameraScene('side', 'Side by side', 'side-by-side')
    ]
    await render()
    const button = (id: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-saved-scene="${id}"] [data-slot="scene-card-button"]`
      )!
    expect(button('scene-a').disabled).toBe(false)
    expect(button('cam').disabled).toBe(true)
    expect(button('side').disabled).toBe(true)
    expect(container.textContent).not.toContain('Resolve sources')
    const reasons = container.querySelectorAll('[data-slot="scene-gallery-reason"]')
    expect(reasons).toHaveLength(1)
    expect(reasons[0]!.textContent).toContain(
      'Camera is off. Choose one in Sources to use Camera only and Side by side.'
    )
    const open = [...reasons[0]!.querySelectorAll('button')].find(
      (b) => b.textContent === 'Open Sources'
    )!
    await act(async () => open.click())
    expect(openWorkspaceTab).toHaveBeenCalledWith('sources')
  })

  it('renames from ⋯ and asks before deleting', async () => {
    mocked.core.savedScenes = [{ ...saved(), id: 'scene-b', name: 'Desk' }, saved()]
    mocked.core.activeSavedSceneId = 'scene-b'
    await render()
    await menu('Rename')
    await input('Renamed')
    await click('Rename')
    expect(mocked.core.renameSavedScene).toHaveBeenCalledExactlyOnceWith('scene-a', 'Renamed')
    await menu('Delete')
    expect(mocked.core.deleteSavedScene).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('What’s on stream stays as it is.')
    await click('Cancel')
    expect(mocked.core.deleteSavedScene).not.toHaveBeenCalled()
    await menu('Delete')
    await click('Delete scene')
    expect(mocked.core.deleteSavedScene).toHaveBeenCalledExactlyOnceWith('scene-a')
    expect(mocked.core.applySavedScene).not.toHaveBeenCalled()
  })

  it('deleting the scene on stream says which scene goes on (plan 231 D16)', async () => {
    mocked.core.savedScenes = [{ ...saved(), id: 'scene-b', name: 'Desk' }, saved()]
    mocked.core.activeSavedSceneId = 'scene-a'
    await render()
    await menu('Delete')
    expect(document.body.textContent).toContain(
      '“Presentation” and its key are deleted. “Desk” goes on stream.'
    )
    await click('Delete scene')
    expect(mocked.core.deleteSavedScene).toHaveBeenCalledExactlyOnceWith('scene-a')
  })

  it.each([
    ['the last scene', false, [saved()], 'Keep at least one scene.'],
    [
      'the scene on stream while recording or live',
      true,
      [{ ...saved(), id: 'scene-b', name: 'Desk' }, saved()],
      'Switch to another scene first.'
    ]
  ])('Delete is off for %s, with its reason (plan 231 D16)', async (_, live, scenes, reason) => {
    mocked.core.savedScenes = scenes
    mocked.core.activeSavedSceneId = 'scene-a'
    mocked.core.isSessionActive = live
    await render()
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Presentation"]'
    )!
    await act(async () => trigger.click())
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((entry) =>
      entry.textContent?.includes('Delete')
    )!
    expect(item.getAttribute('aria-disabled') ?? item.getAttribute('data-disabled')).not.toBeNull()
    expect(document.body.textContent).toContain(reason)
    await act(async () => (item as HTMLElement).click())
    expect(document.body.textContent).not.toContain('Delete scene?')
    expect(mocked.core.deleteSavedScene).not.toHaveBeenCalled()
  })

  it('repairs an unavailable window with exact sources, and the scene keeps them', async () => {
    const scene = saved()
    scene.visual.sources = { windowId: 'closed', testPattern: false }
    mocked.core.savedScenes = [scene]
    mocked.core.deviceList = {
      devices: [{ id: 'screen-new', name: 'New display', kind: 'screen', status: 'available' }]
    }
    Element.prototype.scrollIntoView = vi.fn()
    await render()
    const card = [...container.querySelectorAll('button')].find((entry) =>
      entry.textContent?.includes('Resolve sources')
    )!
    await act(async () => card.click())
    expect(mocked.core.applySavedSceneResult).not.toHaveBeenCalled()
    expect(
      [...document.querySelectorAll('button')].find((entry) => entry.textContent === 'Apply scene')
        ?.disabled
    ).toBe(true)
    const trigger = document.querySelector('button[aria-label="Screen / window"]')!
    await act(async () => (trigger as HTMLElement).click())
    await act(async () =>
      (document.querySelector('[cmdk-item][data-value="screen-new"]') as HTMLElement).click()
    )
    expect(mocked.core.applySavedSceneResult).not.toHaveBeenCalled()
    await click('Apply scene')
    expect(mocked.core.applySavedSceneResult).toHaveBeenCalledExactlyOnceWith(
      'scene-a',
      expect.objectContaining({
        sources: expect.objectContaining({ screenId: 'screen-new', windowId: undefined })
      })
    )
    expect(
      (mocked.core.sceneLibraryActions as { replace: ReturnType<typeof vi.fn> }).replace
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'scene-a',
        visual: expect.objectContaining({
          sources: expect.objectContaining({ screenId: 'screen-new', screenName: 'New display' })
        })
      })
    )
  })

  it("disables a card whose app isn't ready, with S2's words as its line", async () => {
    const scene = saved()
    scene.visual.sources = {
      windowId: 'gone',
      app: { bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }
    }
    mocked.core.savedScenes = [scene]
    mocked.core.savedSceneAppStates = { 'scene-a': 'minimized' }
    await render()
    const card = container.querySelector<HTMLButtonElement>('[data-slot="scene-card-button"]')!
    expect(card.disabled).toBe(true)
    expect(card.textContent).toContain("Figma's window is minimized")
  })
})

it.each([
  ['app-not-running', "Figma isn't open"],
  ['app-no-window', 'Figma has no window open'],
  ['app-minimized', "Figma's window is minimized"]
])(
  'an app card reaches the typed %s refusal without opening source repair',
  async (reason, message) => {
    const scene = saved()
    scene.visual.sources = {
      windowId: 'gone',
      app: { bundleId: 'com.figma.Desktop', name: 'Figma', follows: true }
    }
    mocked.core.savedScenes = [scene]
    mocked.core.applySavedSceneResult = vi.fn(async () => ({ ok: false, reason, message }))
    await render()
    expect(container.textContent).not.toContain('Resolve sources')
    const card = [...container.querySelectorAll('button')].find((entry) =>
      entry.textContent?.includes('Presentation')
    )!
    await act(async () => card.click())
    expect(mocked.core.applySavedSceneResult).toHaveBeenCalledExactlyOnceWith('scene-a', undefined)
    expect(document.body.textContent).not.toContain('Resolve scene sources')
  }
)

describe('Follow the app in front, in the Scenes header (plan 231 D8)', () => {
  const followSwitch = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-videorc-follow-front-app] [data-slot="switch"]'
    )

  it('sits beside the orientation toggle on macOS, on by default, and turns off per device', async () => {
    await render()
    const control = followSwitch()
    expect(control).not.toBeNull()
    expect(control!.getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector('label[for="scene-follow-front-app"]')!.textContent).toBe(
      'Follow the app in front'
    )
    expect(localStorage.getItem(FOLLOW_SETTINGS_STORAGE_KEY)).toBeNull()
    await act(async () => control!.click())
    expect(followSwitch()!.getAttribute('aria-checked')).toBe('false')
    expect(getFollowSettings().followFrontApp).toBe(false)
    expect(JSON.parse(localStorage.getItem(FOLLOW_SETTINGS_STORAGE_KEY)!)).toEqual({
      followFrontApp: false
    })
    await act(async () => followSwitch()!.click())
    expect(localStorage.getItem(FOLLOW_SETTINGS_STORAGE_KEY)).toBeNull()
  })

  it.each(['win32', 'linux'])('is absent on %s, not disabled', async (platform) => {
    mocked.core.runtimeInfo = { platform }
    await render()
    expect(followSwitch()).toBeNull()
    expect(container.textContent).not.toContain('Follow the app in front')
  })

  it('locks the orientation toggle while recording or live', async () => {
    mocked.core.isSessionActive = true
    await render()
    const toggle = container.querySelector('[aria-label="Studio orientation"]')!
    const segments = [...toggle.querySelectorAll('button')]
    expect(segments.length).toBe(2)
    expect(segments.every((segment) => segment.disabled)).toBe(true)
  })
})
