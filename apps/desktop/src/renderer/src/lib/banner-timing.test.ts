import { describe, expect, it } from 'vitest'

import {
  BANNER_HIDE_AFTER_CHOICES,
  BANNER_REPEAT_CHOICES,
  BANNER_REPEAT_DESCRIPTION,
  bannerMinutesLabel,
  bannerSecondsLabel,
  bannerTimingChoices,
  bannerTimingSummary
} from './banner-timing'

// Plan 186 S10: the banner timer's one line, said the same way in the Timing
// fold, the Scene row and the Assets tile.

describe('bannerTimingSummary', () => {
  it('says both timers as one cycle', () => {
    expect(bannerTimingSummary({ hideAfterSec: 30, repeatEveryMin: 15 })).toBe(
      'Shows for 30 s every 15 min'
    )
    expect(bannerTimingSummary({ hideAfterSec: 60, repeatEveryMin: 5 })).toBe(
      'Shows for 1 min every 5 min'
    )
    expect(bannerTimingSummary({ hideAfterSec: 300, repeatEveryMin: 30 })).toBe(
      'Shows for 5 min every 30 min'
    )
  })

  it('says a repeat alone', () => {
    expect(bannerTimingSummary({ repeatEveryMin: 15 })).toBe('Every 15 min')
    expect(bannerTimingSummary({ hideAfterSec: 0, repeatEveryMin: 10 })).toBe('Every 10 min')
  })

  it('says a hide-after alone', () => {
    expect(bannerTimingSummary({ hideAfterSec: 30 })).toBe('Hides after 30 s')
    expect(bannerTimingSummary({ hideAfterSec: 10, repeatEveryMin: 0 })).toBe('Hides after 10 s')
    expect(bannerTimingSummary({ hideAfterSec: 60 })).toBe('Hides after 1 min')
  })

  it('says nothing when both are off or omitted', () => {
    expect(bannerTimingSummary({})).toBeNull()
    expect(bannerTimingSummary({ hideAfterSec: 0, repeatEveryMin: 0 })).toBeNull()
  })

  it('writes no em dash and no Title Case', () => {
    for (const line of [
      bannerTimingSummary({ hideAfterSec: 30, repeatEveryMin: 15 }),
      bannerTimingSummary({ repeatEveryMin: 15 }),
      bannerTimingSummary({ hideAfterSec: 30 }),
      BANNER_REPEAT_DESCRIPTION
    ]) {
      expect(line).not.toMatch(/—|\.\.\./)
      expect(line!.slice(1)).not.toMatch(/\b[A-Z]/)
    }
  })
})

describe('banner timing labels', () => {
  it('spells seconds under a minute as "N s", whole minutes as "N min"', () => {
    expect(bannerSecondsLabel(10)).toBe('10 s')
    expect(bannerSecondsLabel(59)).toBe('59 s')
    expect(bannerSecondsLabel(60)).toBe('1 min')
    expect(bannerSecondsLabel(300)).toBe('5 min')
    // Never a value the presets can't make, but never a lie either.
    expect(bannerSecondsLabel(90)).toBe('1 min 30 s')
    expect(bannerMinutesLabel(15)).toBe('15 min')
  })

  it('lists the plan presets, Off first', () => {
    expect(BANNER_HIDE_AFTER_CHOICES).toEqual([0, 10, 30, 60, 300])
    expect(BANNER_REPEAT_CHOICES).toEqual([0, 5, 10, 15, 30])
  })

  it('keeps a stored value outside the presets in its place', () => {
    expect(bannerTimingChoices(BANNER_HIDE_AFTER_CHOICES, 30)).toEqual([0, 10, 30, 60, 300])
    expect(bannerTimingChoices(BANNER_HIDE_AFTER_CHOICES, 45)).toEqual([0, 10, 30, 45, 60, 300])
    expect(bannerTimingChoices(BANNER_REPEAT_CHOICES, 60)).toEqual([0, 5, 10, 15, 30, 60])
  })
})
