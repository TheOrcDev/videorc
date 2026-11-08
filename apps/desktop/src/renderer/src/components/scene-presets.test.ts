// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeSceneVisual } from '@/lib/scene-presets'
import { defaultCaptureConfig } from '@/lib/capture'
import { ScenePresetControls } from './scene-presets'
const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioAudio: () => ({ audioMeter: null })
}))
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
      workingOrigin: 'builtin',
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
    saveScene: vi.fn(() => true),
    deleteSavedScene: vi.fn(() => true),
    renameSavedScene: vi.fn(() => true),
    applySavedSceneResult: vi.fn(async () => ({ ok: true })),
    applySavedScene: vi.fn(async () => true)
  }
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(): Promise<void> {
  await act(async () => root.render(createElement(ScenePresetControls)))
}
async function click(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent === label
  )!
  expect(button).toBeTruthy()
  await act(async () => button.click())
}
async function input(value: string): Promise<void> {
  const element = document.querySelector('input')!
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
describe("Studio's saved scenes (plan 210 D6)", () => {
  it('heads the gallery with Save scene… and New scene…, and never Update or Modified', async () => {
    mocked.core.savedScenes = [saved()]
    mocked.core.activeSavedSceneId = 'scene-a'
    await render()
    const labels = [...container.querySelectorAll('button')]
      .map((b) => b.textContent)
      .filter((label) => label?.endsWith('…'))
    expect(labels).toEqual(['Save scene…', 'New scene…'])
    expect(container.textContent).not.toMatch(/Update|Modified/)
    await menu('Duplicate')
    expect(
      (mocked.core.sceneLibraryActions as { insert: ReturnType<typeof vi.fn> }).insert
    ).toHaveBeenCalledWith([expect.objectContaining({ name: 'Presentation 2' })], 'scene-a')
  })

  it('starts Save scene… with a name, validates inline and saves only explicitly', async () => {
    await render()
    await click('Save scene…')
    expect(document.querySelector('input')!.value).toBe('Screen only')
    await input('')
    await click('Save')
    expect(document.body.textContent).toContain('between 1 and 80')
    expect(mocked.core.saveScene).not.toHaveBeenCalled()
    await input('Presentation')
    await click('Save')
    expect(mocked.core.saveScene).toHaveBeenCalledExactlyOnceWith('Presentation')
  })

  it('says why Save scene… is off and shows future-version recovery', async () => {
    mocked.core.canSaveScene = false
    mocked.core.sceneLibraryActions = {
      ...(mocked.core.sceneLibraryActions as object),
      readOnly: true
    }
    mocked.core.sceneLibraryError =
      'Update Videorc to open these scenes. Your saved data is preserved.'
    await render()
    const save = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Save scene…'
    )!
    expect(save.disabled).toBe(true)
    expect(
      document.getElementById(save.closest('[aria-describedby]')!.getAttribute('aria-describedby')!)
        ?.textContent
    ).toBe('Update Videorc to save scenes. Your saved scenes are kept.')
    expect(container.textContent).toContain('saved data is preserved')
  })

  it('renames from ⋯ and asks before deleting', async () => {
    mocked.core.savedScenes = [saved()]
    mocked.core.activeSavedSceneId = 'scene-a'
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
