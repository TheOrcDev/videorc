// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import {
  GLOBAL_ROW_APP_KEYS,
  globalShortcutRows,
  sceneHudPlatform,
  ShortcutsSettings
} from './shortcuts-settings'
import type { GlobalShortcutsConfig } from '@/lib/backend'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  registered: { 'scene-slot-3': false }
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/lib/global-shortcuts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/global-shortcuts')>()),
  globalShortcutRegistration: {
    subscribe: () => () => undefined,
    getSnapshot: () => mocked.registered
  }
}))

it('renders the Scenes group in order, names conflicts, and changes or clears a position', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let shortcuts: GlobalShortcutsConfig = { scenes: { figma: 'F13' } }
  const setSettings = vi.fn(
    (
      update: (current: { globalShortcuts: GlobalShortcutsConfig }) => {
        globalShortcuts: GlobalShortcutsConfig
      }
    ) => {
      shortcuts = update({ globalShortcuts: shortcuts }).globalShortcuts
    }
  )
  mocked.core = {
    settings: { globalShortcuts: shortcuts },
    setSettings,
    runtimeInfo: { platform: 'darwin' },
    deviceList: { devices: [] },
    savedScenes: [
      { id: 'figma', name: 'Figma' },
      { id: 't3', name: 'T3 Code' }
    ]
  }
  const render = () => act(async () => root.render(createElement(ShortcutsSettings)))
  try {
    await render()
    const group = container.querySelector('fieldset')!
    expect(group.textContent).toContain('Scenes')
    expect([...group.querySelectorAll('label')].map((label) => label.textContent)).toEqual([
      'Scene 1 · Figma',
      'Scene 2 · T3 Code',
      ...Array.from({ length: 7 }, (_, index) => `Scene ${index + 3} · no scene`),
      'Figma',
      // The key HUD's switch closes the group (plan 231 D20).
      "Show the scene's name when a key switches it"
    ])
    expect(group.textContent).toContain('Another app uses ⌃⌥3')
    expect(container.textContent).not.toMatch(/Horizontal layouts|Vertical layouts/)
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Clear the Scene 1 · Figma shortcut"]')!
        .click()
    )
    expect(shortcuts).toEqual({ scenes: { figma: 'F13' }, sceneSlots: { 1: '' } })
    mocked.core.settings = { globalShortcuts: shortcuts }
    await render()
    const recorder = container.querySelector<HTMLButtonElement>('#global-shortcut-scene-slot-1')!
    await act(async () => recorder.click())
    await act(async () =>
      recorder.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'F14', code: 'F14' })
      )
    )
    expect(shortcuts.sceneSlots?.[1]).toBe('F14')
    mocked.core.savedScenes = [
      { id: 't3', name: 'T3 Code' },
      { id: 'figma', name: 'Figma' }
    ]
    mocked.core.settings = { globalShortcuts: shortcuts }
    await render()
    expect(container.querySelector('label')?.textContent).toBe('Hide screen')
    expect(container.querySelector('fieldset label')?.textContent).toBe('Scene 1 · T3 Code')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

describe('globalShortcutRows (Linux plan 0019)', () => {
  it('offers the system audio shortcut only where system audio can run', () => {
    expect(globalShortcutRows({ systemAudioAvailable: true, systemAudioBound: false })).toContain(
      'system-audio-toggle'
    )
    const linux = globalShortcutRows({ systemAudioAvailable: false, systemAudioBound: false })
    expect(linux).not.toContain('system-audio-toggle')
    expect(linux).toContain('record-toggle')
    expect(linux).toContain('mic-toggle')
  })

  it('offers both clip lengths, the minute right after the 30 seconds (plan 199)', () => {
    const rows = globalShortcutRows({ systemAudioAvailable: true, systemAudioBound: false })
    expect(rows.indexOf('clip-mark-long')).toBe(rows.indexOf('clip-mark') + 1)
  })

  it('keeps a binding saved elsewhere visible so it can be cleared', () => {
    expect(globalShortcutRows({ systemAudioAvailable: false, systemAudioBound: true })).toContain(
      'system-audio-toggle'
    )
  })
})

describe('GLOBAL_ROW_APP_KEYS', () => {
  it("shows Studio's Space in the Record row, the key it really is", () => {
    expect(GLOBAL_ROW_APP_KEYS['record-toggle']).toEqual({
      accelerator: 'Space',
      where: 'in Studio'
    })
  })

  it('claims no in-app key for actions that have none', () => {
    expect(Object.keys(GLOBAL_ROW_APP_KEYS)).toEqual(['record-toggle'])
  })
})

describe("Show the scene's name when a key switches it (plan 231 D20)", () => {
  it('is on by default, turns off and on, and has no switch on Linux', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let settings: { globalShortcuts: GlobalShortcutsConfig; sceneHud?: boolean } = {
      globalShortcuts: {}
    }
    mocked.core = {
      settings,
      setSettings: vi.fn((update: (current: typeof settings) => typeof settings) => {
        settings = update(settings)
      }),
      runtimeInfo: { platform: 'darwin' },
      deviceList: { devices: [] },
      savedScenes: []
    }
    const render = () => act(async () => root.render(createElement(ShortcutsSettings)))
    // The id is on Base UI's hidden input; the label for it names the switch.
    const hudSwitch = () => {
      const label = container.querySelector('label[for="scene-hud"]')
      return label
        ? container.querySelector<HTMLElement>(`[role="switch"][aria-labelledby="${label.id}"]`)
        : null
    }
    try {
      await render()
      // An absent key is on: a profile from before the HUD keeps it on.
      expect(hudSwitch()?.getAttribute('aria-checked')).toBe('true')
      await act(async () => hudSwitch()!.click())
      expect(settings.sceneHud).toBe(false)
      mocked.core.settings = settings
      await render()
      expect(hudSwitch()?.getAttribute('aria-checked')).toBe('false')
      mocked.core.runtimeInfo = { platform: 'linux' }
      await render()
      expect(hudSwitch()).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    }
  })

  it('exists where a window can be left out of a capture', () => {
    expect(sceneHudPlatform('darwin')).toBe(true)
    expect(sceneHudPlatform('win32')).toBe(true)
    expect(sceneHudPlatform('linux')).toBe(false)
    expect(sceneHudPlatform(undefined)).toBe(false)
  })
})
