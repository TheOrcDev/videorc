import { describe, expect, it } from 'vitest'

import {
  CRITICAL_NOTIFIES_FOCUSED_AFTER_SECONDS,
  NOTIFY_DEDUPE_MS,
  WatchdogNotifyLedger,
  watchdogNotifyDecision
} from './watchdog-notify'

const notice = (critical: boolean, openSeconds = 0) => ({
  alertId: 'watchdog:mic-muted:1',
  title: 'Videorc: your microphone is muted',
  body: 'Muted for 0:42 on the livestream. Click to open the Studio.',
  critical,
  openSeconds
})

describe('watchdogNotifyDecision (plan 223 A7, D3)', () => {
  it('shows when the Studio is not the front window, with the alert words', () => {
    const decision = watchdogNotifyDecision({
      notice: notice(true),
      mainFocused: false,
      enabled: true,
      supported: true,
      lastShownAt: null,
      now: 1_000
    })
    expect(decision).toEqual({
      show: true,
      title: 'Videorc: your microphone is muted',
      body: 'Muted for 0:42 on the livestream. Click to open the Studio.'
    })
  })

  it('stays quiet while the Studio is focused, unless a critical alert stayed open 60 s', () => {
    const base = { mainFocused: true, enabled: true, supported: true, lastShownAt: null, now: 0 }
    expect(watchdogNotifyDecision({ ...base, notice: notice(true, 59) })).toEqual({
      show: false,
      reason: 'focused'
    })
    expect(
      watchdogNotifyDecision({
        ...base,
        notice: notice(true, CRITICAL_NOTIFIES_FOCUSED_AFTER_SECONDS)
      }).show
    ).toBe(true)
    expect(watchdogNotifyDecision({ ...base, notice: notice(false, 600) })).toEqual({
      show: false,
      reason: 'focused'
    })
  })

  it('honours the switch, the platform, and never shows one id twice in a row', () => {
    const base = { notice: notice(true), mainFocused: false, lastShownAt: null, now: 10_000 }
    expect(watchdogNotifyDecision({ ...base, enabled: false, supported: true })).toEqual({
      show: false,
      reason: 'off'
    })
    expect(watchdogNotifyDecision({ ...base, enabled: true, supported: false })).toEqual({
      show: false,
      reason: 'unsupported'
    })
    const ledger = new WatchdogNotifyLedger()
    ledger.mark('watchdog:mic-muted:1', 10_000)
    expect(
      watchdogNotifyDecision({
        ...base,
        enabled: true,
        supported: true,
        lastShownAt: ledger.lastShownAt('watchdog:mic-muted:1'),
        now: 10_000 + NOTIFY_DEDUPE_MS - 1
      })
    ).toEqual({ show: false, reason: 'duplicate' })
    expect(
      watchdogNotifyDecision({
        ...base,
        enabled: true,
        supported: true,
        lastShownAt: ledger.lastShownAt('watchdog:mic-muted:1'),
        now: 10_000 + NOTIFY_DEDUPE_MS
      }).show
    ).toBe(true)
    expect(ledger.lastShownAt('other')).toBeNull()
  })
})
