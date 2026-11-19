import { describe, expect, it } from 'vitest'

import { notificationBellName, notificationCountLabel } from '@/lib/notification-count'

describe('the bell (plan 250, "Where the bell lives")', () => {
  it('shows no number at zero and "9+" above nine', () => {
    expect(notificationCountLabel(0)).toBeUndefined()
    expect(notificationCountLabel(2)).toBe('2')
    expect(notificationCountLabel(9)).toBe('9')
    expect(notificationCountLabel(10)).toBe('9+')
  })

  it('is named for a screen reader with what waits and what is wrong', () => {
    expect(notificationBellName({ unread: 0, urgent: 0, tone: null })).toBe('Notifications')
    expect(notificationBellName({ unread: 2, urgent: 1, tone: 'urgent' })).toBe(
      'Notifications, 2 unread, 1 urgent'
    )
    expect(notificationBellName({ unread: 0, urgent: 0, tone: 'warning' })).toBe(
      'Notifications, a warning is open'
    )
  })
})
