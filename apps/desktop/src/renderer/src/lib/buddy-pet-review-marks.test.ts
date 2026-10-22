import { describe, expect, it } from 'vitest'

import {
  BUDDY_PET_REVIEW_MARKS_STORAGE_KEY,
  forgetBuddyPetReviewMarks,
  readBuddyPetReviewMarks,
  writeBuddyPetReviewMarks
} from './buddy-pet-review-marks'

function memory(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    length: 0
  }
}

const BUILD = '5f0c2a8e-3b1d-4c6e-9a7f-2d8b1e4c6a90'

describe('persisted review marks (plan 174 S3.15a)', () => {
  it('remembers the marks of the one open creation and forgets them with it', () => {
    const storage = memory()
    expect(readBuddyPetReviewMarks(storage)).toEqual({})
    writeBuddyPetReviewMarks(BUILD, { extras: 1, 'gaze-up2': 2 }, storage)
    expect(readBuddyPetReviewMarks(storage)).toEqual({ [BUILD]: { extras: 1, 'gaze-up2': 2 } })
    // A new build replaces the earlier one's marks.
    writeBuddyPetReviewMarks('other', { extras: 1 }, storage)
    expect(readBuddyPetReviewMarks(storage)).toEqual({ other: { extras: 1 } })
    forgetBuddyPetReviewMarks('other', storage)
    expect(readBuddyPetReviewMarks(storage)).toEqual({})
    expect(storage.getItem(BUDDY_PET_REVIEW_MARKS_STORAGE_KEY)).toBeNull()
  })

  it('drops anything that is not a row version, and survives bad or blocked storage', () => {
    const odd = memory({
      [BUDDY_PET_REVIEW_MARKS_STORAGE_KEY]: JSON.stringify({
        [BUILD]: { extras: 1, 'reactions-a': 'yes', pilot: 0, nested: { a: 1 } },
        list: [1, 2],
        text: 'nope'
      })
    })
    expect(readBuddyPetReviewMarks(odd)).toEqual({ [BUILD]: { extras: 1 } })
    expect(readBuddyPetReviewMarks(memory({ [BUDDY_PET_REVIEW_MARKS_STORAGE_KEY]: '{' }))).toEqual(
      {}
    )
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      }
    }
    expect(() => writeBuddyPetReviewMarks(BUILD, { extras: 1 }, blocked)).not.toThrow()
    expect(readBuddyPetReviewMarks(blocked)).toEqual({})
    expect(readBuddyPetReviewMarks(null)).toEqual({})
  })
})
