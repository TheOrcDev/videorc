import type {
  CohostAutoChat,
  CohostAutoChatRelayPatch,
  CohostErrorDetail,
  CohostQuestion,
  CohostReason,
  CohostSettingsPatch,
  CohostState
} from './backend'

// The co-host helpers the studio provider needs at startup. Kept apart from
// cohost-view.ts (which re-exports them) so the pane-only view code stays out
// of the eager renderer bundle.

/**
 * Golem Live's one switch (plan 119): on means Golem reads chat AND hears you,
 * in one save; off only stops Golem joining and leaves listening as it was.
 * The Golem tab and every Comments-window way on write this one patch.
 */
export function golemLiveSettingsPatch(on: boolean): CohostSettingsPatch {
  return on ? { enabled: true, listen: true } : { enabled: false }
}

/** The stored `autoChat` when none has been loaded yet: everything off. */
export const DEFAULT_COHOST_AUTO_CHAT: CohostAutoChat = {
  mode: 'off',
  greetings: { enabled: false, templates: [] },
  answers: { enabled: false, cooldownSeconds: 20 },
  banter: { enabled: false, cooldownSeconds: 240 }
}

/**
 * The Stream Manager's mode control and behaviour switches (plan 164 S-D6)
 * change only those fields: the templates and cooldowns the Golem tab holds
 * ride along unchanged, so the save never drops them.
 */
export function mergeAutoChatRelayPatch(
  current: CohostAutoChat | null,
  patch: CohostAutoChatRelayPatch
): CohostAutoChat {
  const base = current ?? DEFAULT_COHOST_AUTO_CHAT
  return {
    mode: patch.mode ?? base.mode,
    greetings: { ...base.greetings, enabled: patch.greetings ?? base.greetings.enabled },
    answers: { ...base.answers, enabled: patch.answers ?? base.answers.enabled },
    banter: { ...base.banter, enabled: patch.banter ?? base.banter.enabled }
  }
}

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
  if (next.tickSeq < current.tickSeq) return current
  // Plan 140: a voice command moves without a tick. An RPC reply can cross a
  // newer `cohost.state` event, so the newer command (by `at`) always wins.
  const kept = current.command
  if (kept && (!next.command || Date.parse(next.command.at) < Date.parse(kept.at))) {
    return { ...next, command: kept }
  }
  return next
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
  'premium-required': 'Golem stopped: Videorc Premium is required.',
  'consent-required': 'Golem stopped: cloud AI consent is off.',
  'session-expired': 'Golem stopped: your Videorc sign-in expired.',
  'signed-out': 'Golem stopped: sign in to Videorc to use it.',
  'quota-exhausted': 'Golem paused: daily AI quota is used up.',
  'server-unconfigured': 'Golem stopped: Videorc AI is unavailable right now.',
  network: 'Golem stopped: no connection to Videorc AI.',
  'gateway-error': 'Golem stopped: Videorc AI returned an error.'
}

/**
 * Toast copy with the server's words attached:
 * "Golem stopped: Videorc AI returned an error (ai-gateway-error: The
 * Golem tick failed on every configured model)." The HTTP status stays in
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

// --- Stopped toast (plan 140 S1) --------------------------------------------

/**
 * Why the backend ended a running session on its own: Premium lapsed
 * mid-stream, or the account signed out. Plain copy; the toast is untinted.
 * Every other `off` state (a streamer's own Stop, the session ending) has no
 * reason and no toast.
 */
export const COHOST_STOPPED_TOAST_MESSAGES: Partial<Record<CohostReason, string>> = {
  'premium-required': 'Golem stopped. Premium ended.',
  'signed-out': 'Golem stopped. You signed out.'
}

/**
 * The one line for a session the backend stopped: `off` with a reason, after a
 * state that was running (listening, paused or in error). Returns null for
 * the first state the renderer sees and for every ordinary off.
 */
export function cohostStoppedToast(previous: CohostState | null, next: CohostState): string | null {
  if (next.status !== 'off' || !next.reason) return null
  if (!previous || previous.status === 'off') return null
  return COHOST_STOPPED_TOAST_MESSAGES[next.reason] ?? null
}
