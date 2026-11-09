import { describe, expect, it } from 'vitest'

import {
  CRITICAL_NOTIFIES_FOCUSED_AFTER_SECONDS,
  NOTIFIES_AFTER_OPEN_SECONDS,
  NOTIFY_DEDUPE_MS,
  WatchdogNotifyLedger,
  watchdogNotifyDecision
} from './watchdog-notify'

import type { WatchdogNoticeReason } from '../shared/backend'

const notice = (critical: boolean, openSeconds = 0, reason: WatchdogNoticeReason = 'opened') => ({
  alertId: 'watchdog:mic-muted:1',
  title: 'Videorc: your microphone is muted',
  body: 'Muted for 0:42 on the livestream. Click to open the Studio.',
  critical,
  openSeconds,
  reason
})

const base = { enabled: true, supported: true, lastShownAt: null, now: 1_000 }

describe('watchdogNotifyDecision (plan 223 A7, D2, D3)', () => {
  it('shows a critical alert at once when the Studio is not the front window, with the alert words', () => {
    expect(watchdogNotifyDecision({ ...base, notice: notice(true), mainFocused: false })).toEqual({
      show: true,
      title: 'Videorc: your microphone is muted',
      body: 'Muted for 0:42 on the livestream. Click to open the Studio.'
    })
    expect(watchdogNotifyDecision({ ...base, notice: notice(true), mainFocused: true })).toEqual({
      show: false,
      reason: 'focused'
    })
  })

  it('makes a warning wait for the 60 s ask, and shows it then only when the Studio is not in front', () => {
    expect(
      watchdogNotifyDecision({ ...base, notice: notice(false, 0, 'opened'), mainFocused: false })
    ).toEqual({ show: false, reason: 'too-soon' })
    expect(
      watchdogNotifyDecision({
        ...base,
        notice: notice(false, NOTIFIES_AFTER_OPEN_SECONDS, 'stayed-open'),
        mainFocused: false
      }).show
    ).toBe(true)
    expect(
      watchdogNotifyDecision({
        ...base,
        notice: notice(false, 600, 'stayed-open'),
        mainFocused: true
      })
    ).toEqual({ show: false, reason: 'focused' })
    expect(
      watchdogNotifyDecision({
        ...base,
        notice: notice(false, 59, 'stayed-open'),
        mainFocused: false
      })
    ).toEqual({ show: false, reason: 'too-soon' })
  })

  it('shows a critical alert that stayed open 60 s even over a focused Studio, once', () => {
    expect(
      watchdogNotifyDecision({
        ...base,
        notice: notice(true, 59, 'stayed-open'),
        mainFocused: true
      })
    ).toEqual({ show: false, reason: 'too-soon' })
    expect(
      watchdogNotifyDecision({
        ...base,
        notice: notice(true, CRITICAL_NOTIFIES_FOCUSED_AFTER_SECONDS, 'stayed-open'),
        mainFocused: true
      }).show
    ).toBe(true)
    // The first ask already showed it (the Studio was not in front then):
    // the 60 s ask never shows it a second time.
    expect(
      watchdogNotifyDecision({
        ...base,
        notice: notice(true, 60, 'stayed-open'),
        mainFocused: false,
        lastShownAt: 1_000 - NOTIFY_DEDUPE_MS - 1
      })
    ).toEqual({ show: false, reason: 'shown' })
  })

  it('shows a repeat when the Studio is not in front, or when critical and long open', () => {
    expect(
      watchdogNotifyDecision({ ...base, notice: notice(false, 600, 'repeat'), mainFocused: false })
        .show
    ).toBe(true)
    expect(
      watchdogNotifyDecision({ ...base, notice: notice(false, 600, 'repeat'), mainFocused: true })
    ).toEqual({ show: false, reason: 'focused' })
    expect(
      watchdogNotifyDecision({ ...base, notice: notice(true, 300, 'repeat'), mainFocused: true })
        .show
    ).toBe(true)
  })

  it('honours the switch, the platform, and never shows one id twice in a row', () => {
    const asked = { notice: notice(true), mainFocused: false, lastShownAt: null, now: 10_000 }
    expect(watchdogNotifyDecision({ ...asked, enabled: false, supported: true })).toEqual({
      show: false,
      reason: 'off'
    })
    expect(watchdogNotifyDecision({ ...asked, enabled: true, supported: false })).toEqual({
      show: false,
      reason: 'unsupported'
    })
    const ledger = new WatchdogNotifyLedger()
    ledger.mark('watchdog:mic-muted:1', 10_000)
    expect(
      watchdogNotifyDecision({
        ...asked,
        notice: notice(true, 300, 'repeat'),
        enabled: true,
        supported: true,
        lastShownAt: ledger.lastShownAt('watchdog:mic-muted:1'),
        now: 10_000 + NOTIFY_DEDUPE_MS - 1
      })
    ).toEqual({ show: false, reason: 'duplicate' })
    expect(
      watchdogNotifyDecision({
        ...asked,
        notice: notice(true, 300, 'repeat'),
        enabled: true,
        supported: true,
        lastShownAt: ledger.lastShownAt('watchdog:mic-muted:1'),
        now: 10_000 + NOTIFY_DEDUPE_MS
      }).show
    ).toBe(true)
    expect(ledger.lastShownAt('other')).toBeNull()
  })
})
