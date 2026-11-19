// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationPopover } from '@/components/notifications/notification-popover'

describe('NotificationPopover (plan 250)', () => {
  let root: Root
  let container: HTMLDivElement
  let trigger: HTMLButtonElement
  let onOpenChange: ReturnType<typeof vi.fn>

  const render = async (open: boolean): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(NotificationPopover, {
          open,
          onOpenChange,
          trigger,
          children: createElement('button', { type: 'button', 'data-inside': '' }, 'Clear all')
        })
      )
    })
  }
  const list = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-videorc-notification-list]')

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    onOpenChange = vi.fn()
    container = document.createElement('div')
    trigger = document.createElement('button')
    document.body.append(trigger, container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    trigger.remove()
    vi.unstubAllGlobals()
  })

  it('shows its list on the popup tier while open, and nothing while closed', async () => {
    await render(false)
    expect(list()).toBeNull()
    await render(true)
    expect(list()).not.toBeNull()
    expect(list()?.className).toContain('glass-float')
    // The popup is a dialog: it has a name, with entries or without.
    expect(list()?.getAttribute('aria-label')).toBe('Notifications')
    expect(list()?.querySelector('[data-inside]')).not.toBeNull()
  })

  it('closes on Escape', async () => {
    await render(true)
    await act(async () => {
      list()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes on a press outside, but leaves a press on the bell to the bell', async () => {
    await render(true)
    const press = async (target: HTMLElement): Promise<void> => {
      await act(async () => {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true }))
        }
      })
    }
    // The bell toggles itself: closing here too would let its click reopen the list.
    await press(trigger)
    expect(onOpenChange).not.toHaveBeenCalled()
    await press(document.body)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
