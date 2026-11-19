// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedScene } from '@/lib/scene-presets'
import { sceneKeyDescription, useSceneDialogs, type SceneDialogRequest } from './scene-dialogs'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioAudio: () => ({ audioMeter: null })
}))

const WAYLAND = "Global shortcuts can't work in this Wayland session."

// Linux L-01: on Wayland main registers no global shortcut, so the Set key
// dialog must not promise the key works from any app. Elsewhere it is unchanged.
describe('sceneKeyDescription', () => {
  it('keeps the original copy where global shortcuts can work', () => {
    const original = 'Puts “Talk” on stream from any app. Click the field and press the keys.'
    expect(sceneKeyDescription('Talk')).toBe(original)
    expect(sceneKeyDescription('Talk', null)).toBe(original)
  })

  it('says the key cannot work in this session when global shortcuts are unavailable', () => {
    const copy = sceneKeyDescription('Talk', WAYLAND)
    expect(copy).not.toContain('from any app')
    expect(copy).not.toContain('X11')
    expect(copy).toContain("can't hear keys while Videorc is in the background")
    expect(copy).toContain('“Talk”')
    expect(copy).toContain('Click the field and press the keys.')
  })
})

describe('Set key dialog (Linux L-01)', () => {
  let root: Root
  let container: HTMLDivElement
  let openDialog: ((request: SceneDialogRequest) => void) | undefined
  const scene = { id: 'scene-talk', name: 'Talk' } as unknown as SavedScene

  function Harness(): ReactElement {
    const dialogs = useSceneDialogs()
    openDialog = dialogs.open
    return dialogs.element
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function renderKeyDialog(globalShortcutsUnavailable?: string): Promise<string> {
    mocked.core = {
      runtimeInfo: { platform: 'linux', globalShortcutsUnavailable },
      settings: { globalShortcuts: {} },
      setSettings: vi.fn(),
      savedScenes: [scene],
      sceneLibraryActions: { stored: () => undefined },
      deviceList: { devices: [] },
      captureConfig: {
        layout: { layoutPreset: 'screen-camera' },
        sources: { screenId: 'screen:1' }
      }
    }
    await act(async () => root.render(createElement(Harness)))
    await act(async () => openDialog?.({ kind: 'key', scene }))
    return document.body.textContent ?? ''
  }

  it('shows the Wayland description and reason in place of "from any app"', async () => {
    const text = await renderKeyDialog(WAYLAND)
    expect(text).toContain(sceneKeyDescription('Talk', WAYLAND))
    expect(text).not.toContain('from any app')
    expect(document.querySelector('[data-testid="scene-key-unavailable"]')?.textContent).toBe(
      WAYLAND
    )
  })

  it('keeps "from any app" where global shortcuts work', async () => {
    const text = await renderKeyDialog()
    expect(text).toContain(sceneKeyDescription('Talk'))
    expect(document.querySelector('[data-testid="scene-key-unavailable"]')).toBeNull()
  })
})
