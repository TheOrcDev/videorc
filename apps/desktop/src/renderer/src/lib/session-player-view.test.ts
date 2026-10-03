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
  playerKeyAction,
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
  it('reads mm:ss under an hour and h:mm:ss from an hour on', () => {
    expect(mediaTimeHasHours(3_599_999)).toBe(false)
    expect(mediaTimeHasHours(3_600_000)).toBe(true)
    expect(mediaTimeHasHours(Number.NaN)).toBe(false)
    expect(formatMediaTime(0, false)).toBe('00:00')
    expect(formatMediaTime(754_900, false)).toBe('12:34')
    expect(formatMediaTime(3_599_999, false)).toBe('59:59')
    // Without hours a long position keeps counting minutes.
    expect(formatMediaTime(3_660_000, false)).toBe('61:00')
    expect(formatMediaTime(0, true)).toBe('0:00:00')
    expect(formatMediaTime(3_661_000, true)).toBe('1:01:01')
    expect(formatMediaTime(7_200_000 + 5_000, true)).toBe('2:00:05')
  })

  it('shows zero for anything that is not a time', () => {
    expect(formatMediaTime(-5_000, false)).toBe('00:00')
    expect(formatMediaTime(Number.NaN, true)).toBe('0:00:00')
    expect(formatMediaTime(Number.POSITIVE_INFINITY, false)).toBe('00:00')
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
    expect(mediaErrorCopy(2)).toBe('The recording could not be read.')
    expect(mediaErrorCopy(4)).toBe('This recording cannot be played here.')
    expect(mediaErrorCopy(undefined)).toBe('Playback failed.')
  })
})
