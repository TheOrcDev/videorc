import { describe, expect, it, vi } from 'vitest'

// The owner, 2026-11-22: "it's very annoying, especially when you enter the
// app; the first thing you see is a bunch of toasts". The app's own store
// keeps its first minute quiet: this reads it before any test resets it.

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  })
}))

import { notifications } from '@/lib/notifications'
import { LAUNCH_QUIET_MS } from '@/lib/notifications/policy'
import { publishGlobalShortcutsProblem } from '@/lib/notifications/sources/app'
import { announceCloud } from '@/lib/notifications/sources/cloud'
import { publishHealthEvent } from '@/lib/notifications/sources/health'
import { publishSignInExpired } from '@/lib/notifications/sources/platforms'

describe("the app's notification store at launch", () => {
  it('lasts a minute', () => {
    expect(LAUNCH_QUIET_MS).toBe(60_000)
  })

  it('pops nothing up for what Videorc finds on its own, and counts it on the bell', () => {
    const door = { show: vi.fn(), resolved: vi.fn(), dismiss: vi.fn() }
    notifications.setPopUpDoor(door)
    const at = new Date().toISOString()
    publishHealthEvent(
      notifications,
      {
        id: 'h1',
        sessionId: 'ring',
        level: 'warn',
        code: 'host-overloaded',
        message: 'This computer is overloaded: a load of 20 on 10 cores.',
        createdAt: at
      },
      { recording: { state: 'recording', sessionId: 'ring' } }
    )
    publishGlobalShortcutsProblem({ title: "A global shortcut didn't register", description: 'x' })
    publishSignInExpired()
    announceCloud({ requestTyped: () => Promise.resolve({}) } as never, () => {})
    expect(door.show).not.toHaveBeenCalled()
    expect(notifications.count().unread).toBe(4)
  })
})
