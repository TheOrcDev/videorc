// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BackgroundAssetsProvider } from '@/hooks/use-background-assets'
import {
  applyLiveBackground,
  createDefaultRegistry,
  liveSceneBackground,
  reconcileRegistry,
  type BackgroundAssetRegistry,
  type LiveBackgroundStatusView
} from '@/lib/background-assets'
import {
  applySlot,
  defaultLiveBackgroundSettings,
  setLiveBackgroundSettings
} from '@/lib/background-library'
import { STORAGE_KEYS } from '@/lib/capture'
import { AssetsTab } from '@/components/tabs/assets-tab'

// Plan 190 S8: Assets → Backgrounds → Live. Five built-in tiles above the
// pictures; a click toggles one on the scene; Adjust style holds Look,
// Motion, Visibility and Dim, and says why a still frame shows.

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/lib/toast', () => ({ toast: mocked.toast }))
vi.mock('@/components/takeover-screens-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/takeover-screens-section')>()),
  TakeoverScreensSection: () => null
}))
vi.mock('@/components/banners-section', () => ({ BannersSection: () => null }))
vi.mock('@/components/sounds-section', () => ({ SoundsSection: () => null }))

let root: Root
let container: HTMLDivElement
let applyLive: ReturnType<typeof vi.fn>
let applySlotOnScene: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  applyLive = vi.fn()
  applySlotOnScene = vi.fn()
  mocked.core = {
    applyBackgroundSlot: applySlotOnScene,
    applyLiveBackground: applyLive,
    applyWorkingBackgroundStyle: vi.fn(),
    liveBackgroundStatus: null,
    scene: null
  }
  localStorage.clear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function renderAssets(registry?: BackgroundAssetRegistry): Promise<void> {
  if (registry) localStorage.setItem(STORAGE_KEYS.backgroundAssets, JSON.stringify(registry))
  await act(async () =>
    root.render(createElement(BackgroundAssetsProvider, null, createElement(AssetsTab)))
  )
}

const storedRegistry = (): BackgroundAssetRegistry =>
  reconcileRegistry(JSON.parse(localStorage.getItem(STORAGE_KEYS.backgroundAssets) ?? 'null'))

const liveTile = (id: string): HTMLElement =>
  document.querySelector(`[data-videorc-live-background-tile="${id}"]`) as HTMLElement
const liveTiles = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-videorc-live-background-tile]')
]
const tileButton = (id: string): HTMLButtonElement =>
  liveTile(id).querySelector('button[aria-pressed]') as HTMLButtonElement
const byLabel = (label: string): HTMLElement | null =>
  document.querySelector(`[aria-label="${label}"]`)
const popover = (): HTMLElement | null =>
  document.querySelector('[data-videorc-live-background-style]')
const popoverText = (): string => popover()?.textContent ?? ''

async function openStyle(name: string): Promise<void> {
  await act(async () => byLabel(`Adjust style for ${name}`)!.click())
}

describe('Assets → Backgrounds → Live (plan 190 S8)', () => {
  it("shows the ten live tiles above the pictures, each with its current look's thumbnail", async () => {
    const registry = setLiveBackgroundSettings(createDefaultRegistry(), 'silk', {
      look: 'midnight'
    })
    await renderAssets(registry)

    // Plan 194 S6: the five more join after the first five.
    expect(liveTiles().map((tile) => tile.dataset.videorcLiveBackgroundTile)).toEqual([
      'silk',
      'side-rays',
      'plasma-wave',
      'liquid-chrome',
      'line-waves',
      'beams',
      'color-bends',
      'dither',
      'ferrofluid',
      'ghost-fibers'
    ])
    const thumbnail = (id: string): string =>
      liveTile(id).querySelector('img')?.getAttribute('src') ?? ''
    // A stored look shows its own thumbnail; the others show their first look.
    expect(thumbnail('silk')).toContain('live-thumbs/live-silk-midnight.webp')
    expect(thumbnail('side-rays')).toContain('live-thumbs/live-side-rays-sunbeam.webp')
    expect(thumbnail('plasma-wave')).toContain('live-thumbs/live-plasma-wave-plasma.webp')
    expect(thumbnail('liquid-chrome')).toContain('live-thumbs/live-liquid-chrome-polished.webp')
    expect(thumbnail('line-waves')).toContain('live-thumbs/live-line-waves-silk.webp')

    // Name and a monochrome Live tag; built in, so no ⋯ menu.
    const silk = liveTile('silk')
    expect(silk.textContent).toContain('Silk')
    const tag = silk.querySelector('[data-slot="badge"]')
    expect(tag?.textContent).toBe('Live')
    expect(tag?.getAttribute('data-variant')).toBe('outline')
    expect(byLabel('Actions for Silk')).toBeNull()

    // The group sits above the picture gallery and ends with the credit.
    const live = document.querySelector('[data-videorc-live-backgrounds]')!
    const images = document.querySelector('[data-videorc-image-backgrounds]')!
    expect(live.compareDocumentPosition(images) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(live.querySelector('h3')?.textContent).toBe('Live')
    expect(images.querySelector('h3')?.textContent).toBe('Images')
    expect(live.lastElementChild?.textContent).toBe('From React Bits by David Haz.')
    expect(document.body.textContent).toContain(
      'Live backgrounds move behind your screen and camera. Images can be PNG, JPEG or WebP.'
    )
  })

  it('applies a live tile on click, and takes the active one off', async () => {
    await renderAssets()
    expect(tileButton('plasma-wave').getAttribute('aria-pressed')).toBe('false')
    expect(tileButton('plasma-wave').getAttribute('aria-label')).toBe(
      'Apply Plasma Wave to the scene'
    )
    await act(async () => tileButton('plasma-wave').click())
    expect(applyLive).toHaveBeenLastCalledWith('plasma-wave')
    expect(applySlotOnScene).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    root = createRoot(container)
    await renderAssets(applyLiveBackground(createDefaultRegistry(), 'plasma-wave'))
    const active = tileButton('plasma-wave')
    expect(active.getAttribute('aria-pressed')).toBe('true')
    expect(active.getAttribute('aria-label')).toBe('Remove Plasma Wave from the scene')
    expect(liveTile('plasma-wave').querySelector('[data-videorc-in-use]')?.textContent).toBe(
      'In use'
    )
    // The active tile keeps Adjust style in view; the others show it on hover.
    expect(byLabel('Adjust style for Plasma Wave')!.className).not.toContain('opacity-0')
    expect(byLabel('Adjust style for Silk')!.className).toContain('opacity-0')
    await act(async () => active.click())
    expect(applyLive).toHaveBeenLastCalledWith(null)
  })

  it('reads In use on one background only: the live one or the picture', async () => {
    const live = applyLiveBackground(applySlot(createDefaultRegistry(), 'bg-02'), 'silk')
    await renderAssets(live)
    const inUse = (): (string | undefined)[] =>
      [...document.querySelectorAll('[data-videorc-in-use]')].map((chip) => {
        const tile = chip.closest<HTMLElement>(
          '[data-videorc-live-background-tile], [data-videorc-background-tile]'
        )
        return tile?.dataset.videorcLiveBackgroundTile ?? tile?.dataset.videorcBackgroundTile
      })
    expect(inUse()).toEqual(['silk'])

    await act(async () => root.unmount())
    root = createRoot(container)
    await renderAssets(applySlot(live, 'bg-02'))
    expect(inUse()).toEqual(['bg-02'])
    expect(tileButton('silk').getAttribute('aria-pressed')).toBe('false')
  })

  it('offers only Look, Motion, Visibility and Dim in Adjust style', async () => {
    await renderAssets(applyLiveBackground(createDefaultRegistry(), 'silk'))
    await openStyle('Silk')
    const labels = [...popover()!.querySelectorAll('label')].map((label) => label.textContent)
    expect(labels).toEqual(['Look', 'Motion', 'Visibility', 'Dim'])
    for (const pictureOnly of [
      'Fit',
      'Scale',
      'Pan X',
      'Pan Y',
      'Blur',
      'Saturation',
      'Vignette'
    ]) {
      expect(labels).not.toContain(pictureOnly)
    }
    expect(byLabel('Visibility value')).toBeTruthy()
    expect(byLabel('Dim value')).toBeTruthy()
    // Calm is the default motion.
    const radios = [...popover()!.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(radios.map((radio) => radio.textContent)).toEqual(['Calm', 'Normal'])
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    // No Remove, Rename or Replace anywhere on a live tile.
    expect(liveTile('silk').textContent).not.toMatch(/Remove|Rename|Replace/)
  })

  it('switches a look and a motion through the registry, without applying a tile that is off', async () => {
    await renderAssets()
    await openStyle('Liquid Chrome')
    const trigger = popover()!.querySelector<HTMLElement>('[data-slot="select-trigger"]')!
    expect(trigger.textContent).toContain('Polished')
    await act(async () => trigger.click())
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((option) => option.textContent)).toEqual(['Polished', 'Gold', 'Mercury'])
    await act(async () => options[1].click())

    expect(storedRegistry().live.settings['liquid-chrome']?.look).toBe('gold')
    expect(liveTile('liquid-chrome').querySelector('img')?.getAttribute('src')).toContain(
      'live-liquid-chrome-gold.webp'
    )

    const normal = [...popover()!.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (radio) => radio.textContent === 'Normal'
    )!
    await act(async () => normal.click())
    expect(storedRegistry().live.settings['liquid-chrome']).toStrictEqual({
      ...defaultLiveBackgroundSettings('liquid-chrome'),
      look: 'gold',
      motion: 'normal'
    })
    // Remembered for its next click; nothing went on the scene.
    expect(storedRegistry().live.activeId).toBeNull()
    expect(applyLive).not.toHaveBeenCalled()
  })

  it('says why the background on the scene shows a still frame', async () => {
    const status: LiveBackgroundStatusView = {
      id: 'silk',
      rendering: 'still',
      reason: 'legacy-graph'
    }
    mocked.core.liveBackgroundStatus = status
    await renderAssets(applyLiveBackground(createDefaultRegistry(), 'silk'))
    await openStyle('Silk')
    const line = popover()!.querySelector('[data-videorc-live-background-still]')
    expect(line?.textContent).toBe(
      "Showing a still frame: it can't move at this resolution and frame rate."
    )
    expect(line?.className).toContain('text-muted-foreground')
    expect(line?.className).not.toContain('text-subtle')
  })

  it('stays quiet while the background moves, and for another tile', async () => {
    mocked.core.liveBackgroundStatus = { id: 'silk', rendering: 'shader' }
    await renderAssets(applyLiveBackground(createDefaultRegistry(), 'silk'))
    await openStyle('Silk')
    expect(popover()!.querySelector('[data-videorc-live-background-still]')).toBeNull()
    expect(popoverText()).not.toContain('still frame')
  })

  it('names a live background in the scene row, and edits it with the live controls', async () => {
    const registry = setLiveBackgroundSettings(
      applyLiveBackground(createDefaultRegistry(), 'side-rays'),
      'side-rays',
      { look: 'moonlight' }
    )
    mocked.core.scene = {
      id: 'main',
      name: 'Main',
      sources: [],
      outputs: [],
      background: liveSceneBackground('side-rays', {
        ...defaultLiveBackgroundSettings('side-rays'),
        look: 'moonlight'
      })
    }
    await renderAssets(registry)
    const row = document.querySelector<HTMLElement>('[data-videorc-scene-background]')!
    expect(row.textContent).toContain('In this scene: Side Rays · Moonlight')

    await act(async () =>
      row
        .querySelector<HTMLElement>('[aria-label="Adjust style for Side Rays · Moonlight"]')!
        .click()
    )
    const labels = [...popover()!.querySelectorAll('label')].map((label) => label.textContent)
    expect(labels).toEqual(['Look', 'Motion', 'Visibility', 'Dim'])

    const useNone = [...row.querySelectorAll('button')].find(
      (button) => button.textContent === 'Use no background'
    )!
    await act(async () => useNone.click())
    expect(applySlotOnScene).toHaveBeenCalledWith(null)
  })
})
