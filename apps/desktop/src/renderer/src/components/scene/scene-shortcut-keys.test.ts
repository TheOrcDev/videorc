// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SceneShortcutKeys } from './scene-shortcut-keys'

const registered = vi.hoisted(() => ({ 'scene-slot-1': false }))
vi.mock('@/lib/global-shortcuts', () => ({
  globalShortcutRegistration: { subscribe: () => () => undefined, getSnapshot: () => registered }
}))

it('shows the failed position key in words beside a working custom key', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        createElement(SceneShortcutKeys, {
          sceneId: 'figma',
          position: 1,
          config: { scenes: { figma: 'F13' } },
          platform: 'darwin'
        })
      )
    )
    expect(container.textContent).toContain('Another app uses ⌃⌥1')
    expect(container.querySelector('[data-accelerator="Control+Alt+1"]')).toBeNull()
    expect(container.querySelector('[data-accelerator="F13"]')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
