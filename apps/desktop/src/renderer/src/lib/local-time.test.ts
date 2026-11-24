import { afterEach, describe, expect, it } from 'vitest'
import {
  addLocalOffsets,
  formatLocal,
  localDayKey,
  localDayKeyAfter,
  localOffsetMinutes,
  localTimeRevision,
  setLocalOffsets,
  subscribeLocalTime,
  systemTimeZone
} from './local-time'

// Vancouver with tz 2026e: summer time from March 2026, then no change back.
const vancouver = () => ({
  timeZone: systemTimeZone(),
  fromMs: Date.parse('2026-01-01T00:00:00Z'),
  untilMs: Date.parse('2029-01-01T00:00:00Z'),
  spans: [
    { fromMs: Date.parse('2026-03-08T10:00:00Z'), offsetMinutes: -420 },
    { fromMs: Date.parse('2026-01-01T00:00:00Z'), offsetMinutes: -480 }
  ]
})

afterEach(() => setLocalOffsets(null))

describe('local time from the backend tz data', () => {
  it('reads the offset of the span an instant falls in', () => {
    setLocalOffsets(vancouver())
    expect(localOffsetMinutes(Date.parse('2026-02-01T00:00:00Z'))).toBe(-480)
    expect(localOffsetMinutes(Date.parse('2026-03-08T10:00:00Z'))).toBe(-420)
    expect(localOffsetMinutes(Date.parse('2026-12-15T18:00:00Z'))).toBe(-420)
  })

  it('never stretches a window into other years: an older summer reads its own window', () => {
    setLocalOffsets(vancouver())
    // 2020-07-01 07:30Z is 00:30 on July 1 at UTC-7, but 23:30 on June 30 at
    // the window's first (winter) offset. Uncovered, it reads the system rules.
    const summer2020 = Date.parse('2020-07-01T07:30:00Z')
    expect(localOffsetMinutes(summer2020)).toBe(-new Date(summer2020).getTimezoneOffset())
    addLocalOffsets({
      timeZone: systemTimeZone(),
      fromMs: Date.parse('2020-01-01T00:00:00Z'),
      untilMs: Date.parse('2021-01-01T00:00:00Z'),
      spans: [
        { fromMs: Date.parse('2020-01-01T00:00:00Z'), offsetMinutes: -480 },
        { fromMs: Date.parse('2020-03-08T10:00:00Z'), offsetMinutes: -420 },
        { fromMs: Date.parse('2020-11-01T09:00:00Z'), offsetMinutes: -480 }
      ]
    })
    expect(localOffsetMinutes(summer2020)).toBe(-420)
    expect(localDayKey(summer2020)).toBe('2020-07-01')
    // Another zone's window is not added to this one.
    addLocalOffsets({
      timeZone: 'Not/This_Zone',
      fromMs: 0,
      untilMs: Date.parse('2020-01-01T00:00:00Z'),
      spans: [{ fromMs: 0, offsetMinutes: 600 }]
    })
    expect(localOffsetMinutes(Date.parse('2010-07-01T00:00:00Z'))).toBe(
      -new Date(Date.parse('2010-07-01T00:00:00Z')).getTimezoneOffset()
    )
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
    setLocalOffsets({
      timeZone: 'Not/This_Zone',
      fromMs: 0,
      untilMs: Date.parse('2100-01-01T00:00:00Z'),
      spans: [{ fromMs: 0, offsetMinutes: 600 }]
    })
    expect(localOffsetMinutes(at)).toBe(-new Date(at).getTimezoneOffset())
  })

  it('tells subscribers each time the spans change, so time text re-renders', () => {
    const seen: number[] = []
    const unsubscribe = subscribeLocalTime(() => seen.push(localTimeRevision()))
    const before = localTimeRevision()
    setLocalOffsets(vancouver())
    setLocalOffsets(null)
    unsubscribe()
    setLocalOffsets(vancouver())
    expect(seen).toEqual([before + 1, before + 2])
  })
})
