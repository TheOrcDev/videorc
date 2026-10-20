// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Banner } from '@/lib/backend'
import { bannerSizeAdvice } from '@/lib/banner-size'
import { BANNER_SHOWN_LIMIT_REASON } from '@/lib/banners'
import { OFFLINE_LOCK_REASON } from '@/lib/lock-view'

import {
  BANNER_AT_BACK_REASON,
  BANNER_IN_FRONT_REASON,
  BannerInspector,
  SceneBannersSection
} from './banner-inspector'

// Plan 186 S6: the Scene page's Banners list and the selected banner's
// inspector. Banners change live, so only Videorc reconnecting turns them off.

const banner = (id: string, extra: Partial<Banner> = {}): Banner => ({
  id,
  name: id === 'sponsor' ? 'Sponsor' : id === 'logo' ? 'Logo' : id,
  imageFile: `${id}.png`,
  thumbnailFile: `${id}.thumb.png`,
  width: 800,
  height: 133,
  hasAlpha: true,
  sortOrder: 0,
  shown: true,
  horizontal: { x: 0.2, y: 0.782222, w: 0.6, h: 0.177778 },
  vertical: { x: 0.071111, y: 0.699583, w: 0.857778, h: 0.080417 },
  showOnStream: true,
  showInRecording: true,
  opacity: 1,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  ...extra
})

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

type InspectorProps = ComponentProps<typeof BannerInspector>

function inspectorProps(overrides: Partial<InspectorProps> = {}): InspectorProps {
  const subject = overrides.banner ?? banner('sponsor')
  return {
    banner: subject,
    placeLabel: 'Place',
    sizeAdvice: bannerSizeAdvice({ banner: subject, output: { width: 3840, height: 2160 } }),
    blockedReason: null,
    showLimitReason: null,
    inFront: false,
    atBack: false,
    onShowChange: vi.fn(),
    onSnap: vi.fn(),
    onPatch: vi.fn(async () => null),
    onBringToFront: vi.fn(),
    onSendToBack: vi.fn(),
    onManage: vi.fn(),
    ...overrides
  }
}

async function renderInspector(props: InspectorProps): Promise<void> {
  await act(async () => root.render(createElement(BannerInspector, props)))
}

const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label
  )
  expect(found, label).toBeTruthy()
  return found!
}
const switchFor = (label: string): HTMLButtonElement => {
  const labelElement = [...document.querySelectorAll('label')].find(
    (candidate) => candidate.textContent === label
  )
  return document.getElementById(labelElement!.getAttribute('for')!) as HTMLButtonElement
}

describe('BannerInspector', () => {
  it('leads with the name, its state and Show or Hide', async () => {
    const props = inspectorProps()
    await renderInspector(props)
    const heading = document.querySelector('h2')!
    expect(heading.textContent).toBe('Sponsor')
    expect(document.body.textContent).toContain('Showing')
    await act(async () => button('Hide').click())
    expect(props.onShowChange).toHaveBeenCalledWith(false)

    const hidden = inspectorProps({ banner: banner('sponsor', { shown: false }) })
    await renderInspector(hidden)
    expect(document.body.textContent).toContain('Hidden')
    await act(async () => button('Show').click())
    expect(hidden.onShowChange).toHaveBeenCalledWith(true)
  })

  it('offers the seven places as one-shot buttons, in order', async () => {
    const props = inspectorProps({ placeLabel: 'Place on the vertical stream' })
    await renderInspector(props)
    expect(document.body.textContent).toContain('Place on the vertical stream')
    const snaps = [...document.querySelectorAll<HTMLButtonElement>('[data-videorc-banner-snap]')]
    expect(snaps.map((snap) => snap.textContent)).toEqual([
      'Top left',
      'Top center',
      'Top right',
      'Bottom left',
      'Bottom center',
      'Bottom right',
      'Full frame'
    ])
    expect(snaps.some((snap) => snap.hasAttribute('aria-pressed'))).toBe(false)
    await act(async () => button('Top center').click())
    await act(async () => button('Full frame').click())
    expect(props.onSnap).toHaveBeenNthCalledWith(1, 'top-center')
    expect(props.onSnap).toHaveBeenNthCalledWith(2, 'full-frame')
  })

  it('says the size this place needs, with a warning icon only when soft', async () => {
    await renderInspector(inspectorProps())
    const size = document.querySelector('[data-videorc-banner-size]')!
    expect(size.textContent).toContain('Size on your 3840 × 2160 recording: 2304 × 384 px')
    const verdict = size.querySelector('[data-videorc-banner-size-verdict]')!
    expect(verdict.getAttribute('data-videorc-banner-size-verdict')).toBe('soft')
    expect(verdict.textContent).toBe(
      'Your image is 800 × 133 px: it will look soft at this size. Use one at least 2304 × 384 px.'
    )
    expect(verdict.querySelector('svg')).not.toBeNull()
    expect(size.innerHTML).not.toContain('text-subtle')

    const sharp = banner('sponsor', { width: 2400, height: 400 })
    await renderInspector(inspectorProps({ banner: sharp }))
    const sharpVerdict = document.querySelector('[data-videorc-banner-size-verdict]')!
    expect(sharpVerdict.getAttribute('data-videorc-banner-size-verdict')).toBe('sharp')
    expect(sharpVerdict.textContent).toBe('Your image is 2400 × 400 px: sharp at this size.')
    expect(sharpVerdict.querySelector('svg')).toBeNull()
  })

  it('commits opacity once per change, from 20 to 100 %', async () => {
    const props = inspectorProps({ banner: banner('sponsor', { opacity: 0.6 }) })
    await renderInspector(props)
    const opacity = document.querySelector('[data-videorc-banner-opacity]')!
    expect(opacity.textContent).toContain('Opacity')
    expect(opacity.textContent).toContain('60 %')
    const thumb = opacity.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(thumb.getAttribute('aria-valuetext')).toBe('60 %')
    await act(async () =>
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    )
    expect(props.onPatch).toHaveBeenCalledTimes(1)
    expect(props.onPatch).toHaveBeenCalledWith({ opacity: 0.61 })
    await act(async () =>
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    )
    expect(props.onPatch).toHaveBeenLastCalledWith({ opacity: 0.2 })
  })

  it('switches where it appears, with two named switches outside any button', async () => {
    const props = inspectorProps({ banner: banner('sponsor', { showInRecording: false }) })
    await renderInspector(props)
    expect(document.body.textContent).toContain('Appears in')
    const stream = switchFor('Stream')
    const recording = switchFor('Recording')
    expect(stream.getAttribute('role')).toBe('switch')
    expect(stream.getAttribute('aria-checked')).toBe('true')
    expect(recording.getAttribute('aria-checked')).toBe('false')
    expect(stream.closest('button:not([role="switch"]), [role="button"]')).toBeNull()
    await act(async () => stream.click())
    await act(async () => recording.click())
    expect(props.onPatch).toHaveBeenNthCalledWith(1, { showOnStream: false })
    expect(props.onPatch).toHaveBeenNthCalledWith(2, { showInRecording: true })
  })

  it('brings to front or sends to back, and says why one is off', async () => {
    const props = inspectorProps({ inFront: true })
    await renderInspector(props)
    expect(button('Bring to front').disabled).toBe(true)
    expect(document.body.textContent).toContain(BANNER_IN_FRONT_REASON)
    await act(async () => button('Send to back').click())
    expect(props.onSendToBack).toHaveBeenCalledTimes(1)

    const back = inspectorProps({ atBack: true })
    await renderInspector(back)
    expect(button('Send to back').disabled).toBe(true)
    expect(document.body.textContent).toContain(BANNER_AT_BACK_REASON)
    await act(async () => button('Bring to front').click())
    expect(back.onBringToFront).toHaveBeenCalledTimes(1)
  })

  it('opens Assets to manage the banner', async () => {
    const props = inspectorProps()
    await renderInspector(props)
    await act(async () => button('Manage in Assets').click())
    expect(props.onManage).toHaveBeenCalledTimes(1)
  })

  it('keeps Show off with the reason while four banners are showing', async () => {
    await renderInspector(
      inspectorProps({
        banner: banner('sponsor', { shown: false }),
        showLimitReason: BANNER_SHOWN_LIMIT_REASON
      })
    )
    expect(button('Show').disabled).toBe(true)
    expect(document.body.textContent).toContain(BANNER_SHOWN_LIMIT_REASON)
    // The cap never stops a showing banner from hiding.
    await renderInspector(inspectorProps({ showLimitReason: BANNER_SHOWN_LIMIT_REASON }))
    expect(button('Hide').disabled).toBe(false)
  })

  it('turns every control off with one reason while Videorc reconnects', async () => {
    await renderInspector(inspectorProps({ blockedReason: OFFLINE_LOCK_REASON }))
    expect(document.body.textContent?.split(OFFLINE_LOCK_REASON)).toHaveLength(2)
    expect(document.querySelector('[data-variant="locked"]')).not.toBeNull()
    for (const label of ['Hide', 'Top left', 'Full frame', 'Bring to front', 'Send to back'])
      expect(button(label).disabled, label).toBe(true)
    expect(switchFor('Stream').disabled).toBe(true)
    expect(switchFor('Recording').disabled).toBe(true)
    expect(button('Manage in Assets').disabled).toBe(false)
  })
})

type SectionProps = ComponentProps<typeof SceneBannersSection>

function sectionProps(overrides: Partial<SectionProps> = {}): SectionProps {
  return {
    banners: [banner('sponsor'), banner('logo', { shown: false, sortOrder: 1 })],
    loaded: true,
    offline: false,
    selectedId: null,
    showLimitReason: null,
    onSelect: vi.fn(),
    onShowChange: vi.fn(),
    onOpenAssets: vi.fn(),
    ...overrides
  }
}

async function renderSection(props: SectionProps): Promise<void> {
  await act(async () => root.render(createElement(SceneBannersSection, props)))
}

const row = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-videorc-scene-banner-row="${id}"]`)!

describe('SceneBannersSection', () => {
  it('lists every banner as a 32 px row: picture, name, Showing, Show or Hide', async () => {
    const props = sectionProps({ selectedId: 'logo' })
    await renderSection(props)
    expect(document.querySelector('[data-slot="grouped-list"]')).not.toBeNull()
    expect(row('sponsor').className).toContain('h-row')
    expect(row('sponsor').querySelector('[data-banner-thumbnail]')).not.toBeNull()
    expect(row('sponsor').querySelector('[data-videorc-in-use]')?.textContent).toBe('Showing')
    expect(row('logo').querySelector('[data-videorc-in-use]')).toBeNull()
    expect(row('logo').getAttribute('data-selected')).toBe('true')
    const hide = row('sponsor').querySelector<HTMLButtonElement>(
      'button[aria-label="Hide Sponsor"]'
    )!
    expect(hide.textContent).toBe('Hide')
    expect(hide.className).toContain('h-6')
    // Show or Hide is the row button's sibling, never inside it.
    expect(hide.closest('[data-slot="list-row-button"]')).toBeNull()
    await act(async () => hide.click())
    expect(props.onShowChange).toHaveBeenCalledWith(props.banners[0], false)
    expect(props.onSelect).not.toHaveBeenCalled()
    await act(async () =>
      row('logo').querySelector<HTMLButtonElement>('[data-slot="list-row-button"]')!.click()
    )
    expect(props.onSelect).toHaveBeenCalledWith('logo')
  })

  it('keeps Show off with the reason while four banners are showing', async () => {
    await renderSection(sectionProps({ showLimitReason: BANNER_SHOWN_LIMIT_REASON }))
    expect(
      row('logo').querySelector<HTMLButtonElement>('button[aria-label="Show Logo"]')!.disabled
    ).toBe(true)
    expect(
      row('sponsor').querySelector<HTMLButtonElement>('button[aria-label="Hide Sponsor"]')!.disabled
    ).toBe(false)
  })

  it('says "No banners yet." with Open Assets, only once the list is known', async () => {
    await renderSection(sectionProps({ banners: [], loaded: false }))
    expect(document.body.textContent).toContain('Loading banners…')
    expect(document.body.textContent).not.toContain('No banners yet.')

    const props = sectionProps({ banners: [] })
    await renderSection(props)
    expect(document.body.textContent).toContain('No banners yet.')
    await act(async () => button('Open Assets').click())
    expect(props.onOpenAssets).toHaveBeenCalledTimes(1)
  })

  it('offline: one alert, the rows stay, Show and Hide wait', async () => {
    await renderSection(sectionProps({ offline: true }))
    expect(document.body.textContent?.split(OFFLINE_LOCK_REASON)).toHaveLength(2)
    expect(
      row('sponsor').querySelector<HTMLButtonElement>('button[aria-label="Hide Sponsor"]')!.disabled
    ).toBe(true)

    await renderSection(sectionProps({ offline: true, banners: [], loaded: false }))
    expect(document.body.textContent).not.toContain('Loading banners…')
    expect(document.body.textContent).not.toContain('No banners yet.')

    // The inspector above already leads with the lock: the pane says it once.
    await renderSection(sectionProps({ offline: true, offlineAlert: false }))
    expect(document.body.textContent).not.toContain(OFFLINE_LOCK_REASON)
    expect(
      row('sponsor').querySelector<HTMLButtonElement>('button[aria-label="Hide Sponsor"]')!.disabled
    ).toBe(true)
  })
})
