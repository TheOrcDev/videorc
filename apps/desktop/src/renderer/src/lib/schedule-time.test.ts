import { describe, expect, it } from 'vitest'

import {
  formatGmtOffset,
  formatScheduledStart,
  localTimeOffsets,
  timeZoneLabel
} from './schedule-time'

// Plan 174 S3.5b (D-31): zones and times as people read them, and the
// repeated-hour choice only when the clocks go back over the chosen time.

describe('schedule time', () => {
  it('labels a zone by its city and the offset at that time', () => {
    expect(timeZoneLabel('Europe/Madrid', Date.parse('2026-07-01T12:00:00Z'))).toBe(
      'Madrid (GMT+2)'
    )
    expect(timeZoneLabel('Europe/Madrid', Date.parse('2026-01-01T12:00:00Z'))).toBe(
      'Madrid (GMT+1)'
    )
    expect(timeZoneLabel('America/New_York', Date.parse('2026-01-01T12:00:00Z'))).toBe(
      'New York (GMT-5)'
    )
    expect(timeZoneLabel('UTC')).toBe('UTC')
    expect(formatGmtOffset(330)).toBe('GMT+5:30')
  })

  it('finds two offsets only for a repeated time, and none for a skipped one', () => {
    // Madrid sets its clocks back from 3:00 to 2:00 on 25 October 2026.
    expect(localTimeOffsets('2026-10-25T02:30', 'Europe/Madrid')).toEqual([120, 60])
    expect(localTimeOffsets('2026-10-25T12:00', 'Europe/Madrid')).toEqual([60])
    // and forward from 2:00 to 3:00 on 29 March 2026.
    expect(localTimeOffsets('2026-03-29T02:30', 'Europe/Madrid')).toEqual([])
    expect(localTimeOffsets('not a time', 'Europe/Madrid')).toEqual([])
  })

  it('says the start with its weekday and zone, and the year only when it differs', () => {
    const now = Date.parse('2026-10-11T12:00:00Z')
    const start = formatScheduledStart('2026-10-12T19:00:00Z', 'Europe/Madrid', {
      locale: 'en-US',
      nowMs: now
    })
    expect(start).toMatch(/^Mon, Oct 12, 9:00\s?PM GMT\+2$/)
    expect(
      formatScheduledStart('2027-01-02T19:00:00Z', 'Europe/Madrid', { locale: 'en-US', nowMs: now })
    ).toContain('2027')
  })
})
