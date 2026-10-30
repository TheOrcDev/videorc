// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { StatItemModel } from '@/lib/stream-manager-stats'
import { SCREEN_HIDE_UNAVAILABLE } from '@/lib/studio-actions/privacy'
import type { ScreenPrivacyContext } from '../../../../shared/session-markers'
import { StatsBar } from './stats-bar'
import { StreamManagerStatusBar } from './stream-manager-status-bar'

// Plan 210 S8b (D9): the Stream Manager hides and shows the screen from its
// status bar (word and icon, folding into ⋯ below 640 px), and its stats bar
// says Screen hidden while it is.

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.dataset.platform = 'darwin'
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.platform
  vi.unstubAllGlobals()
})

async function renderBar(
  screen: ScreenPrivacyContext | undefined,
  /** null: no relay to Studio. */
  onScreenPrivacy: ((hidden: boolean) => unknown) | null = vi.fn()
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(TooltipProvider, {
        delayDuration: 0,
        children: createElement(StreamManagerStatusBar, {
          providers: [],
          audience: null,
          alwaysOnTop: false,
          screen,
          onScreenPrivacy: onScreenPrivacy ?? undefined
        })
      })
    )
  )
}

const inline = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(
    '[data-slot="stream-manager-actions"] [data-videorc-screen-privacy]'
  )

async function openMore(): Promise<HTMLElement> {
  const more = container.querySelector<HTMLButtonElement>(
    '[aria-label="More Stream Manager actions"]'
  )!
  await act(async () => {
    more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  })
  return document.querySelector<HTMLElement>('[role=menu]')!
}

describe('Stream Manager: Hide screen (plan 210 S8b)', () => {
  it('hides with a word and an icon, its key in the hint', async () => {
    const onScreenPrivacy = vi.fn()
    await renderBar({ hidden: false, accelerator: 'Control+Alt+H' }, onScreenPrivacy)
    const action = inline()!
    expect(action.getAttribute('aria-label')).toBe('Hide screen')
    expect(action.textContent).toBe('Hide screen')
    expect(action.querySelector('svg')).not.toBeNull()
    expect(action.getAttribute('aria-description')).toBe(
      'Cover your screen with a frosted picture on the recording and every stream (⌃⌥H)'
    )
    expect(action.hasAttribute('title')).toBe(false)
    await act(async () => action.click())
    expect(onScreenPrivacy).toHaveBeenCalledWith(true)
  })

  it('reads Show screen while hidden, and shows on a click', async () => {
    const onScreenPrivacy = vi.fn()
    await renderBar({ hidden: true }, onScreenPrivacy)
    const action = inline()!
    expect(action.textContent).toBe('Show screen')
    expect(action.getAttribute('aria-description')).toBe('Show your screen to viewers again')
    await act(async () => action.click())
    expect(onScreenPrivacy).toHaveBeenCalledWith(false)
  })

  it('folds into ⋯ with its key, first among the window’s actions', async () => {
    const onScreenPrivacy = vi.fn()
    await renderBar({ hidden: false, accelerator: 'Control+Alt+H' }, onScreenPrivacy)
    const menu = await openMore()
    const items = [
      ...menu.querySelectorAll<HTMLElement>('[role=menuitem], [role=menuitemcheckbox]')
    ]
    const item = items.find((row) => row.textContent?.startsWith('Hide screen'))!
    expect(item.textContent).toBe('Hide screen⌃⌥H')
    expect(items.indexOf(item)).toBe(0)
    await act(async () => item.click())
    expect(onScreenPrivacy).toHaveBeenCalledWith(true)
  })

  it('is disabled with the legacy recording’s reason, inline and in ⋯', async () => {
    const onScreenPrivacy = vi.fn()
    await renderBar({ hidden: false, unavailable: SCREEN_HIDE_UNAVAILABLE }, onScreenPrivacy)
    const action = inline()!
    expect(action.disabled).toBe(true)
    const wrapper = action.closest<HTMLElement>('[data-slot="disabled-reason"]')!
    expect(
      document.getElementById(wrapper.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe(SCREEN_HIDE_UNAVAILABLE)
    const menu = await openMore()
    const item = [...menu.querySelectorAll<HTMLElement>('[role=menuitem]')].find((row) =>
      row.textContent?.startsWith('Hide screen')
    )!
    expect(item.hasAttribute('data-disabled')).toBe(true)
    expect(document.getElementById(item.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      SCREEN_HIDE_UNAVAILABLE
    )
  })

  it('stays away until Studio has said, or with no relay', async () => {
    await renderBar(undefined)
    expect(inline()).toBeNull()
    await renderBar({ hidden: false }, null)
    expect(inline()).toBeNull()
  })
})

describe('Stream Manager stats bar: Screen hidden (plan 210 S8b)', () => {
  it('closes the bar with the chip while hidden, after every stat', async () => {
    const items: StatItemModel[] = [
      {
        id: 'session',
        label: 'Clock',
        description: 'On air for 12:04',
        value: '12:04',
        tone: 'neutral',
        badge: 'live',
        details: []
      }
    ]
    await act(async () => root.render(createElement(StatsBar, { items, screenHidden: true })))
    const bar = container.querySelector<HTMLElement>('[data-slot="stats-bar"]')!
    const chip = bar.querySelector<HTMLElement>('[data-slot="stats-screen-hidden"]')!
    expect(chip.textContent).toBe('Screen hidden')
    expect(bar.lastElementChild).toBe(chip)
    expect(chip.querySelector('[data-slot="status-badge"]')?.getAttribute('data-tone')).toBe('warn')
    // Not a stat: the probe's stat rules and the layout menu never see it.
    expect(chip.closest('[data-stat]')).toBeNull()
    await act(async () => root.render(createElement(StatsBar, { items, screenHidden: false })))
    expect(container.querySelector('[data-slot="stats-screen-hidden"]')).toBeNull()
  })
})
