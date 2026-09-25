import type { CohostFlag, CohostSpotlight, CohostState } from './backend'

// Orcle's marks on chat rows (flag, suggested, talking about this). Only the
// Stream Manager reads them, so they live apart from cohost-view.ts: that
// module is in the main window's eager bundle, this one is not.

export interface CohostCommentMarks {
  /** Flag per flagged message id. */
  flags: ReadonlyMap<string, CohostFlag>
  /** Message ids the co-host suggests showing on stream. */
  suggested: ReadonlySet<string>
  /** The message the streamer is talking about (plan 060 pull-up), or null. */
  spotlight: string | null
}

export const EMPTY_COHOST_COMMENT_MARKS: CohostCommentMarks = {
  flags: new Map(),
  suggested: new Set(),
  spotlight: null
}

/** The unexpired spotlight, or null. The engine clears it on expiry; this
 * keeps a surface from holding a stale one between two events. */
export function activeCohostSpotlight(
  state: CohostState | null,
  nowMs: number = Date.now()
): CohostSpotlight | null {
  const spotlight = state && state.status !== 'off' ? state.spotlight : undefined
  if (!spotlight || !(Date.parse(spotlight.expiresAt) > nowMs)) return null
  return spotlight
}

/** What the message list needs from `cohost.state`. A flagged message is never
 * also suggested or spotlit (the backend enforces it; this keeps the row
 * honest anyway). */
export function cohostCommentMarks(
  state: CohostState | null,
  nowMs: number = Date.now()
): CohostCommentMarks {
  if (!state || state.status === 'off') return EMPTY_COHOST_COMMENT_MARKS
  const highlights = state.highlights ?? []
  const spotlight = activeCohostSpotlight(state, nowMs)?.messageId ?? null
  if (state.flags.length === 0 && highlights.length === 0 && !spotlight) {
    return EMPTY_COHOST_COMMENT_MARKS
  }
  const flags = new Map(state.flags.map((flag) => [flag.messageId, flag]))
  const suggested = new Set(
    highlights.map((highlight) => highlight.messageId).filter((id) => !flags.has(id))
  )
  return { flags, suggested, spotlight: spotlight && !flags.has(spotlight) ? spotlight : null }
}
