// @vitest-environment happy-dom
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/notifications/kinds', async (original) => {
  const actual = await original<typeof import('@/lib/notifications/kinds')>()
  return {
    ...actual,
    NOTIFICATION_KINDS: {
      problem: { tone: 'warning', life: 'condition', mayBe: ['urgent', 'news'] },
      news: { tone: 'news', life: 'event' },
      finished: { tone: 'done', life: 'event' },
      work: { tone: 'news', life: 'progress' }
    }
  }
})

const toastUserError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/user-error', () => ({ toastUserError }))

import { NotificationCenter } from '@/components/notifications/notification-center'
import type { NotificationKindId } from '@/lib/notifications/kinds'
import { createNotificationStore, type NotificationStore } from '@/lib/notifications/store'

const kind = (id: string): NotificationKindId => id as NotificationKindId

describe('NotificationCenter (plan 250, "The dropdown")', () => {
  let root: Root
  let container: HTMLDivElement
  let store: NotificationStore
  let onClose: ReturnType<typeof vi.fn>

  const rows = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-notification-key]'))
  const row = (key: string): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-notification-key="${key}"]`)!
  const press = async (target: HTMLElement, key: string): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }
  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(NotificationCenter, { source: store, onClose }))
    })
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.clearAllMocks()
    store = createNotificationStore()
    onClose = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('says so when there is nothing', async () => {
    await render()
    expect(container.querySelector('[data-notification-empty]')?.textContent).toBe(
      'No notificationsProblems and finished work show up here.'
    )
    expect(container.querySelector('[data-notification-clear-all]')).toBeNull()
  })

  it('draws one row per entry: tone on the icon, title, detail, at most two buttons, Clear', async () => {
    const unmute = vi.fn()
    store.publish({
      key: 'microphone',
      kind: kind('problem'),
      tone: 'urgent',
      title: 'Microphone is silent',
      detail: 'No sound for 40 s. Viewers hear nothing.',
      actions: [
        { id: 'unmute', label: 'Unmute', kind: 'fix', run: unmute },
        { id: 'audio', label: 'Open Audio', kind: 'door', run: () => {} }
      ]
    })
    store.publish({ key: 'overload', kind: kind('problem'), title: 'This computer is overloaded' })
    store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
    store.publish({ key: 'blip', kind: kind('news'), title: 'Microphone silenced for a moment' })
    store.publish({ key: 'mp4', kind: kind('work'), title: 'Exporting MP4' })
    await render()

    expect(rows().map((item) => item.dataset.notificationKey)).toEqual([
      'microphone',
      'overload',
      'mp4',
      'blip',
      'saved'
    ])
    const labels = Array.from(container.querySelectorAll('[data-slot="section-label"]'))
    expect(labels.map((label) => label.textContent)).toEqual(['Now', 'Earlier'])

    const mic = row('microphone')
    expect(mic.getAttribute('aria-label')).toBe('Urgent: Microphone is silent')
    expect(mic.dataset.notificationTone).toBe('urgent')
    expect(mic.querySelector('svg')?.getAttribute('class')).toContain('text-live')
    expect(mic.querySelector('[data-notification-detail]')?.textContent).toBe(
      'No sound for 40 s. Viewers hear nothing.'
    )
    const buttons = Array.from(mic.querySelectorAll<HTMLElement>('[data-notification-action]'))
    expect(buttons.map((button) => button.textContent)).toEqual(['Unmute', 'Open Audio'])
    expect(buttons[0].dataset.variant).toBe('default')
    expect(buttons[1].dataset.variant).toBe('ghost')
    expect(mic.querySelector('[data-notification-clear]')?.getAttribute('aria-label')).toBe(
      'Clear Microphone is silent'
    )
    expect(mic.hasAttribute('data-notification-unread')).toBe(true)

    expect(row('overload').querySelector('svg')?.getAttribute('class')).toContain('text-warning')
    expect(row('overload').querySelector('[data-notification-action]')).toBeNull()
    expect(row('saved').querySelector('svg')?.getAttribute('class')).toContain('text-success')
    // News never counts, so it carries no unread dot.
    expect(row('blip').hasAttribute('data-notification-unread')).toBe(false)
    expect(row('mp4').querySelector('[data-slot="spinner"]')).not.toBeNull()
  })

  it('draws no group label with only earlier entries', async () => {
    store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
    await render()
    expect(container.querySelector('[data-slot="section-label"]')).toBeNull()
  })

  it('is one tab stop: the arrows move between entries', async () => {
    store.publish({ key: 'a', kind: kind('problem'), title: 'A', tone: 'urgent' })
    store.publish({ key: 'b', kind: kind('problem'), title: 'B' })
    await render()
    expect(rows().map((item) => item.tabIndex)).toEqual([0, -1])
    await act(async () => row('a').focus())
    await press(row('a'), 'ArrowDown')
    expect(document.activeElement).toBe(row('b'))
    expect(rows().map((item) => item.tabIndex)).toEqual([-1, 0])
    await press(row('b'), 'ArrowUp')
    expect(document.activeElement).toBe(row('a'))
  })

  it('Enter runs the first action; a fix keeps the list open, a door closes it', async () => {
    const fix = vi.fn()
    const door = vi.fn()
    store.publish({
      key: 'a',
      kind: kind('problem'),
      title: 'A',
      actions: [{ id: 'fix', label: 'Unmute', kind: 'fix', run: fix }]
    })
    store.publish({
      key: 'b',
      kind: kind('problem'),
      title: 'B',
      actions: [{ id: 'door', label: 'Open Audio', kind: 'door', run: door }]
    })
    await render()
    await act(async () => row('a').focus())
    await press(row('a'), 'Enter')
    expect(fix).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => row('b').focus())
    await press(row('b'), 'Enter')
    expect(door).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a fix that fails says so with a toast: it answers the press', async () => {
    store.publish({
      key: 'a',
      kind: kind('problem'),
      title: 'A',
      actions: [
        {
          id: 'fix',
          label: 'Unmute',
          kind: 'fix',
          run: () => Promise.reject(new Error('no microphone'))
        }
      ]
    })
    await render()
    await act(async () => {
      row('a').querySelector<HTMLElement>('[data-notification-action]')!.click()
    })
    expect(toastUserError).toHaveBeenCalledWith(expect.any(Error), { action: 'unmute' })
  })

  it('Backspace clears the entry and keeps the keyboard in the list', async () => {
    store.publish({ key: 'a', kind: kind('finished'), title: 'A' })
    store.publish({ key: 'b', kind: kind('finished'), title: 'B' })
    await render()
    const first = rows()[0]
    await act(async () => first.focus())
    await press(first, 'Backspace')
    expect(rows()).toHaveLength(1)
    expect(document.activeElement).toBe(rows()[0])
  })

  it('Clear all removes what is no longer true and keeps open problems', async () => {
    store.publish({ key: 'open', kind: kind('problem'), title: 'Open' })
    store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
    await render()
    await act(async () => {
      container.querySelector<HTMLElement>('[data-notification-clear-all]')!.click()
    })
    expect(rows().map((item) => item.dataset.notificationKey)).toEqual(['open'])
    expect(container.querySelector('[data-notification-clear-all]')).toBeNull()
  })

  it('marks everything read when it closes, and nothing pops up while it is open', async () => {
    const door = { show: vi.fn(), resolved: vi.fn(), dismiss: vi.fn() }
    store.setPopUpDoor(door)
    store.publish({ key: 'a', kind: kind('problem'), title: 'A' })
    expect(door.show).toHaveBeenCalledTimes(1)
    await render()
    await act(async () => {
      store.publish({ key: 'b', kind: kind('problem'), title: 'B', tone: 'urgent' })
    })
    expect(door.show).toHaveBeenCalledTimes(1)
    expect(store.count().unread).toBe(2)
    await act(async () => root.render(null))
    // The close lands a turn later (see the StrictMode test below).
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(store.count()).toEqual({ unread: 0, urgent: 1, tone: 'urgent' })
  })

  // Seen by eye in the dev app: StrictMode runs an effect's cleanup at once
  // after its first mount, and the list marked itself read as it opened.
  it('opening the list under StrictMode leaves its entries unread until it closes', async () => {
    store.publish({ key: 'a', kind: kind('problem'), title: 'A' })
    store.publish({ key: 'saved', kind: kind('finished'), title: 'Recording saved' })
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(NotificationCenter, { source: store, onClose })
        )
      )
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(store.count().unread).toBe(2)
    expect(container.querySelectorAll('[data-notification-unread]')).toHaveLength(2)
    await act(async () => root.render(null))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(store.count().unread).toBe(0)
  })
})
