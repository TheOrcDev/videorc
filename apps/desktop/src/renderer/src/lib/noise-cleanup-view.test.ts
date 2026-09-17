import { describe, expect, it } from 'vitest'

import type { EntitlementsSnapshot, NoiseCleanupJob, SessionSummary } from './backend'
import { DEFAULT_BASIC_ENTITLEMENTS } from './entitlements'
import {
  activeNoiseCleanupSourceIds,
  deriveNoiseCleanupView,
  latestNoiseCleanupJobForSession,
  noiseCleanupCancellationNotice,
  upsertNoiseCleanupJob,
  withNoiseCleanupConnectionState
} from './noise-cleanup-view'

const premiumEntitlements: EntitlementsSnapshot = {
  ...DEFAULT_BASIC_ENTITLEMENTS,
  tier: 'premium',
  source: 'creem',
  capabilities: DEFAULT_BASIC_ENTITLEMENTS.capabilities.map((capability) => ({
    ...capability,
    state: 'enabled',
    reason: undefined
  }))
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    title: 'Weekly update',
    startedAt: '2026-07-13T10:00:00.000Z',
    status: 'completed',
    mode: 'record',
    outputPath: '/recordings/session-1.mkv',
    healthEventCount: 0,
    sessionLogCount: 0,
    aiArtifactCount: 0,
    commentCount: 0,
    ...overrides
  }
}

function job(overrides: Partial<NoiseCleanupJob> = {}): NoiseCleanupJob {
  return {
    id: 'cleanup-1',
    sourceSessionId: 'session-1',
    status: 'queued',
    progressPercent: 0,
    preset: 'speech-v1',
    createdAt: '2026-07-13T10:00:00.000Z',
    updatedAt: '2026-07-13T10:00:01.000Z',
    ...overrides
  }
}

function derive(
  overrides: {
    session?: SessionSummary
    entitlements?: EntitlementsSnapshot | null
    job?: NoiseCleanupJob | null
    captureActive?: boolean
  } = {}
) {
  return deriveNoiseCleanupView({
    session: overrides.session ?? session(),
    entitlements:
      overrides.entitlements === undefined ? premiumEntitlements : overrides.entitlements,
    job: overrides.job ?? null,
    captureActive: overrides.captureActive ?? false
  })
}

describe('Noise Cleanup Library view', () => {
  it('keeps missing and Basic entitlements actionable as a Premium upgrade', () => {
    for (const entitlements of [null, DEFAULT_BASIC_ENTITLEMENTS]) {
      expect(derive({ entitlements })).toMatchObject({
        directAction: 'upgrade',
        menuAction: 'upgrade',
        directLabel: 'Clean noise',
        menuLabel: 'Clean noise — Premium',
        premiumLocked: true,
        detail: 'Noise Cleanup requires Videorc Premium.'
      })
    }
  })

  it('starts a supported finalized local recording with one click', () => {
    expect(derive()).toMatchObject({
      directAction: 'start',
      menuAction: 'start',
      directLabel: 'Clean noise',
      busy: false
    })
  })

  it('states truthful disabled reasons for live, imported, missing, and unfinished sessions', () => {
    expect(derive({ captureActive: true }).disabledReason).toBe(
      'Available after the live session ends.'
    )
    expect(derive({ session: session({ mode: 'imported' }) }).disabledReason).toContain('Imported')
    expect(
      derive({ session: session({ outputPath: undefined, mp4Path: undefined }) }).disabledReason
    ).toBe('The local recording file is missing.')
    expect(derive({ session: session({ status: 'failed' }) }).disabledReason).toBe(
      'Noise Cleanup requires a finished recording.'
    )
  })

  it('states intrinsic blockers before offering Premium', () => {
    const cases = [
      {
        session: session(),
        captureActive: true,
        reason: 'Available after the live session ends.'
      },
      {
        session: session({ status: 'running' }),
        captureActive: false,
        reason: 'Available after the live session ends.'
      },
      {
        session: session({ mode: 'imported' }),
        captureActive: false,
        reason: 'Imported recordings are not supported by Noise Cleanup yet.'
      },
      {
        session: session({ outputPath: undefined, mp4Path: undefined }),
        captureActive: false,
        reason: 'The local recording file is missing.'
      },
      {
        session: session({ status: 'failed' }),
        captureActive: false,
        reason: 'Noise Cleanup requires a finished recording.'
      }
    ]

    for (const entry of cases) {
      expect(
        derive({
          session: entry.session,
          captureActive: entry.captureActive,
          entitlements: DEFAULT_BASIC_ENTITLEMENTS
        })
      ).toMatchObject({
        directAction: null,
        premiumLocked: false,
        disabledReason: entry.reason
      })
    }
  })

  it('shows queued, processing, and validating status with menu cancellation', () => {
    expect(derive({ job: job() })).toMatchObject({
      directAction: null,
      menuAction: 'cancel',
      directLabel: 'Queued…',
      busy: true,
      conflictsWithFileActions: true
    })
    expect(derive({ job: job({ status: 'processing', progressPercent: 42.4 }) })).toMatchObject({
      directLabel: 'Cleaning 42%',
      menuLabel: 'Cancel cleanup — 42%',
      statusAnnouncement: 'Cleaning noise, 40 percent.'
    })
    expect(derive({ job: job({ status: 'validating', progressPercent: 100 }) })).toMatchObject({
      directLabel: 'Validating…',
      menuAction: 'cancel',
      conflictsWithFileActions: true
    })
  })

  it('keeps an already-running local cleanup visible after entitlement loss', () => {
    expect(
      derive({
        entitlements: DEFAULT_BASIC_ENTITLEMENTS,
        job: job({ status: 'processing', progressPercent: 50 })
      })
    ).toMatchObject({ directLabel: 'Cleaning 50%', premiumLocked: false })
  })

  it('opens the managed cleaned copy only when completion has an output session', () => {
    expect(
      derive({
        job: job({
          status: 'completed',
          progressPercent: 100,
          outputSessionId: 'cleaned-session'
        })
      })
    ).toMatchObject({
      directAction: 'open-output',
      menuAction: 'open-output',
      directLabel: 'Open cleaned copy',
      statusAnnouncement: 'Noise cleanup completed.'
    })
  })

  it('marks cleaned derivatives and offers source reveal without another cleanup action', () => {
    expect(
      derive({
        session: session({
          id: 'cleaned-session',
          derivedFromSessionId: 'session-1',
          sourceTitle: 'Weekly update',
          processingKind: 'noise-cleanup'
        })
      })
    ).toMatchObject({
      directAction: null,
      menuAction: 'show-source',
      menuLabel: 'Show source recording',
      derivative: true
    })
  })

  it('never offers cleanup again when a derivative source was deleted', () => {
    expect(
      derive({
        session: session({
          id: 'cleaned-session',
          derivedFromSessionId: undefined,
          sourceTitle: 'Deleted source',
          processingKind: 'noise-cleanup'
        })
      })
    ).toMatchObject({
      directAction: null,
      menuAction: null,
      directLabel: null,
      derivative: true,
      detail: 'The source recording is no longer in Library.'
    })
  })

  it('turns failed and cancelled jobs into retry with stable backend detail', () => {
    expect(
      derive({
        job: job({
          status: 'failed',
          errorCode: 'noise-cleanup-no-audio',
          errorMessage: 'This recording has no microphone audio.'
        })
      })
    ).toMatchObject({
      directAction: 'start',
      directLabel: 'Retry cleanup',
      detail: 'This recording has no microphone audio.'
    })
    expect(derive({ job: job({ status: 'cancelled' }) }).directLabel).toBe('Retry cleanup')
  })

  it('keeps durable job selection monotonic across row unmounts and stale events', () => {
    const queued = job()
    const processing = job({
      status: 'processing',
      progressPercent: 20,
      updatedAt: '2026-07-13T10:00:02.000Z'
    })
    const stale = job({ updatedAt: '2026-07-13T10:00:00.500Z' })
    const other = job({
      id: 'cleanup-2',
      sourceSessionId: 'session-2',
      updatedAt: '2026-07-13T10:00:03.000Z'
    })

    const jobs = upsertNoiseCleanupJob(
      upsertNoiseCleanupJob(upsertNoiseCleanupJob([queued], processing), stale),
      other
    )
    expect(latestNoiseCleanupJobForSession(jobs, 'session-1')).toEqual(processing)
    expect(latestNoiseCleanupJobForSession(jobs, 'session-2')).toEqual(other)
  })

  it('protects only sources with active cleanup jobs from bulk file actions', () => {
    const activeSources = activeNoiseCleanupSourceIds([
      job({ status: 'queued' }),
      job({ id: 'cleanup-2', sourceSessionId: 'session-2', status: 'processing' }),
      job({ id: 'cleanup-3', sourceSessionId: 'session-3', status: 'validating' }),
      job({ id: 'cleanup-4', sourceSessionId: 'session-4', status: 'completed' }),
      job({ id: 'cleanup-5', sourceSessionId: 'session-5', status: 'failed' }),
      job({ id: 'cleanup-6', sourceSessionId: 'session-6', status: 'cancelled' })
    ])

    expect([...activeSources]).toEqual(['session-1', 'session-2', 'session-3'])
  })

  it('only confirms cancellation after the backend returns cancelled', () => {
    expect(noiseCleanupCancellationNotice(job({ status: 'cancelled' }))).toEqual({
      title: 'Noise cleanup cancelled',
      description: 'The original recording was not changed.'
    })
    for (const status of ['queued', 'processing', 'validating'] as const) {
      expect(noiseCleanupCancellationNotice(job({ status }))).toEqual({
        title: 'Cancellation requested',
        description:
          'Noise cleanup is still stopping. Its status will update when cancellation finishes.'
      })
    }
  })

  it('disables backend start while reconnecting', () => {
    const connectedView = derive()
    expect(connectedView.directAction).toBe('start')

    expect(withNoiseCleanupConnectionState(connectedView, false)).toMatchObject({
      directAction: null,
      menuAction: 'start',
      directLabel: 'Clean noise',
      disabledReason: 'Videorc is reconnecting. Try again in a moment.'
    })
    expect(withNoiseCleanupConnectionState(connectedView, true)).toBe(connectedView)
  })

  it('keeps browser upgrade and local cleaned-copy actions available while offline', () => {
    const upgrade = derive({ entitlements: DEFAULT_BASIC_ENTITLEMENTS })
    const completed = derive({
      job: job({
        status: 'completed',
        progressPercent: 100,
        outputSessionId: 'cleaned-session'
      })
    })

    expect(upgrade.directAction).toBe('upgrade')
    expect(withNoiseCleanupConnectionState(upgrade, false)).toBe(upgrade)
    expect(completed.directAction).toBe('open-output')
    expect(withNoiseCleanupConnectionState(completed, false)).toBe(completed)
  })
})
