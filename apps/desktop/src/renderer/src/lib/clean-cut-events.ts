import type { CleanCutMode } from './backend'

// The one way into Clean cut from outside the Orcle tab (plan 119 S14, S15):
// the ready toast and the Library dispatch this, and app-shell opens the
// Orcle tab on it. Kept tiny because app-shell is on the eager path.

export const OPEN_CLEAN_CUT_EVENT = 'videorc:open-clean-cut'

export interface CleanCutOpenRequest {
  /** The source recording. */
  sessionId: string
  /** The job to open, when one is meant (the ready toast). */
  jobId?: string
  mode?: CleanCutMode
  /** Open the review, not just the card on that recording. */
  review?: boolean
}

/** What app-shell hands the Orcle tab; a new nonce re-applies the same ask. */
export type CleanCutTabRequest = CleanCutOpenRequest & { nonce: number }

export function openCleanCut(request: CleanCutOpenRequest): void {
  window.dispatchEvent(new CustomEvent(OPEN_CLEAN_CUT_EVENT, { detail: request }))
}

/** The request an event carries, or null when it is not one. */
export function readCleanCutOpenRequest(detail: unknown): CleanCutOpenRequest | null {
  if (!detail || typeof detail !== 'object') return null
  const fields = detail as Record<string, unknown>
  if (typeof fields.sessionId !== 'string' || fields.sessionId.length === 0) return null
  return {
    sessionId: fields.sessionId,
    jobId: typeof fields.jobId === 'string' && fields.jobId ? fields.jobId : undefined,
    mode: fields.mode === 'clean' || fields.mode === 'condensed' ? fields.mode : undefined,
    review: fields.review === true
  }
}
