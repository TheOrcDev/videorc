// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BackgroundAssetsProvider } from '@/hooks/use-background-assets'
import {
  applySlot,
  createDefaultRegistry,
  createImportedAsset,
  type BackgroundAssetRegistry
} from '@/lib/background-assets'
import { STORAGE_KEYS } from '@/lib/capture'
import { AssetsTab } from '@/components/tabs/assets-tab'
import { BackgroundReplaceDialog, radioStep } from './background-replace-dialog'

// Plan 174 (C-2, D14): on a fresh profile all ten background slots are in
// use, so Import asks which background the picked image replaces.

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/lib/toast', () => ({ toast: mocked.toast }))
vi.mock('@/components/takeover-screens-section', () => ({ TakeoverScreensSection: () => null }))

const imported = createImportedAsset({
  id: 'imported-1',
  name: 'Studio wall',
  assetPath: '/managed/imported-1.png',
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z'
})

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.core = {
    applyBackgroundSlot: vi.fn(),
    applyWorkingBackgroundStyle: vi.fn(),
    scene: null
  }
  localStorage.clear()
  vi.clearAllMocks()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const radios = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')
]
const checked = (): HTMLButtonElement | undefined =>
  radios().find((radio) => radio.getAttribute('aria-checked') === 'true')
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent === label
  )

describe('radioStep', () => {
  it('moves through the tiles like a radio group, wrapping at the ends', () => {
    expect(radioStep(0, 10, 'ArrowRight')).toBe(1)
    expect(radioStep(9, 10, 'ArrowDown')).toBe(0)
    expect(radioStep(0, 10, 'ArrowLeft')).toBe(9)
    expect(radioStep(4, 10, 'ArrowUp')).toBe(3)
    expect(radioStep(4, 10, 'Home')).toBe(0)
    expect(radioStep(4, 10, 'End')).toBe(9)
    expect(radioStep(4, 10, 'a')).toBeNull()
    expect(radioStep(0, 0, 'ArrowRight')).toBeNull()
  })
})

describe('Replace which background?', () => {
  async function renderDialog(
    registry: BackgroundAssetRegistry,
    preselectedSlotId: string
  ): Promise<{ onReplace: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> }> {
    const onReplace = vi.fn()
    const onCancel = vi.fn()
    await act(async () =>
      root.render(
        createElement(BackgroundReplaceDialog, {
          pending: { asset: imported, preselectedSlotId },
          registry,
          onReplace,
          onCancel
        })
      )
    )
    return { onReplace, onCancel }
  }

  it('offers the ten backgrounds with the preselected one checked and focused', async () => {
    const registry = applySlot(createDefaultRegistry(), 'bg-06')
    await renderDialog(registry, 'bg-06')
    expect(document.body.textContent).toContain('Replace which background?')
    expect(document.body.textContent).toContain('"Studio wall"')
    expect(radios()).toHaveLength(10)
    expect(checked()?.dataset.backgroundSlot).toBe('bg-06')
    expect(checked()?.tabIndex).toBe(0)
    expect(radios().filter((radio) => radio.tabIndex === 0)).toHaveLength(1)
    expect(button('Replace Podcast')).toBeTruthy()
  })

  it('moves the choice with the arrow keys and replaces the chosen one', async () => {
    const { onReplace } = await renderDialog(createDefaultRegistry(), 'bg-10')
    await act(async () => {
      checked()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(checked()?.dataset.backgroundSlot).toBe('bg-01')
    expect(document.activeElement).toBe(checked())
    await act(async () => radios()[2]!.click())
    expect(checked()?.dataset.backgroundSlot).toBe('bg-03')
    await act(async () => button('Replace Tutorial')!.click())
    expect(onReplace).toHaveBeenCalledWith('bg-03', imported)
  })

  it('changes nothing on Cancel', async () => {
    const { onReplace, onCancel } = await renderDialog(createDefaultRegistry(), 'bg-10')
    await act(async () => button('Cancel')!.click())
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onReplace).not.toHaveBeenCalled()
  })
})

describe('Assets Import on a fresh profile', () => {
  it('opens the file picker, then replaces the background the streamer picks', async () => {
    const importBackgroundImage = vi.fn(async () => ({
      id: 'imported-2',
      name: 'Neon sign',
      assetPath: '/managed/imported-2.png',
      thumbnailPath: '/managed/imported-2.png',
      fileName: 'neon-sign.png'
    }))
    vi.stubGlobal('videorc', { importBackgroundImage })
    await act(async () =>
      root.render(createElement(BackgroundAssetsProvider, null, createElement(AssetsTab)))
    )

    await act(async () => button('Import')!.click())
    expect(importBackgroundImage).toHaveBeenCalledTimes(1)
    expect(mocked.toast.error).not.toHaveBeenCalled()
    // The last slot is preselected on a profile with no active background.
    expect(checked()?.dataset.backgroundSlot).toBe('bg-10')

    await act(async () => radios()[5]!.click())
    await act(async () => button('Replace Podcast')!.click())

    expect(document.body.textContent).not.toContain('Replace which background?')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.backgroundAssets)!)
    const podcast = stored.slots.find((slot: { id: string }) => slot.id === 'bg-06')
    expect(podcast.assetId).toBe('imported-2')
    expect(stored.assets['imported-2'].name).toBe('Neon sign')
    // The replaced tile is the confirmation: no routine success toast (J2-11).
    expect(mocked.toast.success).not.toHaveBeenCalled()
  })

  it('leaves every background as it was when the picker is cancelled', async () => {
    vi.stubGlobal('videorc', { importBackgroundImage: vi.fn(async () => null) })
    await act(async () =>
      root.render(createElement(BackgroundAssetsProvider, null, createElement(AssetsTab)))
    )
    await act(async () => button('Import')!.click())
    expect(radios()).toHaveLength(0)
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.backgroundAssets)!)
    expect(
      stored.slots.every((slot: { assetId: string }) => slot.assetId.startsWith('builtin-'))
    ).toBe(true)
  })
})
