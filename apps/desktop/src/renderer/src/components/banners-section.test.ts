// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceNavContext } from '@/components/workspace-nav'
import type { Banner } from '@/lib/backend'
import { BANNER_COUNT_LIMIT_REASON, BANNER_SHOWN_LIMIT_REASON } from '@/lib/banners'
import { OFFLINE_REASON } from '@/lib/user-error'

import { BANNERS_DESCRIPTION, BannersSection } from './banners-section'

// Plan 186 S5: Assets → Banners imports, renames, orders and deletes the
// streamer's own images. Show / Hide and Place on Scene are shortcuts.

const mocked = vi.hoisted(() => ({ banners: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioBanners: () => mocked.banners }))

const banner = (id: string, sortOrder: number, extra: Partial<Banner> = {}): Banner => ({
  id,
  name: id === 'sponsor' ? 'Sponsor' : id === 'logo' ? 'Logo' : id,
  imageFile: `${id}.png`,
  thumbnailFile: `${id}.thumb.png`,
  width: 2400,
  height: 400,
  hasAlpha: true,
  sortOrder,
  shown: false,
  horizontal: { x: 0.2, y: 0.8, w: 0.6, h: 0.1 },
  vertical: { x: 0.05, y: 0.8, w: 0.9, h: 0.06 },
  showOnStream: true,
  showInRecording: true,
  opacity: 1,
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  ...extra
})

const sponsor = banner('sponsor', 0)
const logo = banner('logo', 1)

let root: Root
let container: HTMLDivElement
const nav = {
  active: 'assets' as const,
  setActive: vi.fn(),
  activeStudioPanel: 'assets' as const,
  openStudioPanel: vi.fn(),
  closeStudioPanel: vi.fn(),
  openSettings: vi.fn(),
  openBuddy: vi.fn()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  nav.openStudioPanel.mockClear()
  mocked.banners = {
    banners: [sponsor, logo],
    bannersLoaded: true,
    bannersOffline: false,
    bannerImportPhase: 'idle',
    selectedBannerId: null,
    selectBanner: vi.fn(),
    importBanner: vi.fn(async () => undefined),
    updateBanner: vi.fn(async () => null),
    reorderBanners: vi.fn(async () => true),
    deleteBanner: vi.fn(async () => true),
    showBanner: vi.fn(async () => true),
    hideBanner: vi.fn(async () => true),
    toggleBanner: vi.fn(async () => true)
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(WorkspaceNavContext.Provider, { value: nav }, createElement(BannersSection))
    )
  )
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`)
const tile = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-videorc-banner-tile="${id}"]`)!
const trigger = (name: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`)!

async function openMenu(name: string): Promise<HTMLElement[]> {
  await act(async () =>
    trigger(name).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

async function closeMenu(): Promise<void> {
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  await act(async () =>
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
  expect(document.querySelector('[role="menu"]')).toBeNull()
}

/** A menu item's own words, without its keys. */
const itemLabel = (item: HTMLElement): string =>
  (item.textContent ?? '').replace(
    item.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent ?? '',
    ''
  )

async function choose(name: string, label: string): Promise<void> {
  const item = (await openMenu(name)).find((entry) => entry.textContent?.startsWith(label))
  expect(item, label).toBeTruthy()
  await act(async () => item!.click())
}

describe('BannersSection states', () => {
  it('says "Loading banners…" until the list is known, never "No banners yet"', async () => {
    mocked.banners = { ...mocked.banners, banners: [], bannersLoaded: false }
    await render()
    expect(document.body.textContent).toContain('Loading banners…')
    expect(document.body.textContent).not.toContain('No banners yet')
  })

  it('offline: one alert leads, import waits with the reason, nothing claims empty', async () => {
    mocked.banners = { ...mocked.banners, banners: [], bannersLoaded: false, bannersOffline: true }
    await render()
    expect(document.body.textContent).toContain('reconnecting')
    expect(document.body.textContent).not.toContain('Loading banners…')
    expect(document.body.textContent).not.toContain('No banners yet')
    expect(byTestId<HTMLButtonElement>('banner-import')?.disabled).toBe(true)
    expect(document.body.textContent).toContain(OFFLINE_REASON)
  })

  it('offline with a known list keeps the tiles but locks their menus', async () => {
    mocked.banners = { ...mocked.banners, bannersOffline: true }
    await render()
    expect(tile('sponsor')).not.toBeNull()
    expect(trigger('Sponsor').disabled).toBe(true)
    expect(tile('sponsor').getAttribute('draggable')).toBe('false')
  })

  it('empty: "No banners yet" with its own Import image… action', async () => {
    mocked.banners = { ...mocked.banners, banners: [] }
    await render()
    expect(document.body.textContent).toContain('No banners yet')
    await act(async () => byTestId('banner-import-empty')!.click())
    expect(mocked.banners.importBanner).toHaveBeenCalledTimes(1)
  })

  it('lists the banners with the sharp sizes, thumbnails and no file names', async () => {
    await render()
    expect(document.body.textContent).toContain(BANNERS_DESCRIPTION)
    expect(BANNERS_DESCRIPTION).toContain('Sharp sizes: wide banner 2400 × 400')
    expect(tile('sponsor').textContent).toContain('Sponsor')
    expect(tile('sponsor').querySelector('img')?.getAttribute('src')).toBe(
      'videorc-asset://banner/sponsor.thumb.png'
    )
    expect(tile('sponsor').querySelector('img')?.className).toContain('object-contain')
    expect(tile('sponsor').querySelector('[data-banner-thumbnail]')?.className).toContain(
      'repeating-conic-gradient'
    )
    expect(document.body.textContent).not.toContain('sponsor.png')
  })

  it('marks a showing banner with the one in-use look: the rim and a Showing chip', async () => {
    mocked.banners = { ...mocked.banners, banners: [{ ...sponsor, shown: true }, logo] }
    await render()
    const chips = document.querySelectorAll('[data-videorc-in-use]')
    expect(chips).toHaveLength(1)
    expect(chips[0]?.textContent).toBe('Showing')
    expect(tile('sponsor').contains(chips[0]!)).toBe(true)
    expect(tile('sponsor').className).toContain('ring-foreground/60')
    expect(tile('logo').className).not.toContain('ring-foreground/60')
  })
})

describe('BannersSection import', () => {
  it('imports from the section action, also while recording or live', async () => {
    await render()
    const button = byTestId<HTMLButtonElement>('banner-import')!
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('Import image…')
    await act(async () => button.click())
    expect(mocked.banners.importBanner).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['choosing', 'Choosing image…'],
    ['importing', 'Importing…']
  ])('waits while %s, with the spinner', async (phase, label) => {
    mocked.banners = { ...mocked.banners, bannerImportPhase: phase }
    await render()
    const button = byTestId<HTMLButtonElement>('banner-import')!
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe(label)
    expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull()
  })

  it('stops at 24 banners and says why', async () => {
    mocked.banners = {
      ...mocked.banners,
      banners: Array.from({ length: 24 }, (_, index) => banner(`b${index}`, index))
    }
    await render()
    expect(byTestId<HTMLButtonElement>('banner-import')?.disabled).toBe(true)
    expect(document.body.textContent).toContain(BANNER_COUNT_LIMIT_REASON)
  })
})

describe('BannersSection actions', () => {
  it('orders the menu: Show, Place on Scene, Rename…, moves, then Delete… last', async () => {
    await render()
    const rows = await openMenu('Sponsor')
    expect(rows.map(itemLabel)).toEqual([
      'Show',
      'Place on Scene',
      'Rename…',
      'Move earlier',
      'Move later',
      'Delete…'
    ])
    expect(rows.at(-1)?.getAttribute('data-variant')).toBe('destructive')
    expect(rows[3]?.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent).toMatch(
      /^(?:Alt\+←|⌥←)$/
    )
    // The first banner can't move earlier, and says why.
    expect(rows[3]?.getAttribute('data-disabled')).not.toBeNull()
    expect(document.body.textContent).toContain('This banner is already first.')
    expect(rows[4]?.getAttribute('data-disabled')).toBeNull()
  })

  it('shows and hides through one toggle, and refuses a fifth at the cap', async () => {
    await render()
    await choose('Sponsor', 'Show')
    expect(mocked.banners.toggleBanner).toHaveBeenCalledExactlyOnceWith('sponsor')

    mocked.banners = {
      ...mocked.banners,
      banners: [
        ...[0, 1, 2, 3].map((index) => banner(`on${index}`, index, { shown: true })),
        banner('off', 4)
      ]
    }
    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    const [show] = await openMenu('off')
    expect(show?.textContent).toBe('Show')
    expect(show?.getAttribute('data-disabled')).not.toBeNull()
    expect(document.body.textContent).toContain(BANNER_SHOWN_LIMIT_REASON)
    await closeMenu()
    const [hide] = await openMenu('on0')
    expect(hide?.textContent).toBe('Hide')
    expect(hide?.getAttribute('data-disabled')).toBeNull()
  })

  it('Place on Scene selects the banner and opens the Scene page', async () => {
    await render()
    await choose('Logo', 'Place on Scene')
    expect(mocked.banners.selectBanner).toHaveBeenCalledExactlyOnceWith('logo')
    expect(nav.openStudioPanel).toHaveBeenCalledExactlyOnceWith('layouts')
  })

  it('renames in place: Enter saves a changed name, Escape keeps the old one', async () => {
    await render()
    await choose('Sponsor', 'Rename…')
    let input = document.querySelector<HTMLInputElement>('input[aria-label="Rename Sponsor"]')!
    expect(input.maxLength).toBe(40)
    expect(document.activeElement).toBe(input)
    await act(async () => {
      input.value = 'ACME sponsor'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(mocked.banners.updateBanner).toHaveBeenCalledExactlyOnceWith('sponsor', {
      name: 'ACME sponsor'
    })
    expect(document.querySelector('input[aria-label="Rename Sponsor"]')).toBeNull()

    await choose('Sponsor', 'Rename…')
    input = document.querySelector<HTMLInputElement>('input[aria-label="Rename Sponsor"]')!
    await act(async () => {
      input.value = 'Discarded'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(mocked.banners.updateBanner).toHaveBeenCalledTimes(1)
    expect(document.querySelector('input[aria-label="Rename Sponsor"]')).toBeNull()
  })

  it('reorders from the keyboard: Alt+→ and Alt+← on a tile, never past an end', async () => {
    await render()
    await act(async () => {
      trigger('Sponsor').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true })
      )
    })
    expect(mocked.banners.reorderBanners).toHaveBeenLastCalledWith(['logo', 'sponsor'])
    await act(async () => {
      trigger('Logo').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true })
      )
    })
    expect(mocked.banners.reorderBanners).toHaveBeenLastCalledWith(['logo', 'sponsor'])
    await act(async () => {
      trigger('Sponsor').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true })
      )
    })
    expect(mocked.banners.reorderBanners).toHaveBeenCalledTimes(2)
    await choose('Sponsor', 'Move later')
    expect(mocked.banners.reorderBanners).toHaveBeenLastCalledWith(['logo', 'sponsor'])
  })
})

describe('BannersSection delete', () => {
  it('asks first, keeps the banner on Cancel and deletes on confirm', async () => {
    await render()
    await choose('Sponsor', 'Delete…')
    const dialog = byTestId('banner-delete-dialog')
    expect(dialog?.textContent).toContain('Delete banner?')
    expect(dialog?.textContent).toContain(
      "“Sponsor” and its image will be deleted. This can't be undone."
    )
    expect(byTestId('banner-delete-confirm')?.textContent).toBe('Delete banner')
    await act(async () => byTestId('banner-delete-cancel')!.click())
    expect(mocked.banners.deleteBanner).not.toHaveBeenCalled()
    expect(byTestId('banner-delete-dialog')).toBeNull()

    await choose('Sponsor', 'Delete…')
    await act(async () => byTestId('banner-delete-confirm')!.click())
    expect(mocked.banners.deleteBanner).toHaveBeenCalledExactlyOnceWith('sponsor')
    expect(byTestId('banner-delete-dialog')).toBeNull()
  })

  it('holds the question while the delete runs, then closes on a refusal too', async () => {
    let settle!: (deleted: boolean) => void
    mocked.banners.deleteBanner = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        })
    )
    mocked.banners = { ...mocked.banners, banners: [{ ...sponsor, shown: true }, logo] }
    await render()
    await choose('Sponsor', 'Delete…')
    await act(async () => byTestId('banner-delete-confirm')!.click())
    expect(byTestId('banner-delete-confirm')?.textContent).toBe('Deleting…')
    expect(byTestId<HTMLButtonElement>('banner-delete-cancel')?.disabled).toBe(true)
    // The backend refuses a showing banner during a session ("Hide this
    // banner before you delete it."); the hook toasts it, the tile stays.
    await act(async () => settle(false))
    expect(byTestId('banner-delete-dialog')).toBeNull()
    expect(tile('sponsor')).not.toBeNull()
  })
})
