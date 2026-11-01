import { describe, expect, it } from 'vitest'

import {
  applyFinalizationEvent,
  FinalizationSnapshotJournal,
  finalizationEventNeedsRefresh,
  finalizationFailed,
  finalizationNoticesForRows,
  finalizingBadgeLabel,
  interruptedTakeBadge,
  isFinalizingSession,
  mayBeStartFailed,
  startFailedBadge
} from './session-finalization'

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 's-1',
  status: 'completed',
  outputPath: '/tmp/a.mkv',
  ...overrides
})

describe('session finalization helpers', () => {
  it('detects finalizing and failed rows', () => {
    expect(isFinalizingSession(row({ finalizationState: 'finalizing' }))).toBe(true)
    expect(isFinalizingSession(row())).toBe(false)
    expect(finalizationFailed(row({ finalizationState: 'failed' }))).toBe(true)
  })

  it('labels progress when known and stays indeterminate otherwise', () => {
    expect(finalizingBadgeLabel(row({ finalizationProgressPercent: 42 }))).toBe('Saving MP4 · 42%')
    expect(finalizingBadgeLabel(row())).toBe('Saving MP4…')
    expect(finalizingBadgeLabel(row({ finalizationProgressPercent: 100 }))).toBe('Saving MP4…')
  })

  it('patches the matching row in place and returns the same array otherwise', () => {
    const sessions = [row(), row({ id: 's-2' })]
    const untouched = applyFinalizationEvent(sessions, {
      sessionId: 's-9',
      state: 'finalizing',
      updatedAt: 't'
    })
    expect(untouched).toBe(sessions)

    const progressed = applyFinalizationEvent(sessions, {
      sessionId: 's-1',
      state: 'finalizing',
      progressPercent: 30,
      updatedAt: 't'
    })
    expect(progressed[0]).toMatchObject({
      finalizationState: 'finalizing',
      finalizationProgressPercent: 30
    })
    expect(progressed[1]).toBe(sessions[1])

    const finalized = applyFinalizationEvent(progressed, {
      sessionId: 's-1',
      state: 'finalized',
      mp4Path: '/tmp/a.mp4',
      durationMs: 4800,
      fileSizeBytes: 1234,
      updatedAt: 't'
    })
    expect(finalized[0]).toMatchObject({
      finalizationState: 'finalized',
      finalizationProgressPercent: undefined,
      mp4Path: '/tmp/a.mp4',
      durationMs: 4800,
      fileSizeBytes: 1234
    })

    const failed = applyFinalizationEvent(sessions, {
      sessionId: 's-1',
      state: 'failed',
      error: 'disk full',
      updatedAt: 't'
    })
    expect(failed[0]).toMatchObject({ finalizationState: 'failed', finalizationError: 'disk full' })
  })

  it('badges only a recovered interrupted take', () => {
    expect(interruptedTakeBadge(row())).toBeNull()
    expect(interruptedTakeBadge(row({ interruptionRecovery: 'failed' }))).toBeNull()
    const badge = interruptedTakeBadge(row({ interruptionRecovery: 'recovered' }))
    expect(badge?.label).toBe('Recovered')
    expect(badge?.detail).toContain('Videorc stopped during this recording')
  })

  describe('a Record start the backend refused', () => {
    const reason =
      'Cannot start: the camera preview source(s) produced no frames, so the recording would not match the preview. Re-select the source (or restart the app) and try again.'
    const refused = (overrides: Record<string, unknown> = {}) =>
      row({
        status: 'failed',
        outputPath: '/tmp/videorc-session-1.mkv',
        sessionLogCount: 1,
        ...overrides
      })
    const log = (code: string, message: string) => ({
      id: 'l-1',
      sessionId: 's-1',
      level: 'error' as const,
      code,
      message,
      createdAt: '2026-10-29T00:00:00Z'
    })
    const startFailedLog = (suffix: string) =>
      log(
        'session-start-failed',
        `Session start did not reach a running pipeline; the session was marked failed${suffix}`
      )

    it('badges the row with the reason from its log', () => {
      const badge = startFailedBadge(refused(), [startFailedLog(`: ${reason}`)])
      expect(badge).toEqual({
        label: "Didn't start",
        detail: `This recording stopped before it started, so there is no file. ${reason}`
      })
    })

    it('reads the reason from the published-terminal log as well', () => {
      const badge = startFailedBadge(refused(), [
        log('session-start-failed', `stage=Encoder reason=${reason}`)
      ])
      expect(badge?.detail).toBe(
        `This recording stopped before it started, so there is no file. ${reason}`
      )
    })

    it('says only the plain sentence when the log has no reason', () => {
      expect(startFailedBadge(refused(), [startFailedLog('.')])?.detail).toBe(
        'This recording stopped before it started, so there is no file.'
      )
      expect(startFailedBadge(refused(), [startFailedLog(':  ')])?.detail).toBe(
        'This recording stopped before it started, so there is no file.'
      )
    })

    it('leaves a failed row that has a file alone', () => {
      const logs = [startFailedLog(`: ${reason}`)]
      expect(startFailedBadge(refused({ fileSizeBytes: 4096 }), logs)).toBeNull()
      expect(startFailedBadge(refused({ mp4Path: '/tmp/a.mp4' }), logs)).toBeNull()
      expect(mayBeStartFailed(refused({ fileSizeBytes: 0 }))).toBe(false)
    })

    it('leaves completed rows and failed rows without the log alone', () => {
      const logs = [startFailedLog(`: ${reason}`)]
      expect(startFailedBadge(refused({ status: 'completed' }), logs)).toBeNull()
      expect(
        startFailedBadge(refused(), [log('encoder-stalled', 'The encoder stopped.')])
      ).toBeNull()
      expect(startFailedBadge(refused(), [])).toBeNull()
    })

    it('waits for the logs, and only asks for them on a row of that shape', () => {
      expect(startFailedBadge(refused(), undefined)).toBeNull()
      expect(mayBeStartFailed(refused())).toBe(true)
      expect(mayBeStartFailed(refused({ sessionLogCount: 0 }))).toBe(false)
      expect(mayBeStartFailed(row())).toBe(false)
    })
  })

  it('carries the recovery outcome from the finalized event onto the row', () => {
    const sessions = [row({ status: 'failed', finalizationState: 'finalizing' as const })]
    const next = applyFinalizationEvent(sessions, {
      sessionId: 's-1',
      state: 'finalized',
      mp4Path: '/tmp/a.mp4',
      durationMs: 41_666,
      interruptionRecovery: 'recovered',
      updatedAt: '2026-10-27T00:00:00Z'
    })
    expect(next[0]).toMatchObject({
      interruptionRecovery: 'recovered',
      mp4Path: '/tmp/a.mp4',
      durationMs: 41_666
    })
    expect(interruptedTakeBadge(next[0])?.label).toBe('Recovered')
  })

  it('asks for a refresh only when a finalized row is not loaded', () => {
    const event = { sessionId: 's-3', state: 'finalized' as const, updatedAt: 't' }
    expect(finalizationEventNeedsRefresh([row()], event)).toBe(true)
    expect(finalizationEventNeedsRefresh([row({ id: 's-3' })], event)).toBe(false)
    expect(finalizationEventNeedsRefresh([row()], { ...event, state: 'finalizing' })).toBe(false)
  })
})

it('keeps completion and retry events newer than an in-flight Library snapshot', () => {
  const journal = new FinalizationSnapshotJournal()
  const before = journal.checkpoint()
  journal.record({ sessionId: 's-1', state: 'finalized', mp4Path: '/tmp/a.mp4', updatedAt: 't' })
  expect(journal.reconcile([row({ finalizationState: 'finalizing' })], before)[0]).toMatchObject({
    finalizationState: 'finalized',
    mp4Path: '/tmp/a.mp4'
  })
  const retry = journal.checkpoint()
  journal.record({ sessionId: 's-1', state: 'finalizing', progressPercent: 0, updatedAt: 't2' })
  expect(
    journal.reconcile(
      [row({ finalizationState: 'failed', finalizationError: 'disk full' })],
      retry
    )[0]
  ).toMatchObject({ finalizationState: 'finalizing', finalizationError: undefined })
  const fresh = [row({ finalizationState: 'finalized' })]
  expect(journal.reconcile(fresh, journal.checkpoint())).toBe(fresh)
})

describe('finalizationNoticesForRows', () => {
  it('restores Saving MP4 after a relaunch, then says MP4 ready once', () => {
    const active = new Set<string>()
    const announced = new Set<string>()
    expect(
      finalizationNoticesForRows(
        [row({ finalizationState: 'finalizing', finalizationProgressPercent: 40 })],
        active,
        announced
      )
    ).toEqual([{ kind: 'finalizing', sessionId: 's-1', label: 'Saving MP4 · 40%' }])
    expect(
      finalizationNoticesForRows([row({ finalizationState: 'finalized' })], active, announced)
    ).toEqual([{ kind: 'ready', sessionId: 's-1' }])
    expect(
      finalizationNoticesForRows([row({ finalizationState: 'finalized' })], active, announced)
    ).toEqual([])
  })

  it('a stale finalizing row after the finalized event never reopens Saving MP4', () => {
    // E2E 2026-11-01, traced in the dev app: the `finalized` handler showed
    // "MP4 ready", then the effect of an earlier commit (row still at 98%)
    // reopened "Saving MP4 · 98%", and the settled row found the take
    // announced, so the loading toast never closed.
    const active = new Set(['s-1'])
    const announced = new Set<string>()
    // The `finalized` event handler announces the take.
    announced.add('s-1')
    expect(
      finalizationNoticesForRows(
        [row({ finalizationState: 'finalizing', finalizationProgressPercent: 98 })],
        active,
        announced
      )
    ).toEqual([])
    expect(
      finalizationNoticesForRows([row({ finalizationState: 'finalized' })], active, announced)
    ).toEqual([])
    expect(active.has('s-1')).toBe(false)
  })

  it('reports a failed export a row opened, with its error', () => {
    const active = new Set(['s-1'])
    expect(
      finalizationNoticesForRows(
        [row({ finalizationState: 'failed', finalizationError: 'disk full' })],
        active,
        new Set()
      )
    ).toEqual([{ kind: 'failed', sessionId: 's-1', error: 'disk full' }])
    expect(active.size).toBe(0)
  })
})
