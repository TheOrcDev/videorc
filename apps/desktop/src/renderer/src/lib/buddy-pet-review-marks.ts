import type { BuddyPetReviewMarks } from './buddy-pet-creator-view'

// The Alive creator's "Looks right" marks, kept on this device (plan 174
// S3.15a, the review-marks owner item): a creation survives closing the
// wizard and the app, so its marks do too, by build id. A mark names the
// row's version, so a redone row reads as unmarked until it is marked again.

export const BUDDY_PET_REVIEW_MARKS_STORAGE_KEY = 'videorc.buddyPetReviewMarks'

type MarksByBuild = Record<string, BuddyPetReviewMarks>

function localStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Only marks shaped as stored (row → version number) come back; anything odd is dropped. */
function sanitize(parsed: unknown): MarksByBuild {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const result: MarksByBuild = {}
  for (const [buildId, marks] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof marks !== 'object' || marks === null || Array.isArray(marks)) continue
    const clean: Record<string, number> = {}
    for (const [row, version] of Object.entries(marks as Record<string, unknown>)) {
      if (typeof version === 'number' && Number.isInteger(version) && version > 0) {
        clean[row] = version
      }
    }
    result[buildId] = clean as BuddyPetReviewMarks
  }
  return result
}

export function readBuddyPetReviewMarks(
  storage: Pick<Storage, 'getItem'> | null = localStorageOrNull()
): MarksByBuild {
  try {
    const raw = storage?.getItem(BUDDY_PET_REVIEW_MARKS_STORAGE_KEY)
    return raw ? sanitize(JSON.parse(raw) as unknown) : {}
  } catch {
    return {}
  }
}

function write(
  marksByBuild: MarksByBuild,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null
): void {
  try {
    if (Object.keys(marksByBuild).length === 0) {
      storage?.removeItem(BUDDY_PET_REVIEW_MARKS_STORAGE_KEY)
    } else {
      storage?.setItem(BUDDY_PET_REVIEW_MARKS_STORAGE_KEY, JSON.stringify(marksByBuild))
    }
  } catch {
    // Not remembering a mark is harmless: the row asks to be checked again.
  }
}

/** Best effort: blocked storage keeps the marks for this window's life only. */
export function writeBuddyPetReviewMarks(
  buildId: string,
  marks: BuddyPetReviewMarks,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = localStorageOrNull()
): MarksByBuild {
  // One creation at a time: the marks of an earlier build go with it.
  const next: MarksByBuild = { [buildId]: marks }
  write(next, storage)
  return next
}

export function forgetBuddyPetReviewMarks(
  buildId: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = localStorageOrNull()
): MarksByBuild {
  const next = { ...readBuddyPetReviewMarks(storage) }
  delete next[buildId]
  write(next, storage)
  return next
}
