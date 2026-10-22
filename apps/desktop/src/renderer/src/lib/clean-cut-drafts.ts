import { useSyncExternalStore } from 'react'

import type { CleanCutMode } from './backend'
import type { CleanCutOrigin, CleanCutTabRequest } from './clean-cut-events'
import { EMPTY_CLEAN_CUT_DRAFT, draftChangeCount, type CleanCutDraft } from './clean-cut-review'

// Plan 174 S3.13 (E-5): unsaved Clean cut edits survive every way out of the
// review. Drafts are kept per job and on this device, so a tab switch, a page
// switch, another review or the window closing never loses one; only Save,
// Discard, or "Discard changes" in the leave guard drops it. The open review
// lives here too, outside the Buddy page, so a page switch comes back to it.
// Loaded with the Buddy page, never on the startup path.

/** Which cut the review opens. */
export interface CleanCutReviewTarget {
  sessionId: string
  mode: CleanCutMode
  jobId: string | null
  /** Opened from the Library: the back button returns to its row. */
  origin?: CleanCutOrigin
}

// --- Drafts ---------------------------------------------------------------------

export const CLEAN_CUT_DRAFTS_STORAGE_KEY = 'videorc.cleanCutDrafts'
/** Jobs whose drafts are kept, newest last. */
export const CLEAN_CUT_DRAFTS_MAX = 20

/** A draft as JSON: the Map and Sets as arrays. */
export interface StoredCleanCutDraft {
  jobId: string
  toggles: Array<[string, boolean]>
  addManual: Array<{ key: string; startMs: number; endMs: number }>
  removeManual: string[]
  nextKey: number
}

export function serializeCleanCutDraft(jobId: string, draft: CleanCutDraft): StoredCleanCutDraft {
  return {
    jobId,
    toggles: [...draft.toggles],
    addManual: draft.addManual.map(({ key, startMs, endMs }) => ({ key, startMs, endMs })),
    removeManual: [...draft.removeManual],
    nextKey: draft.nextKey
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** One stored draft, read loosely: anything malformed is dropped, never thrown. */
export function parseStoredCleanCutDraft(value: unknown): StoredCleanCutDraft | null {
  if (!value || typeof value !== 'object') return null
  const fields = value as Record<string, unknown>
  if (typeof fields.jobId !== 'string' || !fields.jobId) return null
  const toggles = Array.isArray(fields.toggles)
    ? fields.toggles.filter(
        (entry): entry is [string, boolean] =>
          Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean'
      )
    : []
  const addManual = Array.isArray(fields.addManual)
    ? fields.addManual.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== 'object') return []
        const { key, startMs, endMs } = entry as Record<string, unknown>
        return typeof key === 'string' && finite(startMs) && finite(endMs) && endMs > startMs
          ? [{ key, startMs, endMs }]
          : []
      })
    : []
  const removeManual = Array.isArray(fields.removeManual)
    ? fields.removeManual.filter((id): id is string => typeof id === 'string')
    : []
  const nextKey = finite(fields.nextKey) && fields.nextKey >= 1 ? Math.floor(fields.nextKey) : 1
  return { jobId: fields.jobId, toggles, addManual, removeManual, nextKey }
}

export function cleanCutDraftFromStored(stored: StoredCleanCutDraft): CleanCutDraft {
  return {
    toggles: new Map(stored.toggles),
    addManual: stored.addManual,
    removeManual: new Set(stored.removeManual),
    nextKey: stored.nextKey
  }
}

/** The stored list, newest last; anything unreadable reads as empty. */
export function parseStoredCleanCutDrafts(raw: string | null | undefined): StoredCleanCutDraft[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      const draft = parseStoredCleanCutDraft(entry)
      return draft ? [draft] : []
    })
  } catch {
    return []
  }
}

/**
 * The list with this job's draft put last, or taken out when it is empty, and
 * at most `max` jobs kept.
 */
export function withStoredCleanCutDraft(
  drafts: readonly StoredCleanCutDraft[],
  jobId: string,
  draft: CleanCutDraft,
  max: number = CLEAN_CUT_DRAFTS_MAX
): StoredCleanCutDraft[] {
  const others = drafts.filter((entry) => entry.jobId !== jobId)
  if (draftChangeCount(draft) === 0) return others
  return [...others, serializeCleanCutDraft(jobId, draft)].slice(-max)
}

export interface CleanCutDraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

function browserStorage(): CleanCutDraftStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

// Read once per window; every write goes to storage at once, so a window that
// closes mid-edit keeps the last change.
let drafts: StoredCleanCutDraft[] | null = null
let storageOverride: CleanCutDraftStorage | null | undefined

function storage(): CleanCutDraftStorage | null {
  return storageOverride === undefined ? browserStorage() : storageOverride
}

function loadedDrafts(): StoredCleanCutDraft[] {
  if (drafts) return drafts
  try {
    drafts = parseStoredCleanCutDrafts(storage()?.getItem(CLEAN_CUT_DRAFTS_STORAGE_KEY))
  } catch {
    drafts = []
  }
  return drafts
}

/** The job's kept draft, or the empty one. */
export function readCleanCutDraft(jobId: string): CleanCutDraft {
  const stored = loadedDrafts().find((entry) => entry.jobId === jobId)
  return stored ? cleanCutDraftFromStored(stored) : EMPTY_CLEAN_CUT_DRAFT
}

/** How many unsaved changes the job's kept draft holds. */
export function cleanCutDraftChanges(jobId: string): number {
  return draftChangeCount(readCleanCutDraft(jobId))
}

/** Keeps the job's draft (an empty one is forgotten). */
export function writeCleanCutDraft(jobId: string, draft: CleanCutDraft): void {
  const current = loadedDrafts()
  const known = current.some((entry) => entry.jobId === jobId)
  if (!known && draftChangeCount(draft) === 0) return
  drafts = withStoredCleanCutDraft(current, jobId, draft)
  try {
    storage()?.setItem(CLEAN_CUT_DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // Storage unavailable: the draft still survives in this window.
  }
}

// --- The open review --------------------------------------------------------------

let openReview: CleanCutReviewTarget | null = null
const appliedRequests = new WeakSet<CleanCutTabRequest>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function openCleanCutReview(target: CleanCutReviewTarget): void {
  openReview = target
  emit()
}

export function closeCleanCutReview(): void {
  if (!openReview) return
  openReview = null
  emit()
}

export function useOpenCleanCutReview(): CleanCutReviewTarget | null {
  return useSyncExternalStore(subscribe, () => openReview)
}

/** The review an ask opens: a review ask opens its cut, any other closes the review. */
export function cleanCutReviewTargetOf(request: CleanCutTabRequest): CleanCutReviewTarget | null {
  if (!request.review) return null
  return {
    sessionId: request.sessionId,
    mode: request.mode ?? 'clean',
    jobId: request.jobId ?? null,
    ...(request.origin ? { origin: request.origin } : {})
  }
}

/** The ask not applied yet, or null: each ask from the shell applies once. */
export function pendingCleanCutRequest(
  request: CleanCutTabRequest | null
): CleanCutTabRequest | null {
  return request && !appliedRequests.has(request) ? request : null
}

/** Applies the ask once: opens its review, or closes the open one (its draft stays kept). */
export function applyCleanCutRequest(request: CleanCutTabRequest): void {
  if (appliedRequests.has(request)) return
  appliedRequests.add(request)
  const target = cleanCutReviewTargetOf(request)
  if (target) openCleanCutReview(target)
  else closeCleanCutReview()
}

/** Tests only: a fresh window, with `storage` in place of localStorage. */
export function resetCleanCutDraftsForTests(storageForTests?: CleanCutDraftStorage | null): void {
  drafts = null
  storageOverride = storageForTests
  openReview = null
}
