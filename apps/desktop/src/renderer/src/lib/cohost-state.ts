import type { CohostErrorDetail, CohostQuestion, CohostReason, CohostState } from './backend'

// The co-host helpers the studio provider needs at startup. Kept apart from
// cohost-view.ts (which re-exports them) so the pane-only view code stays out
// of the eager renderer bundle.

/**
 * Apply a `cohost.state` event or RPC result.
 *
 * `cohost.*` RPCs return the same state shape as the event, so a dismiss reply
 * can land after a newer tick already arrived. A state for a different session
 * always wins (the engine restarted); within one session an older tick is
 * dropped. Action results reuse the current `tickSeq`, so `>=` keeps them.
 */
export function applyCohostState(current: CohostState | null, next: CohostState): CohostState {
  if (!current) return next
  if (current.sessionId !== next.sessionId) return next
  return next.tickSeq < current.tickSeq ? current : next
}

/** `state.detail` is optional on the wire (older backend); absent means null. */
export function cohostErrorDetail(state: CohostState | null): CohostErrorDetail | null {
  return state?.detail ?? null
}

function withoutTrailingPeriod(text: string): string {
  return text.trim().replace(/\.+$/, '')
}

/** The first source message is the one "Show on stream" highlights — the
 * highlight overlay renders ONE comment, and the earliest asker is the one the
 * group is named after. */
export function cohostHighlightMessageId(
  question: Pick<CohostQuestion, 'messageIds'>
): string | null {
  return question.messageIds[0] ?? null
}

// --- Error toast -----------------------------------------------------------

export interface CohostErrorToast {
  reason: CohostReason
  /** `${reason}:${detail.code}` — the dedupe identity of this failure. */
  key: string
  message: string
}

/**
 * The identity a toast is deduplicated on: the reason AND the server's error
 * code. A 502 `ai-gateway-error` followed by a 502 `upstream-timeout` is news
 * twice; the same 502 on five backoff retries is news once.
 */
export function cohostErrorToastKey(state: CohostState | null): string | null {
  if (!state || state.status !== 'error' || !state.reason) return null
  return `${state.reason}:${cohostErrorDetail(state)?.code ?? ''}`
}

export const COHOST_ERROR_TOAST_MESSAGES: Record<CohostReason, string> = {
  'premium-required': 'Orcle stopped: Videorc Premium is required.',
  'consent-required': 'Orcle stopped: cloud AI consent is off.',
  'session-expired': 'Orcle stopped: your Videorc sign-in expired.',
  'signed-out': 'Orcle stopped: sign in to Videorc to use it.',
  'quota-exhausted': 'Orcle paused: daily AI quota is used up.',
  'server-unconfigured': 'Orcle stopped: Videorc AI is unavailable right now.',
  network: 'Orcle stopped: no connection to Videorc AI.',
  'gateway-error': 'Orcle stopped: Videorc AI returned an error.'
}

/**
 * Toast copy with the server's words attached:
 * "Orcle stopped: Videorc AI returned an error (ai-gateway-error: The
 * Orcle tick failed on every configured model)." The HTTP status stays in
 * the chip tooltip — a toast is read in a second, not debugged.
 */
export function cohostErrorToastMessage(
  reason: CohostReason,
  detail: CohostErrorDetail | null | undefined
): string {
  const base = COHOST_ERROR_TOAST_MESSAGES[reason]
  const code = detail?.code.trim() ?? ''
  if (!code) return base
  const message = detail ? withoutTrailingPeriod(detail.message) : ''
  const suffix = message ? `${code}: ${message}` : code
  return `${withoutTrailingPeriod(base)} (${suffix}).`
}

/**
 * Toast discipline: the pane and the chip already show every co-host state, so
 * only a NEW failure — a new (reason, code) pair — is news. Backoff retries of
 * the same failure return null. Returns the toast to raise, or null.
 */
export function cohostErrorToast(
  previous: CohostState | null,
  next: CohostState
): CohostErrorToast | null {
  const key = cohostErrorToastKey(next)
  if (!key || !next.reason) return null
  if (previous?.status === 'error' && cohostErrorToastKey(previous) === key) return null
  return { reason: next.reason, key, message: cohostErrorToastMessage(next.reason, next.detail) }
}
