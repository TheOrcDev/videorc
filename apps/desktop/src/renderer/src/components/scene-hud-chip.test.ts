// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SceneHudChip } from './scene-hud-chip'
import type { SceneHudPresentation } from '../../../shared/scene-hud'

describe('the key HUD chip (plan 231 D20)', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

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

  const render = (presentation: SceneHudPresentation, phase: 'shown' | 'fading' = 'shown') =>
    act(async () => root.render(createElement(SceneHudChip, { presentation, phase, fadeMs: 120 })))

  it('holds the app icon, the name and the key, on the toast glass', async () => {
    await render({
      name: 'T3 Code',
      icon: { kind: 'app', bundleId: 'com.t3.code' },
      iconDataUrl: 'data:image/png;base64,AAAA',
      key: 'Control+Alt+2',
      sequence: 1,
      platform: 'darwin'
    })
    const chip = container.querySelector<HTMLElement>('[data-testid="scene-hud-chip"]')!
    expect(chip.getAttribute('role')).toBe('status')
    expect(chip.className).toContain('glass-float')
    expect(chip.className).toContain('rounded-full')
    expect(chip.textContent).toContain('T3 Code')
    expect(chip.querySelector('kbd')?.textContent).toBe('⌃⌥2')
    expect(chip.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(chip.querySelector('[data-slot="status-dot"]')).toBeNull()
  })

  it('says a refusal in words, with its tone on a dot', async () => {
    await render({
      name: 'Figma',
      icon: { kind: 'app', bundleId: 'com.figma.Desktop' },
      key: 'Control+Alt+1',
      refusal: "Figma isn't open",
      sequence: 2,
      platform: 'darwin'
    })
    const chip = container.querySelector<HTMLElement>('[data-testid="scene-hud-chip"]')!
    expect(chip.dataset.refusal).toBe('true')
    expect(chip.textContent).toContain("Figma isn't open")
    expect(chip.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('warn')
  })

  it('fades on opacity alone, for the given time', async () => {
    await render({ name: 'Display 1', icon: { kind: 'display' }, sequence: 3, platform: 'win32' })
    const shown = container.querySelector<HTMLElement>('[data-testid="scene-hud-chip"]')!
    expect(shown.className).toContain('opacity-100')
    expect(shown.querySelector('kbd')).toBeNull()
    await render(
      { name: 'Display 1', icon: { kind: 'display' }, sequence: 3, platform: 'win32' },
      'fading'
    )
    const fading = container.querySelector<HTMLElement>('[data-testid="scene-hud-chip"]')!
    expect(fading.className).toContain('opacity-0')
    expect(fading.className).toContain('transition-opacity')
    expect(fading.className).toContain('motion-reduce:transition-none')
    expect(fading.style.transitionDuration).toBe('120ms')
  })
})
