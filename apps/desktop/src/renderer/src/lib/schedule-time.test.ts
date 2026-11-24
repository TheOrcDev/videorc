import { describe, expect, it } from 'vitest'

import {
  formatGmtOffset,
  formatScheduledStart,
  offsetTimeZone,
  timeZoneLabel,
  wallTimeAt
} from './schedule-time'

// Plan 174 S3.5b (D-31): zones and times as people read them. The offsets
// come from the backend's tz data; Electron's ICU still has Vancouver on
// daylight saving time, so nothing here reads a zone's rules.

describe('schedule time', () => {
  it('labels a zone by its city and the offset the backend gave it', () => {
    expect(timeZoneLabel('Europe/Madrid', 120)).toBe('Madrid (GMT+2)')
    expect(timeZoneLabel('America/Vancouver', -420)).toBe('Vancouver (GMT-7)')
    expect(timeZoneLabel('America/New_York', -300)).toBe('New York (GMT-5)')
    expect(timeZoneLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires')
    expect(timeZoneLabel('UTC')).toBe('UTC')
    expect(formatGmtOffset(330)).toBe('GMT+5:30')
  })

  it('turns an offset into a fixed zone and a wall time', () => {
    expect(offsetTimeZone(-420)).toBe('-07:00')
    expect(offsetTimeZone(330)).toBe('+05:30')
    expect(offsetTimeZone(0)).toBe('+00:00')
    expect(wallTimeAt(Date.parse('2026-12-15T17:00:00Z'), -420)).toBe('2026-12-15T10:00')
  })

  it('says the start with its weekday and offset, and the year only when it differs', () => {
    const now = Date.parse('2026-10-11T12:00:00Z')
    const start = formatScheduledStart('2026-10-12T19:00:00Z', 120, {
      locale: 'en-US',
      nowMs: now
    })
    expect(start).toMatch(/^Mon, Oct 12, 9:00\s?PM GMT\+2$/)
    expect(
      formatScheduledStart('2027-01-02T19:00:00Z', 60, { locale: 'en-US', nowMs: now })
    ).toContain('2027')
    // Vancouver after tz 2026b: 10:00 is 17:00Z, shown as typed.
    expect(
      formatScheduledStart('2026-12-15T17:00:00Z', -420, { locale: 'en-US', nowMs: now })
    ).toMatch(/^Tue, Dec 15, 10:00\s?AM GMT-7$/)
  })
})
