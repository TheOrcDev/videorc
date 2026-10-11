import { describe, expect, it } from 'vitest'

import {
  PLAYER_SEEK_STEP_MS,
  SESSION_MEDIA_RENEW_LEAD_MS,
  SESSION_MEDIA_RENEW_MIN_DELAY_MS,
  clampSeekMs,
  formatMediaTime,
  grantRenewalDelayMs,
  mediaErrorCopy,
  mediaTimeHasHours,
  groupMarkerPins,
  markerPinLeft,
  markerSourceLabel,
  playerKeyAction,
  playerKeyTargetMs,
  playheadValueText,
  sessionMediaRefusalCopy
} from './session-player-view'

describe('grantRenewalDelayMs', () => {
  it('renews a minute before expiry, never sooner than the floor', () => {
    const now = 1_000_000
    expect(grantRenewalDelayMs(now + 600_000, now)).toBe(600_000 - SESSION_MEDIA_RENEW_LEAD_MS)
    expect(grantRenewalDelayMs(now + 30_000, now)).toBe(SESSION_MEDIA_RENEW_MIN_DELAY_MS)
    expect(grantRenewalDelayMs(now - 1, now)).toBe(SESSION_MEDIA_RENEW_MIN_DELAY_MS)
    expect(grantRenewalDelayMs(Number.NaN, now)).toBe(SESSION_MEDIA_RENEW_LEAD_MS)
  })
})

describe('formatMediaTime', () => {
  it('reads m:ss under an hour and h:mm:ss from an hour on (plan 174 S1.4)', () => {
    expect(mediaTimeHasHours(3_599_999)).toBe(false)
    expect(mediaTimeHasHours(3_600_000)).toBe(true)
    expect(mediaTimeHasHours(Number.NaN)).toBe(false)
    expect(formatMediaTime(0, false)).toBe('0:00')
    expect(formatMediaTime(125_000, false)).toBe('2:05')
    expect(formatMediaTime(754_900, false)).toBe('12:34')
    expect(formatMediaTime(3_599_999, false)).toBe('59:59')
    // Past an hour the hours appear even when not asked for.
    expect(formatMediaTime(3_660_000, false)).toBe('1:01:00')
    expect(formatMediaTime(0, true)).toBe('0:00:00')
    expect(formatMediaTime(3_661_000, true)).toBe('1:01:01')
    expect(formatMediaTime(7_200_000 + 5_000, true)).toBe('2:00:05')
  })

  it('shows zero for anything that is not a time', () => {
    expect(formatMediaTime(-5_000, false)).toBe('0:00')
    expect(formatMediaTime(Number.NaN, true)).toBe('0:00:00')
    expect(formatMediaTime(Number.POSITIVE_INFINITY, false)).toBe('0:00')
  })
})

describe('playheadValueText', () => {
  it('speaks the playhead as "2:05 of 41:10", never raw milliseconds (plan 174 S0.5)', () => {
    expect(playheadValueText(125_000, 2_470_000)).toBe('2:05 of 41:10')
    expect(playheadValueText(0, 2_470_000)).toBe('0:00 of 41:10')
    // From an hour on, both sides carry hours, as on screen.
    expect(playheadValueText(125_000, 3_661_000)).toBe('0:02:05 of 1:01:01')
    expect(playheadValueText(Number.NaN, 0)).toBe('0:00 of 0:00')
  })
})

describe('clampSeekMs', () => {
  it('keeps a seek inside the recording', () => {
    expect(clampSeekMs(-10, 1_000)).toBe(0)
    expect(clampSeekMs(500, 1_000)).toBe(500)
    expect(clampSeekMs(5_000, 1_000)).toBe(1_000)
    expect(clampSeekMs(5_000, Number.NaN)).toBe(5_000)
    expect(clampSeekMs(Number.NaN, 1_000)).toBe(0)
    expect(PLAYER_SEEK_STEP_MS).toBe(5_000)
  })
})

describe('playerKeyAction', () => {
  it('maps Space and the arrows, and defers to controls that own the key', () => {
    expect(playerKeyAction(' ', { tagName: 'DIV' })).toBe('toggle')
    expect(playerKeyAction(' ', null)).toBe('toggle')
    expect(playerKeyAction(' ', { tagName: 'BUTTON' })).toBeNull()
    expect(playerKeyAction('ArrowLeft', { tagName: 'DIV' })).toBe('seek-back')
    expect(playerKeyAction('ArrowRight', { tagName: 'BUTTON' })).toBe('seek-forward')
    expect(playerKeyAction('ArrowRight', { tagName: 'SPAN', role: 'slider' })).toBeNull()
    expect(playerKeyAction('ArrowLeft', { tagName: 'SPAN', role: 'slider' })).toBeNull()
    expect(playerKeyAction('Enter', { tagName: 'DIV' })).toBeNull()
    expect(playerKeyAction('f', { tagName: 'DIV' })).toBeNull()
  })

  // Plan 174 S3.12 (E-30): the video players' keys, only while the player has focus.
  it('answers J/K/L, Home/End and M, and never a key with a modifier', () => {
    expect(playerKeyAction('k', { tagName: 'DIV' })).toBe('toggle')
    expect(playerKeyAction('K', { tagName: 'BUTTON' })).toBe('toggle')
    expect(playerKeyAction('j', { tagName: 'DIV' })).toBe('jump-back')
    expect(playerKeyAction('l', { tagName: 'DIV' })).toBe('jump-forward')
    expect(playerKeyAction('m', { tagName: 'DIV' })).toBe('mute')
    expect(playerKeyAction('Home', { tagName: 'DIV' })).toBe('start')
    expect(playerKeyAction('End', { tagName: 'DIV' })).toBe('end')
    // The scrubber steps itself to either end.
    expect(playerKeyAction('Home', { tagName: 'SPAN', role: 'slider' })).toBeNull()
    expect(playerKeyAction('k', { tagName: 'DIV' }, { metaKey: true })).toBeNull()
    expect(playerKeyAction(' ', { tagName: 'DIV' }, { ctrlKey: true })).toBeNull()
    expect(playerKeyAction('m', { tagName: 'DIV' }, { altKey: true })).toBeNull()
  })

  it('sends the playhead 5 s with the arrows, 10 s with J and L, and to either end', () => {
    expect(playerKeyTargetMs('seek-back', 60_000, 120_000)).toBe(55_000)
    expect(playerKeyTargetMs('seek-forward', 60_000, 120_000)).toBe(65_000)
    expect(playerKeyTargetMs('jump-back', 60_000, 120_000)).toBe(50_000)
    expect(playerKeyTargetMs('jump-forward', 60_000, 120_000)).toBe(70_000)
    expect(playerKeyTargetMs('start', 60_000, 120_000)).toBe(0)
    expect(playerKeyTargetMs('end', 60_000, 120_000)).toBe(120_000)
    expect(playerKeyTargetMs('end', 60_000, 0)).toBeNull()
    expect(playerKeyTargetMs('toggle', 60_000, 120_000)).toBeNull()
  })
})

describe('marker pins (plan 174 S3.12, E-7)', () => {
  const marker = (id: string, atSeconds: number) => ({ id, atSeconds })

  it('puts a pin under the thumb centre at its time', () => {
    expect(markerPinLeft(0)).toBe('calc(0% + 8px)')
    expect(markerPinLeft(0.5)).toBe('calc(50% + 0px)')
    expect(markerPinLeft(1)).toBe('calc(100% + -8px)')
    expect(markerPinLeft(2)).toBe('calc(100% + -8px)')
    expect(markerPinLeft(Number.NaN)).toBe('calc(0% + 8px)')
  })

  it('shows nothing until the duration is known', () => {
    expect(groupMarkerPins([marker('a', 10)], 0, 500)).toEqual([])
    expect(groupMarkerPins([marker('a', 10)], Number.NaN, 500)).toEqual([])
  })

  it('merges pins closer than one 24 px hit area into one chooser, in time order', () => {
    // 116 px of usable track over 100 s: 1 s is 1.16 px.
    const groups = groupMarkerPins(
      [marker('late', 90), marker('a', 10), marker('b', 25), marker('c', 40)],
      100_000,
      132
    )
    expect(groups.map((group) => group.markers.map(({ id }) => id))).toEqual([
      ['a', 'b'],
      ['c'],
      ['late']
    ])
    expect(groups[0].key).toBe('a')
    expect(groups[0].fraction).toBeCloseTo(0.175)
    // Wide enough and every pin stands alone.
    expect(groupMarkerPins([marker('a', 10), marker('b', 25)], 100_000, 1016)).toHaveLength(2)
  })

  it('keeps a pin past the end on the end, never off the track', () => {
    expect(groupMarkerPins([marker('a', 500)], 100_000, 500)[0].fraction).toBe(1)
  })

  it('names how a marker was made in a word', () => {
    expect(markerSourceLabel('voice')).toBe('Voice')
    expect(markerSourceLabel('manual')).toBe('Typed')
  })
})

describe('copy', () => {
  it('names every refusal and every media error without em dashes', () => {
    for (const error of ['not-found', 'not-mp4', 'not-ready'] as const) {
      const copy = sessionMediaRefusalCopy(error)
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.description.length).toBeGreaterThan(0)
      expect(`${copy.title} ${copy.description}`).not.toMatch(/—/)
    }
    expect(sessionMediaRefusalCopy('not-ready').title).toBe('Still finalizing')
    expect(sessionMediaRefusalCopy('not-found').title).toBe('Recording file missing')
    expect(mediaErrorCopy(2)).toBe("The recording couldn't be read.")
    expect(mediaErrorCopy(4)).toBe("This recording can't play here.")
    expect(mediaErrorCopy(undefined)).toBe('Playback failed.')
  })
})
