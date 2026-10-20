import { describe, expect, it } from 'vitest'

import type { CloudStatus, CloudTestResult } from './backend'
import {
  CLOUD_TEST_DESCRIPTION,
  cloudFallbackMessage,
  cloudFallbackToast,
  cloudHoursLine,
  cloudLostToast,
  cloudResumeNotice,
  cloudSectionState,
  cloudTestBlockedReason,
  cloudTestLine,
  cloudTestResultLine,
  cloudTestRowLines,
  cloudTestRunning,
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

describe('Test cloud copy (plan 184 C6b)', () => {
  const held: CloudTestResult = {
    ok: true,
    timeToLiveMs: 2_300,
    uploads: [{ orientation: 'horizontal', targetKbps: 6000, measuredKbps: 6160 }]
  }

  it('says the step under way, then the result, else what the test does', () => {
    expect(cloudTestLine(undefined)).toBe(CLOUD_TEST_DESCRIPTION)
    expect(cloudTestLine({ phase: 'creating', startedAt: 't' })).toBe(
      'Connecting to Videorc Cloud…'
    )
    expect(cloudTestLine({ phase: 'connecting', startedAt: 't' })).toBe(
      'Connecting to Videorc Cloud…'
    )
    expect(cloudTestLine({ phase: 'pushing', startedAt: 't' })).toBe(
      'Sending 10 seconds of test video…'
    )
    expect(cloudTestLine({ phase: 'ending', startedAt: 't' })).toBe('Finishing the test…')
    expect(cloudTestLine({ phase: 'done', startedAt: 't', result: held })).toBe(
      'Videorc Cloud works from here. Live in 2.3 s. Upload held 6.2 of 6 Mbps.'
    )
    expect(cloudTestLine({ phase: 'done', startedAt: 't' })).toBe(CLOUD_TEST_DESCRIPTION)
    expect(cloudTestRunning(undefined)).toBe(false)
    expect(cloudTestRunning({ phase: 'pushing', startedAt: 't' })).toBe(true)
    expect(cloudTestRunning({ phase: 'done', startedAt: 't', result: held })).toBe(false)
  })

  it('names both streams of a dual-orientation test', () => {
    expect(
      cloudTestResultLine({
        ...held,
        uploads: [
          { orientation: 'horizontal', targetKbps: 6000, measuredKbps: 6160 },
          { orientation: 'vertical', targetKbps: 3000, measuredKbps: 3100 }
        ]
      })
    ).toBe(
      'Videorc Cloud works from here. Live in 2.3 s. Upload held 6.2 of 6 Mbps for the horizontal stream and 3.1 of 3 Mbps for the vertical.'
    )
  })

  it('tells a slow upload what it reached and what to do', () => {
    expect(
      cloudTestResultLine({
        ok: false,
        reason: 'too-slow',
        timeToLiveMs: 2_100,
        uploads: [{ orientation: 'horizontal', targetKbps: 6000, measuredKbps: 2100 }]
      })
    ).toBe(
      'Your upload reached 2.1 of 6 Mbps. Choose a lower stream quality or use a wired connection.'
    )
    expect(cloudTestResultLine({ ok: false, reason: 'too-slow' })).toBe(
      'Your upload fell short. Choose a lower stream quality or use a wired connection.'
    )
  })

  it('says when the upload went unmeasured instead of showing a zero', () => {
    expect(
      cloudTestResultLine({
        ok: true,
        timeToLiveMs: 2_300,
        uploads: [{ orientation: 'horizontal', targetKbps: 6000 }]
      })
    ).toBe("Videorc Cloud works from here. Live in 2.3 s. Videorc couldn't measure the upload.")
    expect(cloudTestResultLine({ ok: true, timeToLiveMs: 2_300 })).toBe(
      'Videorc Cloud works from here. Live in 2.3 s.'
    )
  })

  it('words every other reason plainly, with the limit and the hours reset', () => {
    const line = (reason: CloudTestResult['reason'], resetAt?: string) =>
      cloudTestResultLine({ ok: false, reason, resetAt })
    expect(line('cant-reach')).toBe(
      "Videorc Cloud couldn't be reached from here. Check your connection and try again."
    )
    expect(line('off')).toBe('Videorc Cloud is off right now. Try again later.')
    expect(line('full')).toBe('Videorc Cloud is full right now. Try again in a few minutes.')
    expect(line('not-entitled')).toBe('Videorc Cloud is part of Videorc Premium.')
    expect(line('no-hours', '2026-11-01T00:00:00.000Z')).toBe(
      "You've used this month's cloud hours. They come back Nov 1."
    )
    expect(line('no-hours')).toBe("You've used this month's cloud hours.")
    expect(line('limit', '2026-10-17T13:05:00.000Z')).toMatch(
      /^You've run this hour's tests\. Try again after \d{1,2}:\d{2} (AM|PM)\.$/
    )
    expect(line('limit')).toBe("You've run this hour's tests. Try again in a while.")
    expect(line('show-live')).toBe('A show is live through Videorc Cloud. End it first.')
    expect(line('certificate')).toBe(
      "Videorc Cloud's certificate couldn't be checked on this network. Try another network, or turn off apps that inspect secure connections."
    )
    expect(line('no-feed')).toBe(
      "Videorc Cloud didn't receive the test video. This network or a firewall may block streaming. Try another network."
    )
    expect(line('failed')).toBe(
      "Couldn't test Videorc Cloud. Try again. If it keeps happening, export a support bundle from Health."
    )
    expect(line(undefined)).toBe(line('failed'))
  })

  it('makes a failure the row error and keeps a refusal or a pass in the description', () => {
    const done = (result: CloudTestResult) =>
      cloudTestRowLines({ phase: 'done', startedAt: 't', result })
    expect(cloudTestRowLines(undefined)).toEqual({
      description: CLOUD_TEST_DESCRIPTION,
      error: null
    })
    expect(cloudTestRowLines({ phase: 'pushing', startedAt: 't' })).toEqual({
      description: 'Sending 10 seconds of test video…',
      error: null
    })
    expect(done(held).error).toBeNull()
    for (const reason of ['too-slow', 'cant-reach', 'certificate', 'no-feed', 'failed'] as const) {
      const lines = done({ ok: false, reason })
      expect(lines.description).toBeNull()
      expect(lines.error).toBe(cloudTestResultLine({ ok: false, reason }))
    }
    for (const reason of [
      'off',
      'full',
      'not-entitled',
      'no-hours',
      'limit',
      'show-live'
    ] as const) {
      const lines = done({ ok: false, reason })
      expect(lines.error).toBeNull()
      expect(lines.description).toBe(cloudTestResultLine({ ok: false, reason }))
    }
  })

  it('blocks Test with one reason while a session or a cloud show runs', () => {
    expect(cloudTestBlockedReason(status(), false)).toBeNull()
    expect(cloudTestBlockedReason(null, false)).toBeNull()
    expect(cloudTestBlockedReason(status(), true)).toBe("Locked while you're recording or live.")
    expect(
      cloudTestBlockedReason(
        status({ show: { id: 'sh_1', nodeId: 'eu-hel-1', resumable: true } }),
        false
      )
    ).toBe('A show is live through Videorc Cloud. End it first.')
  })
})
