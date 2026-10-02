import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  message: vi.fn()
}))
vi.mock('@/lib/toast', () => ({ toast }))

import {
  NOTIFY_ONCE_WINDOW_MS,
  notifyOnce,
  notifyOnceId,
  resetNotifyOnceForTests
} from '@/lib/notify-once'

describe('notifyOnce (plan 094, S3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetNotifyOnceForTests()
  })

  it('reuses one id for the same key inside the window and a new one after it', () => {
    const state = new Map()
    const first = notifyOnceId('oauth:youtube', 1_000, state)
    expect(notifyOnceId('oauth:youtube', 1_000 + NOTIFY_ONCE_WINDOW_MS - 1, state)).toBe(first)
    // Each repeat extends the window, so a producer firing every few seconds
    // stays one toast for as long as it fires.
    expect(notifyOnceId('oauth:youtube', 1_000 + 2 * NOTIFY_ONCE_WINDOW_MS - 2, state)).toBe(first)
    const later = notifyOnceId('oauth:youtube', 1_000 + 3 * NOTIFY_ONCE_WINDOW_MS + 5, state)
    expect(later).not.toBe(first)
    expect(notifyOnceId('other', 1_000, state)).not.toBe(first)
  })

  it('shows the toast with the keyed id so repeats update in place', () => {
    const id = notifyOnce('stream:twitch', 'error', 'Streaming to Twitch stopped', {
      description: 'Reconnecting.'
    })
    const again = notifyOnce('stream:twitch', 'error', 'Streaming to Twitch stopped', {
      description: 'Still reconnecting.'
    })
    expect(again).toBe(id)
    expect(toast.error).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenLastCalledWith('Streaming to Twitch stopped', {
      description: 'Still reconnecting.',
      id
    })
    notifyOnce('k', 'warning', 'w')
    notifyOnce('k2', 'success', 's')
    notifyOnce('k3', 'info', 'i')
    notifyOnce('k4', 'message', 'm')
    expect(toast.warning).toHaveBeenCalledOnce()
    expect(toast.success).toHaveBeenCalledOnce()
    expect(toast.info).toHaveBeenCalledOnce()
    expect(toast.message).toHaveBeenCalledOnce()
  })
})
