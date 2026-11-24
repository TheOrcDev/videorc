import { afterEach, describe, expect, it } from 'vitest'
import {
  formatLocal,
  localDayKey,
  localDayKeyAfter,
  localOffsetMinutes,
  setLocalOffsets,
  systemTimeZone
} from './local-time'

// Vancouver with tz 2026e: summer time from March 2026, then no change back.
const vancouver = () => ({
  timeZone: systemTimeZone(),
  spans: [
    { fromMs: Date.parse('2026-03-08T10:00:00Z'), offsetMinutes: -420 },
    { fromMs: Date.parse('2026-01-01T00:00:00Z'), offsetMinutes: -480 }
  ]
})

afterEach(() => setLocalOffsets(null))

describe('local time from the backend tz data', () => {
  it('reads the offset of the span an instant falls in, clamped at the edges', () => {
    setLocalOffsets(vancouver())
    expect(localOffsetMinutes(Date.parse('2026-02-01T00:00:00Z'))).toBe(-480)
    expect(localOffsetMinutes(Date.parse('2026-03-08T10:00:00Z'))).toBe(-420)
    expect(localOffsetMinutes(Date.parse('2026-12-15T18:00:00Z'))).toBe(-420)
    expect(localOffsetMinutes(Date.parse('2020-01-01T00:00:00Z'))).toBe(-480)
  })

  it('formats at that offset and keeps calendar days on the local clock', () => {
    setLocalOffsets(vancouver())
    const december = Date.parse('2026-12-15T18:00:00Z')
    expect(formatLocal(december, { hour: 'numeric', minute: '2-digit' }, 'en-US')).toMatch(
      /^11:00\sAM$/u
    )
    expect(formatLocal(december, { month: 'short', day: 'numeric' }, 'en-US')).toBe('Dec 15')
    expect(localDayKey(Date.parse('2026-12-16T06:30:00Z'))).toBe('2026-12-15')
    expect(localDayKeyAfter(Date.parse('2026-12-31T20:00:00Z'), 1)).toBe('2027-01-01')
    expect(formatLocal(Number.NaN, { hour: 'numeric' })).toBe('')
  })

  it('falls back to the system rules before the backend answers or for another zone', () => {
    const at = Date.parse('2026-12-15T18:00:00Z')
    expect(localOffsetMinutes(at)).toBe(-new Date(at).getTimezoneOffset())
    setLocalOffsets({ timeZone: 'Not/This_Zone', spans: [{ fromMs: 0, offsetMinutes: 600 }] })
    expect(localOffsetMinutes(at)).toBe(-new Date(at).getTimezoneOffset())
  })
})
