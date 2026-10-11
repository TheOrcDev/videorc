import { beforeEach, describe, expect, it } from 'vitest'

import {
  CLEAN_CUT_DRAFTS_MAX,
  CLEAN_CUT_DRAFTS_STORAGE_KEY,
  cleanCutDraftChanges,
  cleanCutReviewTargetOf,
  parseStoredCleanCutDrafts,
  readCleanCutDraft,
  resetCleanCutDraftsForTests,
  serializeCleanCutDraft,
  withStoredCleanCutDraft,
  writeCleanCutDraft,
  type CleanCutDraftStorage
} from './clean-cut-drafts'
import { EMPTY_CLEAN_CUT_DRAFT, type CleanCutDraft } from './clean-cut-review'

const DRAFT: CleanCutDraft = {
  toggles: new Map([
    ['r2', false],
    ['r4', true]
  ]),
  addManual: [{ key: 'draft:1', startMs: 1_000, endMs: 2_000 }],
  removeManual: new Set(['m1']),
  nextKey: 2
}

function memoryStorage(): CleanCutDraftStorage & { values: Record<string, string> } {
  const values: Record<string, string> = {}
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    }
  }
}

beforeEach(() => resetCleanCutDraftsForTests(null))

describe('Clean cut drafts (plan 174 S3.13, E-5)', () => {
  it('round-trips a draft through storage, and survives a new window', () => {
    const storage = memoryStorage()
    resetCleanCutDraftsForTests(storage)
    writeCleanCutDraft('job-1', DRAFT)
    expect(cleanCutDraftChanges('job-1')).toBe(4)
    // The window closed; the next one reads it back.
    resetCleanCutDraftsForTests(storage)
    const restored = readCleanCutDraft('job-1')
    expect([...restored.toggles]).toEqual([...DRAFT.toggles])
    expect(restored.addManual).toEqual(DRAFT.addManual)
    expect([...restored.removeManual]).toEqual(['m1'])
    expect(restored.nextKey).toBe(2)
  })

  it('forgets an empty draft, and reads an unknown job as empty', () => {
    const storage = memoryStorage()
    resetCleanCutDraftsForTests(storage)
    writeCleanCutDraft('job-1', DRAFT)
    writeCleanCutDraft('job-1', EMPTY_CLEAN_CUT_DRAFT)
    expect(parseStoredCleanCutDrafts(storage.values[CLEAN_CUT_DRAFTS_STORAGE_KEY])).toEqual([])
    expect(readCleanCutDraft('job-2')).toBe(EMPTY_CLEAN_CUT_DRAFT)
  })

  it('keeps the newest jobs only', () => {
    let list = withStoredCleanCutDraft([], 'job-0', DRAFT)
    for (let index = 1; index <= CLEAN_CUT_DRAFTS_MAX; index += 1) {
      list = withStoredCleanCutDraft(list, `job-${index}`, DRAFT)
    }
    expect(list).toHaveLength(CLEAN_CUT_DRAFTS_MAX)
    expect(list[0]?.jobId).toBe('job-1')
    // A job written again moves to the end.
    list = withStoredCleanCutDraft(list, 'job-1', DRAFT)
    expect(list.at(-1)?.jobId).toBe('job-1')
  })

  it('reads damaged storage loosely, never throwing', () => {
    expect(parseStoredCleanCutDrafts('not json')).toEqual([])
    expect(parseStoredCleanCutDrafts('{"jobId":"x"}')).toEqual([])
    const good = serializeCleanCutDraft('job-1', DRAFT)
    const raw = JSON.stringify([
      { jobId: '' },
      { ...good, toggles: [['r2', false], ['bad'], 7], addManual: [{ key: 'k', startMs: 5 }] }
    ])
    expect(parseStoredCleanCutDrafts(raw)).toEqual([
      { ...good, toggles: [['r2', false]], addManual: [] }
    ])
  })

  it('works without storage, for this window', () => {
    resetCleanCutDraftsForTests({
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    })
    writeCleanCutDraft('job-1', DRAFT)
    expect(cleanCutDraftChanges('job-1')).toBe(4)
  })

  it('opens the review a Review ask names, and none for a plain ask', () => {
    expect(
      cleanCutReviewTargetOf({ sessionId: 'rec-1', review: true, origin: 'library', nonce: 1 })
    ).toEqual({ sessionId: 'rec-1', mode: 'clean', jobId: null, origin: 'library' })
    expect(cleanCutReviewTargetOf({ sessionId: 'rec-1', nonce: 2 })).toBeNull()
  })
})
