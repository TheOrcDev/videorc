import type {
  CohostAutoChat,
  CohostAutoChatRelayPatch,
  CohostEnableCommand,
  CohostErrorDetail,
  CohostQuestion,
  CohostReason,
  CohostSettings,
  CohostSettingsPatch,
  CohostState
} from './backend'

// The co-host helpers the studio provider needs at startup. Kept apart from
// cohost-view.ts (which re-exports them) so the pane-only view code stays out
// of the eager renderer bundle.

/**
 * The Buddy Live switch's save (plan 174 S3.14a, D7): `enabled` and nothing
 * else. Listening (the microphone) is its own choice with its own disclosure,
 * asked by the "Buddy hears you" switch on the Buddy page and the Stream
 * Manager's listening card, never by this one; the chat posting mode is its
 * own control too. The Buddy page's consent dialog writes this patch after
 * granting consent; a Stream Manager command goes through
 * `cohostEnableRelayPatch` instead.
 */
export function buddyLiveSettingsPatch(on: boolean): CohostSettingsPatch {
  return { enabled: on }
}

/**
 * The save one Stream Manager enable command makes (plan 174 S0.2, S3.14a).
 * The relay never adds listening on its own:
 *
 * - `enabled` is written only when the command changes it, so a behaviour
 *   command (the posting mode, a chip) saves `{autoChat}` alone and never
 *   turns Buddy, or its microphone, back on.
 * - `listen: true` is written only when the command names it and Buddy is on
 *   after the save, and only in the command that turns Buddy on (off to on)
 *   or one that carries `grantListen` (the listening card, plan 068 D3,
 *   while Buddy already runs). A later `listen` without the grant is dropped,
 *   so no on-path grants the microphone by accident. Off leaves listening as
 *   it was.
 *
 * An empty patch means nothing to save: the caller answers with what it has.
 */
export function cohostEnableRelayPatch(
  current: Pick<CohostSettings, 'enabled'> | null,
  command: Pick<CohostEnableCommand, 'enabled' | 'listen' | 'grantListen'>,
  autoChat: CohostAutoChat | null
): CohostSettingsPatch {
  const patch: CohostSettingsPatch = {}
  if (!current || current.enabled !== command.enabled) patch.enabled = command.enabled
  const turningOn = command.enabled && !current?.enabled
  if (command.enabled && command.listen === true && (turningOn || command.grantListen === true)) {
    patch.listen = true
  }
  if (autoChat) patch.autoChat = autoChat
  return patch
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
 * change only those fields: the templates and cooldowns the Buddy tab holds
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
  'premium-required': 'Buddy stopped: Videorc Premium is required.',
  'consent-required': 'Buddy stopped: cloud AI consent is off.',
  'session-expired': 'Buddy stopped: your Videorc sign-in expired.',
  'signed-out': 'Buddy stopped: sign in to Videorc to use it.',
  'quota-exhausted': 'Buddy paused: daily AI quota is used up.',
  'server-unconfigured': 'Buddy stopped: Videorc AI is unavailable right now.',
  network: 'Buddy stopped: no connection to Videorc AI.',
  'gateway-error': 'Buddy stopped: Videorc AI returned an error.'
}

/**
 * Toast copy with the server's words attached:
 * "Buddy stopped: Videorc AI returned an error (ai-gateway-error: The
 * Buddy tick failed on every configured model)." The HTTP status stays in
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
  'premium-required': 'Buddy stopped. Premium ended.',
  'signed-out': 'Buddy stopped. You signed out.'
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
