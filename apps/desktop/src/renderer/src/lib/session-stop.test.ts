import { describe, expect, it } from 'vitest'

import {
  END_LIVESTREAM_ARM_WINDOW_MS,
  END_LIVESTREAM_LABEL,
  END_LIVESTREAM_TITLE,
  endLivestreamBody,
  endLivestreamConfirmLabel,
  endLivestreamTitle,
  exitForStopOrigin,
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
  'failure-banner',
  'quit',
  'close-window'
]

describe('stopDecision (plan 174 S0.1, D2)', () => {
  it('stops a recording that is not live at once, from every origin', () => {
    for (const origin of ORIGINS) {
      expect(stopDecision({ origin, live: false, armedAt: null, now: 1000 })).toBe('stop')
      // An armed hotkey means nothing once the session is no longer live.
      expect(stopDecision({ origin, live: false, armedAt: 900, now: 1000 })).toBe('stop')
    }
  })

  it('asks first for every in-app stop while live, and when the app is leaving (S3.1)', () => {
    for (const origin of [
      'button',
      'space',
      'palette',
      'failure-banner',
      'quit',
      'close-window'
    ] as const) {
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

  // Plan 174 S3.1 (D2): ⌘Q and ⌘W while on air ask first, and the question
  // names what follows. "Keep streaming" is the same answer everywhere.
  it('names the exit in the title and the button when the app is leaving', () => {
    expect(endLivestreamTitle('quit')).toBe('End livestream and quit?')
    expect(endLivestreamConfirmLabel('quit')).toBe('End livestream and quit')
    expect(endLivestreamTitle('close-window')).toBe('End livestream and close?')
    expect(endLivestreamConfirmLabel('close-window')).toBe('End livestream and close')
    for (const origin of ['button', 'space', 'palette', 'failure-banner'] as const) {
      expect(endLivestreamTitle(origin)).toBe(END_LIVESTREAM_TITLE)
      expect(endLivestreamConfirmLabel(origin)).toBe(END_LIVESTREAM_LABEL)
    }
  })

  it('continues with the exit only for a quit or close question', () => {
    expect(exitForStopOrigin('quit')).toBe('quit')
    expect(exitForStopOrigin('close-window')).toBe('close')
    for (const origin of ORIGINS.filter((o) => o !== 'quit' && o !== 'close-window')) {
      expect(exitForStopOrigin(origin)).toBeNull()
    }
  })
})
