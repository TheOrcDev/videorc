// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeSceneVisual } from '@/lib/scene-presets'
import { defaultCaptureConfig } from '@/lib/capture'
import { ScenePresetControls } from './scene-presets'
const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
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
    savedSceneModified: false,
    savedScenePendingId: null,
    canSaveScene: true,
    sceneLibraryError: null,
    deviceList: { devices: [] },
    captureConfig: defaultCaptureConfig,
    isSessionActive: false,
    saveScene: vi.fn(() => true),
    deleteSavedScene: vi.fn(() => true),
    renameSavedScene: vi.fn(() => true),
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
const saved = () => ({
  id: 'scene-a',
  name: 'Presentation',
  createdAt: '2026-09-22',
  updatedAt: '2026-09-22',
  visual: normalizeSceneVisual({
    layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-only' },
    sources: { testPattern: true },
    background: null
  })
})
async function menu(action: string): Promise<void> {
  const trigger = document.querySelector('button[aria-label="Actions for Presentation"]')!
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((entry) =>
    entry.textContent?.includes(action)
  )!
  expect(item).toBeTruthy()
  await act(async () => (item as HTMLElement).click())
}
describe('scene library controls', () => {
  it('validates names inline and saves only explicitly', async () => {
    await render()
    await click('Save scene')
    await click('Save')
    expect(document.body.textContent).toContain('between 1 and 80')
    expect(mocked.core.saveScene).not.toHaveBeenCalled()
    await input('Presentation')
    await click('Save')
    expect(mocked.core.saveScene).toHaveBeenCalledExactlyOnceWith('Presentation', undefined)
  })
  it('disables saving unresolved visuals and shows future-version recovery', async () => {
    mocked.core.canSaveScene = false
    mocked.core.sceneLibraryError =
      'This scene library uses an unsupported version. Its saved data has been preserved.'
    await render()
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
    expect(container.textContent).toContain('saved data has been preserved')
  })
  it('renames, explicitly updates the selected snapshot, and saves a new identity separately', async () => {
    mocked.core.savedScenes = [saved()]
    mocked.core.activeSavedSceneId = 'scene-a'
    mocked.core.savedSceneModified = true
    await render()
    await menu('Rename')
    await input('Renamed')
    await click('Rename')
    expect(mocked.core.renameSavedScene).toHaveBeenCalledExactlyOnceWith('scene-a', 'Renamed')
    await menu('Update saved scene')
    await click('Save')
    expect(mocked.core.saveScene).toHaveBeenLastCalledWith('Presentation', 'scene-a')
    await menu('Save as new scene')
    await input('Second')
    await click('Save')
    expect(mocked.core.saveScene).toHaveBeenLastCalledWith('Second', undefined)
  })
  it('requires confirmation to delete and cancel leaves the running picture alone', async () => {
    mocked.core.savedScenes = [saved()]
    mocked.core.activeSavedSceneId = 'scene-a'
    await render()
    await menu('Delete')
    expect(mocked.core.deleteSavedScene).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('current scene and recording continue')
    await click('Cancel')
    expect(mocked.core.deleteSavedScene).not.toHaveBeenCalled()
    await menu('Delete')
    await click('Delete scene')
    expect(mocked.core.deleteSavedScene).toHaveBeenCalledExactlyOnceWith('scene-a')
    expect(mocked.core.applySavedScene).not.toHaveBeenCalled()
  })
  it('repairs an unavailable window with exact source selection before dispatch', async () => {
    await import('./source-select-searchable')
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
    expect(mocked.core.applySavedScene).not.toHaveBeenCalled()
    expect(
      [...document.querySelectorAll('button')].find((entry) => entry.textContent === 'Apply scene')
        ?.disabled
    ).toBe(true)
    const trigger = document.querySelector('button[aria-label="Screen / window"]')!
    await act(async () => (trigger as HTMLElement).click())
    await act(async () =>
      (document.querySelector('[cmdk-item][data-value="screen-new"]') as HTMLElement).click()
    )
    expect(mocked.core.applySavedScene).not.toHaveBeenCalled()
    await click('Apply scene')
    expect(mocked.core.applySavedScene).toHaveBeenCalledExactlyOnceWith(
      'scene-a',
      expect.objectContaining({
        sources: expect.objectContaining({ screenId: 'screen-new', windowId: undefined })
      })
    )
  })
})
