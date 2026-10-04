import { describe, expect, it } from 'vitest'

import type { AiCapabilities, CleanCutJob } from './backend'
import {
  CLEAN_CUT_AUTO_LABEL,
  CLEAN_CUT_CONSENT_OFF_REASON,
  CLEAN_CUT_DESCRIPTION,
  CLEAN_CUT_NO_RECORDINGS,
  CLEAN_CUT_SIGNED_OUT_REASON,
  cleanCutAutoStatus,
  cleanCutCapabilities,
  cleanCutDurationsLabel,
  cleanCutEligibility,
  cleanCutFailureCopy,
  cleanCutJobEditable,
  cleanCutMinutesLeftLabel,
  cleanCutReadyTitle,
  cleanCutSavedLabel,
  cleanCutStatusView,
  cleanCutUnavailableReason,
  cleanCutUnlock,
  formatCutClock,
  isCleanCutJobActive,
  latestCleanCutJob,
  recentCleanCutRecordings,
  upsertCleanCutJob,
  type CleanCutCapabilities,
  type CleanCutSession
} from './clean-cut-view'
import type { EntitlementUiGate } from './entitlement-ui'

const MIN = 60_000

function session(overrides: Partial<CleanCutSession> = {}): CleanCutSession {
  return {
    id: 'rec-1',
    title: 'Building a Rust CLI',
    startedAt: '2026-10-03T14:02:00Z',
    durationMs: 42 * MIN + 10_000,
    status: 'completed',
    mode: 'record',
    mp4Path: '/videos/rust-cli.mp4',
    finalizationState: 'finalized',
    healthEventCount: 0,
    sessionLogCount: 0,
    aiArtifactCount: 0,
    commentCount: 0,
    ...overrides
  }
}

function job(overrides: Partial<CleanCutJob> = {}): CleanCutJob {
  return {
    id: 'job-1',
    sourceSessionId: 'rec-1',
    mode: 'clean',
    state: 'queued',
    progress: 0,
    edlRevision: 0,
    createdAt: '2026-10-03T15:00:00Z',
    updatedAt: '2026-10-03T15:00:00Z',
    ...overrides
  }
}

const SUMMARY = {
  durationMs: 42 * MIN + 10_000,
  keptMs: 31 * MIN + 5_000,
  removalCount: 63,
  byKind: []
}

const idle = { captureActive: false, streaming: false }
const premium: EntitlementUiGate = { allowed: true }
const basic: EntitlementUiGate = {
  allowed: false,
  featureId: 'cloud-ai',
  reason: 'Cloud AI requires Videorc Premium.',
  upgradeUrl: 'https://www.videorc.com/premium'
}

function capabilities(overrides: Partial<CleanCutCapabilities> = {}): CleanCutCapabilities {
  return {
    supported: true,
    available: true,
    reasonCode: null,
    monthlySecondsLimit: 72_000,
    remainingSeconds: 64_000,
    ...overrides
  }
}

describe('Clean cut copy (plan 119 S14)', () => {
  it('sells the same thing as the website', () => {
    expect(CLEAN_CUT_DESCRIPTION).toBe(
      'Stop recording, and the edited version is already there. Silences, ums, and retakes removed, within a monthly allowance.'
    )
    expect(CLEAN_CUT_AUTO_LABEL).toBe('Make a clean cut of every recording')
  })

  it('keeps every line plain: no em dash, never co-host', () => {
    for (const line of [
      CLEAN_CUT_DESCRIPTION,
      CLEAN_CUT_AUTO_LABEL,
      CLEAN_CUT_SIGNED_OUT_REASON,
      CLEAN_CUT_CONSENT_OFF_REASON,
      CLEAN_CUT_NO_RECORDINGS,
      cleanCutFailureCopy('clean-cut-monthly-quota-exhausted', undefined),
      cleanCutUnavailableReason('quota-exhausted')
    ]) {
      expect(line).not.toContain('—')
      expect(line).not.toMatch(/co-?host/i)
    }
  })
})

describe('cleanCutCapabilities', () => {
  it('reads the block loosely and treats a missing block as no Clean cut', () => {
    expect(cleanCutCapabilities(null)).toBeNull()
    expect(cleanCutCapabilities({} as AiCapabilities)).toBeNull()
    expect(
      cleanCutCapabilities({
        cleanCut: { supported: true, available: false, reasonCode: 'quota-exhausted' }
      } as unknown as AiCapabilities)
    ).toEqual({
      supported: true,
      available: false,
      reasonCode: 'quota-exhausted',
      monthlySecondsLimit: null,
      remainingSeconds: null
    })
    expect(
      cleanCutCapabilities({
        cleanCut: { supported: true, available: true, remainingSeconds: 64_000 }
      } as unknown as AiCapabilities)?.remainingSeconds
    ).toBe(64_000)
  })
})

describe('eligibility (decision 11)', () => {
  it('accepts a finished recording with its MP4, ten seconds or longer', () => {
    expect(cleanCutEligibility(session())).toEqual({ eligible: true })
    expect(cleanCutEligibility(session({ mode: 'record+stream' })).eligible).toBe(true)
  })

  it('refuses what the backend refuses, with a plain reason', () => {
    const reason = (overrides: Partial<CleanCutSession>): string | null => {
      const result = cleanCutEligibility(session(overrides))
      return result.eligible ? null : result.reason
    }
    expect(reason({ status: 'running' })).toContain('once the recording has finished')
    expect(reason({ finalizationState: 'finalizing' })).toContain('once the recording has finished')
    expect(reason({ mode: 'imported' })).toBe('Imported videos are not supported yet.')
    expect(reason({ derivedFromSessionId: 'rec-0' })).toContain("can't be cut again")
    expect(reason({ cleanCutOfSessionId: 'rec-0' })).toContain("can't be cut again")
    expect(reason({ processingKind: 'noise-cleanup' })).toContain("can't be cut again")
    expect(reason({ mode: 'stream', mp4Path: undefined })).toContain('Only recordings')
    expect(reason({ durationMs: 9_999 })).toContain('shorter than 10 seconds')
    expect(reason({ durationMs: undefined })).toContain('shorter than 10 seconds')
    expect(reason({ mp4Path: undefined })).toContain('MP4 file is missing')
    expect(reason({ mp4Path: '/videos/rust-cli.mkv' })).toContain('MP4 file is missing')
  })

  it('lists eligible recordings newest first, within the limit', () => {
    const rows = [
      session({ id: 'old', startedAt: '2026-10-01T10:00:00Z' }),
      session({ id: 'stream-only', mode: 'stream', startedAt: '2026-10-04T10:00:00Z' }),
      session({ id: 'new', startedAt: '2026-10-03T10:00:00Z' }),
      session({ id: 'short', durationMs: 5_000, startedAt: '2026-10-03T11:00:00Z' })
    ]
    expect(recentCleanCutRecordings(rows).map((row) => row.id)).toEqual(['new', 'old'])
    expect(recentCleanCutRecordings(rows, 1).map((row) => row.id)).toEqual(['new'])
  })
})

describe('jobs', () => {
  it('keeps one entry per job and never goes back to an older snapshot', () => {
    const queued = job()
    const transcribing = job({ state: 'transcribing', updatedAt: '2026-10-03T15:01:00Z' })
    expect(upsertCleanCutJob([], queued)).toEqual([queued])
    expect(upsertCleanCutJob([queued], transcribing)).toEqual([transcribing])
    expect(upsertCleanCutJob([transcribing], queued)).toEqual([transcribing])
    const other = job({ id: 'job-2' })
    expect(upsertCleanCutJob([queued], other)).toEqual([other, queued])
  })

  it('finds the newest job of a recording and mode', () => {
    const older = job({ id: 'a', createdAt: '2026-10-01T00:00:00Z' })
    const newer = job({ id: 'b', createdAt: '2026-10-02T00:00:00Z' })
    const condensed = job({ id: 'c', mode: 'condensed', createdAt: '2026-10-03T00:00:00Z' })
    const elsewhere = job({ id: 'd', sourceSessionId: 'rec-2' })
    const jobs = [older, condensed, newer, elsewhere]
    expect(latestCleanCutJob(jobs, 'rec-1', 'clean')?.id).toBe('b')
    expect(latestCleanCutJob(jobs, 'rec-1', 'condensed')?.id).toBe('c')
    expect(latestCleanCutJob(jobs, 'rec-9', 'clean')).toBeNull()
  })

  it('knows which states a worker owns and which accept edits', () => {
    expect(isCleanCutJobActive(job({ state: 'rendering' }))).toBe(true)
    expect(isCleanCutJobActive(job({ state: 'completed' }))).toBe(false)
    expect(cleanCutJobEditable(job({ state: 'ready' }))).toBe(true)
    expect(cleanCutJobEditable(job({ state: 'completed' }))).toBe(true)
    expect(cleanCutJobEditable(job({ state: 'failed' }))).toBe(true)
    expect(cleanCutJobEditable(job({ state: 'rendering' }))).toBe(false)
    expect(cleanCutJobEditable(job({ state: 'validating' }))).toBe(false)
  })
})

describe('time labels', () => {
  it('reads like the clip marks: 42:10, 1:02:10', () => {
    expect(formatCutClock(42 * MIN + 10_000)).toBe('42:10')
    expect(formatCutClock(62 * MIN + 10_000)).toBe('1:02:10')
    expect(formatCutClock(-5)).toBe('0:00')
    expect(cleanCutDurationsLabel(SUMMARY)).toBe('42:10 → 31:05')
    expect(cleanCutSavedLabel(SUMMARY)).toBe('11:05 shorter')
  })

  it('says the minutes left this month, or nothing when unlimited', () => {
    expect(cleanCutMinutesLeftLabel(null)).toBeNull()
    expect(cleanCutMinutesLeftLabel(capabilities({ remainingSeconds: null }))).toBeNull()
    expect(cleanCutMinutesLeftLabel(capabilities({ remainingSeconds: 64_000 }))).toBe(
      '1,066 min left this month'
    )
    expect(cleanCutMinutesLeftLabel(capabilities({ remainingSeconds: 0 }))).toBe(
      'No minutes left this month'
    )
  })
})

describe('cleanCutStatusView', () => {
  it('says what a recording without a cut can do', () => {
    expect(cleanCutStatusView(null, idle)).toMatchObject({
      kind: 'none',
      label: 'Not cut yet',
      busy: false,
      retry: null
    })
  })

  it('waits for the capture to end before any heavy work', () => {
    expect(cleanCutStatusView(job(), { captureActive: true, streaming: true }).label).toBe(
      'Waiting until you stop streaming'
    )
    expect(cleanCutStatusView(job(), { captureActive: true, streaming: false }).label).toBe(
      'Waiting until you stop recording'
    )
    expect(
      cleanCutStatusView(job({ state: 'ready', edlSummary: SUMMARY }), {
        captureActive: true,
        streaming: true
      }).kind
    ).toBe('waiting')
  })

  it('names each step, with progress where there is one', () => {
    expect(cleanCutStatusView(job(), idle).label).toBe('Waiting to start')
    expect(cleanCutStatusView(job({ step: 'render', edlSummary: SUMMARY }), idle).label).toBe(
      'Waiting to cut'
    )
    expect(cleanCutStatusView(job({ state: 'transcribing', progress: 0.4 }), idle)).toMatchObject({
      kind: 'transcribing',
      label: 'Transcribing 40%',
      percent: 40,
      busy: true
    })
    expect(cleanCutStatusView(job({ state: 'analyzing', step: 'analyze' }), idle).label).toBe(
      'Finding retakes'
    )
    expect(
      cleanCutStatusView(job({ state: 'analyzing', step: 'analyze', mode: 'condensed' }), idle)
        .label
    ).toBe('Picking the best parts')
    expect(cleanCutStatusView(job({ state: 'analyzing', step: 'cut-list' }), idle).label).toBe(
      'Building the cut list'
    )
    expect(cleanCutStatusView(job({ state: 'ready', edlSummary: SUMMARY }), idle)).toMatchObject({
      label: 'Waiting to cut',
      canReview: true
    })
    expect(
      cleanCutStatusView(job({ state: 'rendering', progress: 0.63, edlSummary: SUMMARY }), idle)
    ).toMatchObject({ kind: 'cutting', label: 'Cutting 63%', percent: 63, canReview: true })
    expect(cleanCutStatusView(job({ state: 'validating', edlSummary: SUMMARY }), idle).label).toBe(
      'Checking the cut'
    )
  })

  it('shows a finished cut as original → cut and what it saved', () => {
    expect(
      cleanCutStatusView(
        job({ state: 'completed', edlSummary: SUMMARY, outputSessionId: 'out-1' }),
        idle
      )
    ).toMatchObject({
      kind: 'ready',
      label: 'Ready',
      detail: '42:10 → 31:05 · 11:05 shorter',
      busy: false,
      canReview: true,
      retry: null
    })
  })

  it('retries a failed render by cutting again, and an earlier failure by starting over', () => {
    expect(
      cleanCutStatusView(
        job({
          state: 'failed',
          edlSummary: SUMMARY,
          errorCode: 'render-invalid',
          errorMessage: 'x'
        }),
        idle
      )
    ).toMatchObject({ kind: 'failed', retry: 'render', canReview: true })
    expect(
      cleanCutStatusView(
        job({
          state: 'failed',
          errorCode: 'clean-cut-monthly-quota-exhausted',
          errorMessage: 'Quota.'
        }),
        idle
      )
    ).toMatchObject({
      retry: 'start',
      canReview: false,
      detail:
        "This month's Clean cut minutes ran out. Retry next month; nothing done so far is lost."
    })
    expect(cleanCutStatusView(job({ state: 'cancelled' }), idle)).toMatchObject({
      kind: 'cancelled',
      retry: 'start'
    })
  })
})

describe('failure copy', () => {
  it('maps known codes to plain words and keeps the server message otherwise', () => {
    expect(cleanCutFailureCopy('clean-cut-daily-quota-exhausted', 'x')).toBe(
      'You made the most clean cuts for today. Retry tomorrow.'
    )
    expect(cleanCutFailureCopy('network', 'socket hang up')).toBe(
      "Videorc couldn't be reached. Retry when you're online."
    )
    expect(cleanCutFailureCopy('insufficient-space', undefined)).toBe(
      'There is not enough free disk space for the cut copy.'
    )
    expect(cleanCutFailureCopy('some-new-code', 'The server said why.')).toBe(
      'The server said why.'
    )
    expect(cleanCutFailureCopy(undefined, '   ')).toBe('Clean cut stopped before it finished.')
  })
})

describe('cleanCutUnlock', () => {
  it('asks to sign in first, then for Premium', () => {
    expect(cleanCutUnlock({ signedIn: false, gate: basic, capabilities: null })).toEqual({
      action: { kind: 'sign-in' },
      reason: CLEAN_CUT_SIGNED_OUT_REASON
    })
    expect(cleanCutUnlock({ signedIn: true, gate: basic, capabilities: null })).toEqual({
      action: { kind: 'view-premium', url: 'https://www.videorc.com/premium' },
      reason: 'Cloud AI requires Videorc Premium.'
    })
  })

  it('blocks nothing while the capability block is unknown or available', () => {
    expect(cleanCutUnlock({ signedIn: true, gate: premium, capabilities: null })).toBeNull()
    expect(
      cleanCutUnlock({ signedIn: true, gate: premium, capabilities: capabilities() })
    ).toBeNull()
  })

  it("says why the server can't offer it", () => {
    expect(
      cleanCutUnlock({
        signedIn: true,
        gate: premium,
        capabilities: capabilities({ available: false, reasonCode: 'quota-exhausted' })
      })
    ).toEqual({ action: null, reason: "This month's Clean cut minutes are used up." })
    expect(
      cleanCutUnlock({
        signedIn: true,
        gate: premium,
        capabilities: capabilities({ available: false, reasonCode: 'premium-required' })
      })?.action
    ).toEqual({ kind: 'view-premium', url: expect.stringContaining('/premium') })
    expect(
      cleanCutUnlock({
        signedIn: true,
        gate: premium,
        capabilities: capabilities({ supported: false, available: false })
      })?.reason
    ).toBe("Clean cut isn't available yet.")
    expect(cleanCutUnavailableReason('brand-new')).toBe(
      "Clean cut isn't available right now (brand-new)."
    )
  })
})

describe('cleanCutAutoStatus', () => {
  it('is off, on, or needs attention with the reason', () => {
    expect(
      cleanCutAutoStatus({ on: false, unlock: null, consented: true, captureActive: false })
    ).toEqual({ kind: 'off', label: 'Off', reason: null })
    expect(
      cleanCutAutoStatus({ on: true, unlock: null, consented: true, captureActive: false }).label
    ).toBe('On, cuts every recording when you stop')
    expect(
      cleanCutAutoStatus({ on: true, unlock: null, consented: true, captureActive: true }).label
    ).toBe('On, cuts this recording when you stop')
    expect(
      cleanCutAutoStatus({ on: true, unlock: null, consented: false, captureActive: false })
    ).toEqual({ kind: 'attention', label: 'Needs attention', reason: CLEAN_CUT_CONSENT_OFF_REASON })
    expect(
      cleanCutAutoStatus({
        on: true,
        unlock: { action: null, reason: 'Paused.' },
        consented: true,
        captureActive: false
      }).reason
    ).toBe('Paused.')
  })
})

describe('cleanCutReadyTitle', () => {
  it('names the cut and its two lengths', () => {
    expect(cleanCutReadyTitle({ mode: 'clean', edlSummary: SUMMARY })).toBe(
      'Your clean cut is ready (42:10 → 31:05)'
    )
    expect(cleanCutReadyTitle({ mode: 'condensed', edlSummary: SUMMARY })).toBe(
      'Your condensed cut is ready (42:10 → 31:05)'
    )
    expect(cleanCutReadyTitle({ mode: 'clean' })).toBe('Your clean cut is ready')
  })
})
