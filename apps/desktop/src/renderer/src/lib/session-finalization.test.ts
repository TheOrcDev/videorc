import { describe, expect, it } from 'vitest'

import {
  applyFinalizationEvent,
  finalizationEventNeedsRefresh,
  finalizationFailed,
  finalizingBadgeLabel,
  isFinalizingSession
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

  it('asks for a refresh only when a finalized row is not loaded', () => {
    const event = { sessionId: 's-3', state: 'finalized' as const, updatedAt: 't' }
    expect(finalizationEventNeedsRefresh([row()], event)).toBe(true)
    expect(finalizationEventNeedsRefresh([row({ id: 's-3' })], event)).toBe(false)
    expect(finalizationEventNeedsRefresh([row()], { ...event, state: 'finalizing' })).toBe(false)
  })
})
