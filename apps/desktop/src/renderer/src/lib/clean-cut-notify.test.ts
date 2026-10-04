// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CleanCutJob } from './backend'
import { OPEN_CLEAN_CUT_EVENT, readCleanCutOpenRequest } from './clean-cut-events'
import {
  CLEAN_CUT_ANNOUNCED_STORAGE_KEY,
  announceCleanCutReady,
  cleanCutAnnouncementKey,
  resetCleanCutAnnouncements
} from './clean-cut-notify'

const toastMock = vi.hoisted(() => ({ success: vi.fn() }))
vi.mock('./toast', () => ({ toast: toastMock }))

function job(overrides: Partial<CleanCutJob> = {}): CleanCutJob {
  return {
    id: 'job-1',
    sourceSessionId: 'rec-1',
    mode: 'clean',
    state: 'completed',
    progress: 1,
    edlRevision: 0,
    edlSummary: { durationMs: 2_530_000, keptMs: 1_865_000, removalCount: 63, byKind: [] },
    outputSessionId: 'out-1',
    createdAt: '2026-10-03T15:00:00Z',
    updatedAt: '2026-10-03T15:10:00Z',
    ...overrides
  }
}

function storage(): {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  values: Record<string, string>
} {
  const values: Record<string, string> = {}
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    }
  }
}

beforeEach(() => {
  resetCleanCutAnnouncements()
  toastMock.success.mockClear()
})

describe('the ready toast (plan 119 S15)', () => {
  it('says the clean cut is ready, with both lengths and Review', () => {
    expect(announceCleanCutReady(job(), storage())).toBe(true)
    expect(toastMock.success).toHaveBeenCalledWith(
      'Your clean cut is ready (42:10 → 31:05)',
      expect.objectContaining({
        id: 'clean-cut-ready-job-1',
        description: 'The original is kept.',
        action: expect.objectContaining({ label: 'Review' })
      })
    )
  })

  it('fires once per job id per revision', () => {
    const ledger = storage()
    expect(announceCleanCutReady(job(), ledger)).toBe(true)
    expect(announceCleanCutReady(job(), ledger)).toBe(false)
    // A reload reads the ledger.
    resetCleanCutAnnouncements()
    expect(announceCleanCutReady(job(), ledger)).toBe(false)
    // A re-render after edits is news again.
    expect(announceCleanCutReady(job({ edlRevision: 1 }), ledger)).toBe(true)
    expect(JSON.parse(ledger.values[CLEAN_CUT_ANNOUNCED_STORAGE_KEY])).toEqual([
      'job-1:0',
      'job-1:1'
    ])
    expect(toastMock.success).toHaveBeenCalledTimes(2)
    expect(cleanCutAnnouncementKey(job({ id: 'x', edlRevision: 4 }))).toBe('x:4')
  })

  it('stays quiet for anything but a completed cut', () => {
    expect(announceCleanCutReady(job({ state: 'rendering' }), storage())).toBe(false)
    expect(
      announceCleanCutReady(job({ state: 'failed', errorCode: 'x', errorMessage: 'y' }), storage())
    ).toBe(false)
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it('works without storage', () => {
    expect(announceCleanCutReady(job({ id: 'no-storage' }), null)).toBe(true)
    expect(announceCleanCutReady(job({ id: 'no-storage' }), null)).toBe(false)
  })

  it("opens that job's review from Review", () => {
    announceCleanCutReady(job({ mode: 'condensed' }), storage())
    const [title, options] = toastMock.success.mock.calls[0] as [
      string,
      { action: { onClick: () => void } }
    ]
    expect(title).toBe('Your condensed cut is ready (42:10 → 31:05)')
    const heard: unknown[] = []
    const listener = (event: Event): void => {
      heard.push(readCleanCutOpenRequest((event as CustomEvent).detail))
    }
    window.addEventListener(OPEN_CLEAN_CUT_EVENT, listener)
    options.action.onClick()
    window.removeEventListener(OPEN_CLEAN_CUT_EVENT, listener)
    expect(heard).toEqual([{ sessionId: 'rec-1', jobId: 'job-1', mode: 'condensed', review: true }])
  })
})

describe('readCleanCutOpenRequest', () => {
  it('reads what the event carries and ignores anything else', () => {
    expect(readCleanCutOpenRequest(null)).toBeNull()
    expect(readCleanCutOpenRequest({ sessionId: '' })).toBeNull()
    expect(readCleanCutOpenRequest({ sessionId: 'rec-1', mode: 'tight', review: 'yes' })).toEqual({
      sessionId: 'rec-1',
      jobId: undefined,
      mode: undefined,
      review: false
    })
  })
})
