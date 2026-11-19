import { describe, expect, it } from 'vitest'

import { kindTone, NOTIFICATION_KINDS, urgentKinds } from '@/lib/notifications/kinds'

describe('the notification registry (plan 250)', () => {
  // Urgent means viewers or the recording are affected right now, and it is
  // the only tone that interrupts a livestream. A new urgent kind is a
  // decision: add it here on purpose.
  it('the urgent list is short, and written down', () => {
    expect(urgentKinds().sort()).toEqual(
      [
        'audio-output-failed',
        'recording-failed',
        'recording-output-failed',
        'stream-output',
        'stream-output-failed'
      ].sort()
    )
  })

  it('only these kinds may become urgent from a report', () => {
    const mayBecomeUrgent = Object.entries(NOTIFICATION_KINDS)
      .filter(([, kind]) => kind.mayBe?.includes('urgent'))
      .map(([id]) => id)
      .sort()
    expect(mayBecomeUrgent).toEqual(
      ['backend', 'microphone', 'screen-capture', 'stream-target', 'watchdog', 'x-playback'].sort()
    )
  })

  it('a report takes the kind tone unless the kind allows the one it asks for', () => {
    expect(kindTone({ tone: 'warning', life: 'condition' }, undefined)).toBe('warning')
    expect(kindTone({ tone: 'warning', life: 'condition' }, 'urgent')).toBe('warning')
    expect(kindTone({ tone: 'warning', life: 'condition', mayBe: ['urgent'] }, 'urgent')).toBe(
      'urgent'
    )
  })
})
