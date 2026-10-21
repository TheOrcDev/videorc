// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BannerSummary } from '../../../../shared/banner-commands'
import { StreamManagerStatusBar } from './stream-manager-status-bar'

// Plan 186 S7: the Banners menu beside Mark clip, on air or not, and its
// mirror in the narrow ⋯ menu.

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

async function render(
  banners: readonly BannerSummary[] | null,
  onBanner: ((action: unknown) => void) | null = vi.fn()
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(StreamManagerStatusBar, {
        providers: [],
        audience: null,
        alwaysOnTop: false,
        banners,
        onBanner: onBanner ?? undefined
      })
    )
  )
}

async function open(label: string): Promise<HTMLElement> {
  const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
  expect(trigger, label).not.toBeNull()
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  const menu = document.querySelector<HTMLElement>('[role=menu]')
  expect(menu).not.toBeNull()
  return menu!
}

const rows = (menu: HTMLElement) =>
  [...menu.querySelectorAll<HTMLElement>('[role=menuitemcheckbox], [role=menuitem]')].map(
    (row) => ({
      text: row.textContent,
      checked: row.getAttribute('aria-checked'),
      disabled: row.hasAttribute('data-disabled')
    })
  )

describe('StreamManagerStatusBar Banners', () => {
  it('checks each banner that shows and hides them all from one menu', async () => {
    const onBanner = vi.fn()
    await render(
      [
        { id: 'sponsor', name: 'Sponsor', shown: true },
        { id: 'follow', name: 'Follow me', shown: false }
      ],
      onBanner
    )
    const menu = await open('Banners')
    expect(rows(menu)).toEqual([
      { text: 'Sponsor', checked: 'true', disabled: false },
      { text: 'Follow me', checked: 'false', disabled: false },
      { text: 'Hide all banners', checked: null, disabled: false }
    ])
    await act(async () => menu.querySelectorAll<HTMLElement>('[role=menuitemcheckbox]')[1].click())
    expect(onBanner).toHaveBeenLastCalledWith({ action: 'show', id: 'follow' })
    await act(async () => menu.querySelectorAll<HTMLElement>('[role=menuitemcheckbox]')[0].click())
    expect(onBanner).toHaveBeenLastCalledWith({ action: 'hide', id: 'sponsor' })
    // The menu stays open for the next choice; the checks follow the list.
    expect(document.querySelector('[role=menu]')).not.toBeNull()
    await act(async () =>
      [...menu.querySelectorAll<HTMLElement>('[role=menuitem]')]
        .find((row) => row.textContent === 'Hide all banners')!
        .click()
    )
    expect(onBanner).toHaveBeenLastCalledWith({ action: 'hideAll' })
  })

  it('says how to get banners, or that they are loading, and turns Hide all off with none showing', async () => {
    await render([])
    expect(rows(await open('Banners'))).toEqual([
      { text: 'Import banners in Assets', checked: null, disabled: true }
    ])
    await act(async () => root.unmount())
    root = createRoot(container)
    await render(null)
    expect(rows(await open('Banners'))).toEqual([
      { text: 'Loading banners…', checked: null, disabled: true }
    ])
    await act(async () => root.unmount())
    root = createRoot(container)
    await render([{ id: 'sponsor', name: 'Sponsor', shown: false }])
    expect(rows(await open('Banners')).at(-1)).toEqual({
      text: 'Hide all banners',
      checked: null,
      disabled: true
    })
  })

  it('mirrors the menu in the narrow ⋯ menu, and leaves both out without a relay', async () => {
    await render([{ id: 'sponsor', name: 'Sponsor', shown: true }])
    const more = await open('More Stream Manager actions')
    expect([...more.querySelectorAll('[role=menuitem]')].map((row) => row.textContent)).toContain(
      'Banners'
    )
    await act(async () => root.unmount())
    root = createRoot(container)
    await render([{ id: 'sponsor', name: 'Sponsor', shown: true }], null)
    expect(container.querySelector('[aria-label="Banners"]')).toBeNull()
  })
})
