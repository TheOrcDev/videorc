// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationBell } from '@/components/notifications/notification-bell'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  notificationsOpen,
  toggleNotifications,
  type NotificationBellCount
} from '@/lib/notification-count'
import { WORKSPACE_NAVIGATE_EVENT } from '@/lib/workspace-navigation'

describe('NotificationBell (plan 250, "Where the bell lives")', () => {
  let root: Root
  let container: HTMLDivElement
  const load = vi.fn(async () => ({
    default: () => createElement('div', { 'data-test-list': '' }, 'the list')
  }))

  const bell = (): HTMLElement =>
    container.querySelector<HTMLElement>('[data-videorc-notification-bell]')!
  const render = async (
    count: NotificationBellCount,
    announcement: { text: string; urgent: boolean; sequence: number } | null = null
  ): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(NotificationBell, {
            count,
            announcement,
            accelerator: 'CmdOrCtrl+Shift+B',
            platform: 'darwin',
            load
          })
        )
      )
    })
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    load.mockClear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it("nothing unread, nothing open: the icon alone, in the bar's own tier", async () => {
    await render({ unread: 0, urgent: 0, tone: null })
    expect(bell().getAttribute('aria-label')).toBe('Notifications')
    expect(bell().textContent).toBe('')
    expect(bell().dataset.videorcNotificationCount).toBe('0')
    expect(bell().querySelector('svg')?.getAttribute('class') ?? '').not.toMatch(
      /text-(live|warning)/
    )
    // The list's chunk is not asked for until intent.
    expect(load).not.toHaveBeenCalled()
  })

  it('unread: the number in primary text, never coloured', async () => {
    await render({ unread: 2, urgent: 0, tone: null })
    expect(bell().textContent).toBe('2')
    expect(bell().querySelector('span.tabular-nums')?.className).toContain('text-foreground')
    await render({ unread: 12, urgent: 0, tone: null })
    expect(bell().textContent).toBe('9+')
  })

  it('a warning open: the icon in the warning tone, with nothing unread too', async () => {
    await render({ unread: 0, urgent: 0, tone: 'warning' })
    expect(bell().querySelector('svg')?.getAttribute('class')).toContain('text-warning')
    expect(bell().dataset.videorcNotificationTone).toBe('warning')
  })

  it('an urgent problem open: the icon in the live tone, and the name says so', async () => {
    await render({ unread: 2, urgent: 1, tone: 'urgent' })
    expect(bell().querySelector('svg')?.getAttribute('class')).toContain('text-live')
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 unread, 1 urgent')
  })

  it('announces an urgent entry as an alert and the rest as a status', async () => {
    await render(
      { unread: 1, urgent: 1, tone: 'urgent' },
      { text: 'Your stream stopped', urgent: true, sequence: 1 }
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Your stream stopped')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('')
    await render(
      { unread: 1, urgent: 0, tone: null },
      { text: 'Recording saved', urgent: false, sequence: 2 }
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Recording saved')
  })

  it("opens from its shortcut's event, loads the list then, and closes on a page change", async () => {
    await render({ unread: 0, urgent: 0, tone: null })
    await act(async () => toggleNotifications())
    expect(notificationsOpen()).toBe(true)
    expect(load).toHaveBeenCalled()
    expect(document.querySelector('[data-videorc-notification-list]')).not.toBeNull()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(WORKSPACE_NAVIGATE_EVENT, { detail: { tab: 'studio' } }))
    })
    expect(notificationsOpen()).toBe(false)
    await act(async () => toggleNotifications('open'))
    expect(notificationsOpen()).toBe(true)
    await act(async () => toggleNotifications())
    expect(notificationsOpen()).toBe(false)
  })
})
