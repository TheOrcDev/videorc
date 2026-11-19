// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NotificationBell,
  type NotificationBellListProps
} from '@/components/notifications/notification-bell'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  notificationsOpen,
  toggleNotifications,
  type NotificationBellCount
} from '@/lib/notification-count'
import { WORKSPACE_NAVIGATE_EVENT } from '@/lib/workspace-navigation'

const toastUserError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/user-error', () => ({ toastUserError }))

describe('NotificationBell (plan 250, "Where the bell lives")', () => {
  let root: Root
  let container: HTMLDivElement
  const listProps = vi.fn()
  const load = vi.fn(async () => ({
    default: (props: NotificationBellListProps) => {
      listProps(props)
      return props.open ? createElement('div', { 'data-test-list': '' }, 'the list') : null
    }
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
    listProps.mockClear()
    toastUserError.mockClear()
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

  it('says the same words twice in a row again: a new node per announcement', async () => {
    const status = (): Element | null | undefined =>
      container.querySelector('[role="status"]')?.firstElementChild
    await render(
      { unread: 1, urgent: 0, tone: null },
      { text: 'Clip saved', urgent: false, sequence: 1 }
    )
    const first = status()
    expect(first?.textContent).toBe('Clip saved')
    await render(
      { unread: 2, urgent: 0, tone: null },
      { text: 'Clip saved', urgent: false, sequence: 2 }
    )
    // A live region speaks when its content changes; the same text in the
    // same node would be silent.
    expect(status()?.textContent).toBe('Clip saved')
    expect(status() === first).toBe(false)
  })

  // The status bar sits outside the page's error boundary: a list chunk that
  // threw while rendering took the whole window to the error panel.
  it('a list that fails to load closes, says so, and loads on the next press', async () => {
    await render({ unread: 0, urgent: 0, tone: null })
    load.mockRejectedValueOnce(new Error('chunk load failed'))
    await act(async () => bell().click())
    await vi.waitFor(() => expect(toastUserError).toHaveBeenCalledTimes(1))
    expect(toastUserError.mock.calls[0][1]).toEqual({ action: 'open', object: 'Notifications' })
    expect(notificationsOpen()).toBe(false)
    expect(bell().getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-test-list]')).toBeNull()
    // The bell is still there, and the next press tries again.
    await act(async () => bell().click())
    await vi.waitFor(() => expect(document.querySelector('[data-test-list]')).not.toBeNull())
    expect(toastUserError).toHaveBeenCalledTimes(1)
  })

  it("opens from its shortcut's event, loads the list then, and closes on a page change", async () => {
    await render({ unread: 0, urgent: 0, tone: null })
    await act(async () => toggleNotifications())
    expect(notificationsOpen()).toBe(true)
    expect(load).toHaveBeenCalled()
    await vi.waitFor(() => expect(document.querySelector('[data-test-list]')).not.toBeNull())
    // The list positions against the bell's own button, and returns focus to it.
    // (Compared by identity: a deep match would walk the whole DOM.)
    const props = listProps.mock.lastCall?.[0] as NotificationBellListProps
    expect(props.open).toBe(true)
    expect(props.trigger === bell()).toBe(true)
    expect(bell().getAttribute('aria-expanded')).toBe('true')
    await act(async () => {
      window.dispatchEvent(new CustomEvent(WORKSPACE_NAVIGATE_EVENT, { detail: { tab: 'studio' } }))
    })
    expect(notificationsOpen()).toBe(false)
    await act(async () => toggleNotifications('open'))
    expect(notificationsOpen()).toBe(true)
    await act(async () => toggleNotifications())
    expect(notificationsOpen()).toBe(false)
    expect(bell().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens and closes on a press, with no popover code until then', async () => {
    await render({ unread: 0, urgent: 0, tone: null })
    expect(bell().getAttribute('aria-haspopup')).toBe('dialog')
    expect(listProps).not.toHaveBeenCalled()
    await act(async () => bell().click())
    expect(notificationsOpen()).toBe(true)
    await vi.waitFor(() => expect(document.querySelector('[data-test-list]')).not.toBeNull())
    await act(async () => bell().click())
    expect(notificationsOpen()).toBe(false)
    expect(document.querySelector('[data-test-list]')).toBeNull()
  })

  // The bell is in every window's first paint: Base UI's popover (12 KB
  // gzip) must stay in the list's chunk. Measured 2026-11-19 against the
  // re-baselined eager budget.
  it('imports no popover', () => {
    const source = readFileSync(join(__dirname, 'notification-bell.tsx'), 'utf8')
    expect(source).not.toMatch(/from '@\/components\/ui\/popover'/)
    expect(source).not.toMatch(/@base-ui/)
    // Nor a mounted lazy() child: its failed load throws while rendering.
    expect(source).not.toMatch(/import \{[^}]*\blazy\b[^}]*\} from 'react'/)
  })
})
