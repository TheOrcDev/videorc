import { describe, expect, it } from 'vitest'

import type { CloudStatus } from './backend'
import {
  cloudFallbackMessage,
  cloudFallbackToast,
  cloudHoursLine,
  cloudLostToast,
  cloudResumeNotice,
  cloudSectionState,
  formatCloudCountdown,
  formatCloudResetDate,
  formatHoldLimit,
  goesThroughCloud
} from './cloud-view'

function status(overrides: Partial<CloudStatus> = {}): CloudStatus {
  return {
    phase: 'off',
    entitled: true,
    plan: 'premium',
    settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [300, 900, 1800, 3600] },
    allowance: {
      enabled: true,
      secondsPerMonth: 36_000,
      secondsUsed: 3_600,
      overageSeconds: 0,
      resetAt: '2026-11-01T00:00:00.000Z',
      talkShows: false
    },
    connected: false,
    directFallbackAvailable: false,
    ...overrides
  }
}

describe('cloud copy (plan 184)', () => {
  it('names the reset day in UTC', () => {
    expect(formatCloudResetDate('2026-11-01T00:00:00.000Z')).toBe('Nov 1')
    expect(formatCloudResetDate(undefined)).toBeNull()
    expect(formatCloudResetDate('soon')).toBeNull()
  })

  it('says why a Go Live streamed directly, once per session', () => {
    const fallback = {
      reason: 'cloud-full' as const,
      at: '2026-10-16T12:00:00.000Z',
      sessionId: 'session-1'
    }
    const next = status({ fallback })
    expect(cloudFallbackToast(null, next)).toBe(
      "Videorc Cloud is full right now. You're streaming directly from this computer."
    )
    expect(cloudFallbackToast(next, next)).toBeNull()
    expect(
      cloudFallbackToast(next, status({ fallback: { ...fallback, sessionId: 'session-2' } }))
    ).not.toBeNull()
    expect(cloudFallbackToast(null, status())).toBeNull()
    expect(cloudFallbackMessage('cloud-hours-used-up', status().allowance)).toBe(
      "You've used this month's cloud hours. You're streaming directly from this computer until Nov 1."
    )
    for (const reason of ['cloud-disabled', 'cloud-node-unreachable', 'not-entitled'] as const) {
      expect(cloudFallbackMessage(reason)).toMatch(/streaming directly from this computer\.$/)
    }
  })

  it('warns once when the cloud loses a show this computer fed', () => {
    const lost = status({ directFallbackAvailable: true, phase: 'failed' })
    expect(cloudLostToast(status(), lost)).toMatch(/Stop, then go live again/)
    expect(cloudLostToast(lost, lost)).toBeNull()
  })

  it('counts cloud hours plainly, minutes under an hour, overage with no charge', () => {
    expect(cloudHoursLine(status().allowance)).toBe('9 of 10 cloud hours left · resets Nov 1')
    expect(cloudHoursLine({ ...status().allowance!, secondsUsed: 36_000 - 45 * 60 })).toBe(
      '45 min of 10 hours left · resets Nov 1'
    )
    expect(
      cloudHoursLine({ ...status().allowance!, secondsUsed: 37_380, overageSeconds: 1_380 })
    ).toBe("23 min over this month's 10 hours, no charge · resets Nov 1")
    expect(cloudHoursLine(undefined)).toBeNull()
    expect(cloudHoursLine({ ...status().allowance!, secondsPerMonth: 0 })).toBeNull()
  })

  it('formats the hold limit choices and the countdown', () => {
    expect([300, 900, 1800, 3600].map(formatHoldLimit)).toEqual([
      '5 min',
      '15 min',
      '30 min',
      '1 hour'
    ])
    expect(formatCloudCountdown(1_650)).toBe('28 min')
    expect(formatCloudCountdown(45)).toBe('45 s')
  })

  it('offers Resume only for a live show this computer is not feeding', () => {
    const holding = status({
      phase: 'hold',
      show: { id: 'sh_1', nodeId: 'eu-hel-1', resumable: true },
      hold: { active: true, remainingSeconds: 1_650 }
    })
    expect(cloudResumeNotice(holding, false)).toEqual({
      detail: 'Viewers see Be right back. The stream ends in 28 min unless you resume.',
      title: "You're still live through Videorc Cloud."
    })
    expect(cloudResumeNotice(holding, true)).toBeNull()
    expect(
      cloudResumeNotice({ ...holding, show: { ...holding.show!, resumable: false } }, false)
    ).toBeNull()
    expect(cloudResumeNotice({ ...holding, phase: 'ending' }, false)).toBeNull()
    expect(cloudResumeNotice(null, false)).toBeNull()
  })

  it('says Connecting to Videorc Cloud only when Go Live goes through it', () => {
    expect(goesThroughCloud(status())).toBe(true)
    expect(goesThroughCloud(status({ entitled: false }))).toBe(false)
    expect(goesThroughCloud(status({ settings: { ...status().settings, enabled: false } }))).toBe(
      false
    )
    expect(goesThroughCloud(null)).toBe(false)
  })

  it('shows the section, the not-yet line, or the plain upsell', () => {
    expect(cloudSectionState(status())).toEqual({
      hours: '9 of 10 cloud hours left · resets Nov 1',
      kind: 'available'
    })
    expect(cloudSectionState(status({ entitled: false }))).toEqual({ kind: 'unavailable' })
    expect(cloudSectionState(status({ entitled: false, plan: undefined }))).toEqual({
      kind: 'upsell'
    })
    expect(cloudSectionState(null)).toBeNull()
  })
})
