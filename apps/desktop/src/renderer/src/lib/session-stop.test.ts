import { describe, expect, it } from 'vitest'

import {
  END_LIVESTREAM_ARM_WINDOW_MS,
  endLivestreamBody,
  listNames,
  stopDecision,
  type SessionStopOrigin
} from './session-stop'

const ORIGINS: SessionStopOrigin[] = [
  'button',
  'space',
  'palette',
  'global-hotkey',
  'remote-control',
  'phone-remote',
  'failure-banner'
]

describe('stopDecision (plan 174 S0.1, D2)', () => {
  it('stops a recording that is not live at once, from every origin', () => {
    for (const origin of ORIGINS) {
      expect(stopDecision({ origin, live: false, armedAt: null, now: 1000 })).toBe('stop')
      // An armed hotkey means nothing once the session is no longer live.
      expect(stopDecision({ origin, live: false, armedAt: 900, now: 1000 })).toBe('stop')
    }
  })

  it('asks first for every in-app stop while live', () => {
    for (const origin of ['button', 'space', 'palette', 'failure-banner'] as const) {
      expect(stopDecision({ origin, live: true, armedAt: null, now: 1000 })).toBe('confirm')
      // In-app origins never read the hotkey arm.
      expect(stopDecision({ origin, live: true, armedAt: 999, now: 1000 })).toBe('confirm')
    }
  })

  it('keeps the device contracts: Stream Deck and phone intents stop at once', () => {
    for (const origin of ['remote-control', 'phone-remote'] as const) {
      expect(stopDecision({ origin, live: true, armedAt: null, now: 1000 })).toBe('stop')
    }
  })

  it('arms a global hotkey, then stops on a second press within the window', () => {
    expect(stopDecision({ origin: 'global-hotkey', live: true, armedAt: null, now: 1000 })).toBe(
      'arm'
    )
    expect(stopDecision({ origin: 'global-hotkey', live: true, armedAt: 1000, now: 1001 })).toBe(
      'stop'
    )
    expect(
      stopDecision({
        origin: 'global-hotkey',
        live: true,
        armedAt: 1000,
        now: 1000 + END_LIVESTREAM_ARM_WINDOW_MS
      })
    ).toBe('stop')
  })

  it('starts over when the arm expired or the clock went backwards', () => {
    expect(
      stopDecision({
        origin: 'global-hotkey',
        live: true,
        armedAt: 1000,
        now: 1000 + END_LIVESTREAM_ARM_WINDOW_MS + 1
      })
    ).toBe('arm')
    expect(stopDecision({ origin: 'global-hotkey', live: true, armedAt: 5000, now: 1000 })).toBe(
      'arm'
    )
  })
})

describe('End livestream copy', () => {
  it('lists names the way a sentence does', () => {
    expect(listNames([])).toBe('')
    expect(listNames(['Twitch'])).toBe('Twitch')
    expect(listNames(['Twitch', 'YouTube'])).toBe('Twitch and YouTube')
    expect(listNames(['Twitch', 'YouTube', 'Kick'])).toBe('Twitch, YouTube and Kick')
    expect(listNames([' Twitch ', '', 'X'])).toBe('Twitch and X')
  })

  it('names the audience and says what happens to the recording (D19)', () => {
    expect(endLivestreamBody({ platforms: ['Twitch', 'YouTube'], alsoRecords: true })).toBe(
      'Viewers on Twitch and YouTube are disconnected. Your recording stops too and is saved to the Library.'
    )
    expect(endLivestreamBody({ platforms: ['X'], alsoRecords: false })).toBe(
      'Viewers on X are disconnected.'
    )
    expect(endLivestreamBody({ platforms: [], alsoRecords: true })).toBe(
      'Your viewers are disconnected. Your recording stops too and is saved to the Library.'
    )
  })
})
