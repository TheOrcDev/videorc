// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ScreenSizeField } from '@/components/scene/screen-size-field'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createDefaultRegistry, type BackgroundAssetRegistry } from '@/lib/background-assets'
import { setLiveBackgroundSettings } from '@/lib/background-library'

// QA F24: the recording/live lock holds against a double-click on the track.

const fixtures = vi.hoisted(() => ({
  setRegistry: vi.fn(),
  applyWorkingBackgroundStyle: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => fixtures }))
vi.mock('@/hooks/use-background-assets', () => ({ useBackgroundAssets: () => fixtures }))

const LOCKED = "Screen size is locked while you're recording or live."

let root: Root
let container: HTMLDivElement
let registry: BackgroundAssetRegistry

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  registry = setLiveBackgroundSettings(createDefaultRegistry(), 'silk', { visibilityPercent: 10 })
  fixtures.setRegistry.mockReset().mockImplementation((update) => {
    registry = update(registry)
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('Screen size lock (QA F24)', () => {
  for (const locked of [false, true]) {
    it(`a double-click on the track ${locked ? 'changes nothing while locked' : 'resets it'}`, async () => {
      await act(async () =>
        root.render(
          createElement(
            TooltipProvider,
            null,
            createElement(ScreenSizeField, {
              background: { live: { id: 'silk' }, visibilityPercent: 10 },
              disabledReason: locked ? LOCKED : null
            } as Parameters<typeof ScreenSizeField>[0])
          )
        )
      )
      const input = container.querySelector(
        'input[aria-label="Screen size value"]'
      ) as HTMLInputElement
      expect(input.value).toBe('90')
      expect(input.disabled).toBe(locked)
      const track = container.querySelector('[data-slot="slider-track"]')!
      await act(async () => track.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
      expect(registry.live.settings.silk?.visibilityPercent).toBe(locked ? 10 : 20)
      if (locked) expect(fixtures.setRegistry).not.toHaveBeenCalled()
    })
  }
})
