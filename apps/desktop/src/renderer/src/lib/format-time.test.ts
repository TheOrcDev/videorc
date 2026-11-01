import { describe, expect, it } from 'vitest'

import { formatRelativeTime, formatShortDate, formatTimecode } from './format-time'

// Plan 174 S1.4 (E-20): four time formats became one; relative times roll
// over to days and dates instead of "2207h 25m".

describe('formatTimecode', () => {
  it('says m:ss under an hour and h:mm:ss from one', () => {
    expect(formatTimecode(0)).toBe('0:00')
    expect(formatTimecode(5_000)).toBe('0:05')
    expect(formatTimecode(125_000)).toBe('2:05')
    expect(formatTimecode(59 * 60_000 + 59_000)).toBe('59:59')
    expect(formatTimecode(3_600_000)).toBe('1:00:00')
    expect(formatTimecode(3_725_000)).toBe('1:02:05')
    expect(formatTimecode(26 * 3_600_000 + 5_000)).toBe('26:00:05')
  })

  it('drops partial seconds instead of rounding up', () => {
    expect(formatTimecode(125_999)).toBe('2:05')
  })

  it('reads negative, NaN and infinite times as zero', () => {
    expect(formatTimecode(-5_000)).toBe('0:00')
    expect(formatTimecode(Number.NaN)).toBe('0:00')
    expect(formatTimecode(Number.POSITIVE_INFINITY)).toBe('0:00')
  })

  it('shows hours under an hour when asked, to line up with a long duration', () => {
    expect(formatTimecode(125_000, { withHours: true })).toBe('0:02:05')
    expect(formatTimecode(0, { withHours: true })).toBe('0:00:00')
  })

  it('never pads the leading unit', () => {
    expect(formatTimecode(125_000)).not.toMatch(/^0\d/)
    expect(formatTimecode(3_725_000)).not.toMatch(/^0\d/)
  })
})

describe('formatRelativeTime', () => {
  const NOW = Date.parse('2026-10-11T12:00:00.000Z')
  const ago = (ms: number): string => new Date(NOW - ms).toISOString()

  it('reads a fresh moment as now', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('now')
    expect(formatRelativeTime(ago(44_000), NOW)).toBe('now')
    // A clock a little ahead never reads as a negative age.
    expect(formatRelativeTime(new Date(NOW + 5_000).toISOString(), NOW)).toBe('now')
  })

  it('counts minutes, then hours, then days', () => {
    expect(formatRelativeTime(ago(50_000), NOW)).toBe('1m')
    expect(formatRelativeTime(ago(4 * 60_000), NOW)).toBe('4m')
    expect(formatRelativeTime(ago(59 * 60_000 + 59_000), NOW)).toBe('59m')
    expect(formatRelativeTime(ago(60 * 60_000), NOW)).toBe('1h')
    expect(formatRelativeTime(ago(2 * 3_600_000 + 25 * 60_000), NOW)).toBe('2h')
    expect(formatRelativeTime(ago(24 * 3_600_000), NOW)).toBe('1d')
    expect(formatRelativeTime(ago(6 * 24 * 3_600_000), NOW)).toBe('6d')
  })

  it('rolls over to a date after a week, never "2207h 25m"', () => {
    const old = ago(2207 * 3_600_000 + 25 * 60_000)
    const text = formatRelativeTime(old, NOW)
    expect(text).toBe(formatShortDate(Date.parse(old), NOW))
    expect(text).not.toMatch(/\dh/)
  })

  it('is empty for an unreadable time', () => {
    expect(formatRelativeTime('not a date', NOW)).toBe('')
    expect(formatRelativeTime(ago(0), Number.NaN)).toBe('')
  })
})

describe('formatShortDate', () => {
  const NOW = Date.parse('2026-10-11T12:00:00.000Z')

  it('adds the year only outside the current one', () => {
    const thisYear = formatShortDate(Date.parse('2026-08-02T12:00:00.000Z'), NOW)
    const lastYear = formatShortDate(Date.parse('2025-08-02T12:00:00.000Z'), NOW)
    expect(thisYear).not.toContain('2026')
    expect(lastYear).toContain('2025')
  })
})
