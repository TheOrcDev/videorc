// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { notificationsOpen } from '@/lib/notification-count'
import { resetStreamManagerNotificationsForTests } from '@/lib/stream-manager-notifications'
import type {
  NotificationActRequest,
  NotificationsSnapshot
} from '../../../../shared/notifications-relay'

import { notificationsMenuLabel, StreamManagerStatusBar } from './stream-manager-status-bar'

// Plan 250 S8: the bell is the Stream Manager's last status bar control, and
// below 640 px it folds into the ⋯ menu as "Notifications (2)".

let root: Root
let container: HTMLDivElement
let onList: ((snapshot: NotificationsSnapshot | null) => void) | null = null
let acts: NotificationActRequest[] = []

const snapshot: NotificationsSnapshot = {
  entries: [
    {
      key: 'microphone',
      kind: 'microphone',
      tone: 'urgent',
      peakTone: 'urgent',
      life: 'condition',
      state: 'open',
      title: 'Microphone is silent',
      detail: 'No sound for 40 s.',
      openedAt: 1_000,
      updatedAt: 2_000,
      occurrences: 1,
      read: false,
      actions: [{ id: 'unmute', label: 'Unmute', kind: 'fix' }]
    },
    {
      key: 'saved',
      kind: 'recording-saved',
      tone: 'done',
      peakTone: 'done',
      life: 'event',
      state: 'happened',
      title: 'Recording saved',
      openedAt: 500,
      updatedAt: 500,
      occurrences: 1,
      read: false,
      actions: []
    }
  ],
  count: { unread: 2, urgent: 1, tone: 'urgent' }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // Base UI finishes closing the menu on an animation frame.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16)
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  acts = []
  resetStreamManagerNotificationsForTests()
  ;(window as unknown as { videorc: unknown }).videorc = {
    getNotifications: vi.fn(async () => null),
    onNotifications: vi.fn((callback: typeof onList) => {
      onList = callback
      return () => {
        onList = null
      }
    }),
    onNotificationPopUp: vi.fn(() => () => {}),
    notificationActFromCommentsWindow: vi.fn(async (request: NotificationActRequest) => {
      acts.push(request)
      return true
    })
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  resetStreamManagerNotificationsForTests()
  delete (window as unknown as { videorc?: unknown }).videorc
  vi.unstubAllGlobals()
})

const bell = (): HTMLElement =>
  container.querySelector<HTMLElement>('[data-videorc-notification-bell]')!

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(StreamManagerStatusBar, {
          providers: [],
          audience: null,
          alwaysOnTop: false,
          onOpenPreview: () => {}
        })
      )
    )
  )
}

describe("the Stream Manager's bell (plan 250 S8)", () => {
  it('says "Notifications (2)" in the ⋯ menu, and "9+" above nine', () => {
    expect(notificationsMenuLabel(0)).toBe('Notifications')
    expect(notificationsMenuLabel(2)).toBe('Notifications (2)')
    expect(notificationsMenuLabel(12)).toBe('Notifications (9+)')
  })

  it("is the bar's last control, with the main window's number and tone", async () => {
    await render()
    const actions = container.querySelector('[data-slot="stream-manager-actions"]')!
    // The bell's two live regions follow it; it is the last button.
    expect([...actions.querySelectorAll('button')].at(-1)).toBe(bell())
    expect(bell().dataset.videorcNotificationCount).toBe('0')
    await act(async () => onList?.(snapshot))
    expect(bell().dataset.videorcNotificationCount).toBe('2')
    expect(bell().dataset.videorcNotificationTone).toBe('urgent')
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 unread, 1 urgent')
    expect(bell().querySelector('svg')?.getAttribute('class')).toContain('text-live')
  })

  it('opens the same list from the bell, and sends a press back to the main window', async () => {
    await render()
    await act(async () => onList?.(snapshot))
    await act(async () => bell().click())
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-notification-key]')).toHaveLength(2)
    )
    expect(acts).toContainEqual({ type: 'list-open', open: true })
    const unmute = document.querySelector<HTMLElement>('[data-notification-action="unmute"]')!
    await act(async () => unmute.click())
    expect(acts).toContainEqual({
      type: 'run',
      key: 'microphone',
      actionId: 'unmute',
      door: false
    })
    // The quiet line and its switch are gone (the owner's rule made it
    // always true).
    expect(document.querySelector('[data-notification-quiet-line]')).toBeNull()
  })

  it('folds into the ⋯ menu, which opens the list', async () => {
    await render()
    await act(async () => onList?.(snapshot))
    const more = container.querySelector<HTMLButtonElement>(
      '[aria-label="More Stream Manager actions"]'
    )!
    await act(async () => more.click())
    await vi.waitFor(() => expect(document.querySelector('[role=menu]')).not.toBeNull())
    const item = document.querySelector<HTMLElement>(
      '[data-testid="stream-manager-notifications-menu-item"]'
    )!
    expect(item.textContent).toContain('Notifications (2)')
    await act(async () => item.click())
    await vi.waitFor(() => expect(notificationsOpen()).toBe(true))
  })

  it('opens and closes on its shortcut', async () => {
    await render()
    const press = (): void => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'B',
          metaKey: true,
          ctrlKey: true,
          shiftKey: true,
          bubbles: true
        })
      )
    }
    await act(async () => press())
    expect(notificationsOpen()).toBe(true)
    await act(async () => press())
    expect(notificationsOpen()).toBe(false)
  })
})
