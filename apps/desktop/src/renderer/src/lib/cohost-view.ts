import type {
  CohostErrorDetail,
  CohostFlag,
  CohostPriority,
  CohostQuestion,
  CohostReason,
  CohostState,
  StreamPlatform
} from './backend'
import { chatDraftMaxChars } from './chat-send'
import type { EntitlementUiGate } from './entitlement-ui'

// Live Chat Co-host — renderer view layer (plan S2). The BACKEND owns the tick
// scheduler, the open-question set, flags, mood and readiness; everything here
// is a pure derivation of the last `cohost.state` event so the pane, the
// destination chip and the detached Comments window cannot disagree.

export const EMPTY_COHOST_STATE: CohostState = {
  sessionId: null,
  status: 'off',
  reason: null,
  detail: null,
  questions: [],
  flags: [],
  mood: null,
  lastTickAt: null,
  tickSeq: 0,
  partial: false
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
  return next.tickSeq < current.tickSeq ? current : next
}

const PRIORITY_RANK: Record<CohostPriority, number> = { high: 0, normal: 1, low: 2 }

/** Highest priority first, then oldest first — the order a producer would read
 * them out. Stable on id so equal rows never swap between ticks. */
export function sortedCohostQuestions(questions: readonly CohostQuestion[]): CohostQuestion[] {
  return [...questions].sort((left, right) => {
    const priority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority]
    if (priority !== 0) return priority
    const seen = Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt)
    if (Number.isFinite(seen) && seen !== 0) return seen
    return left.id.localeCompare(right.id)
  })
}

/** Newest flag first: a producer reacts to what just happened. */
export function sortedCohostFlags(flags: readonly CohostFlag[]): CohostFlag[] {
  return [...flags].sort((left, right) => {
    const at = Date.parse(right.at) - Date.parse(left.at)
    if (Number.isFinite(at) && at !== 0) return at
    return left.messageId.localeCompare(right.messageId)
  })
}

// --- Status chip -----------------------------------------------------------

export interface CohostChipView {
  label: string
  /** Only `listening` earns the live accent; every other state is monochrome. */
  tone: 'live' | 'muted'
  /**
   * What the failed tick actually said — "ai-gateway-error (HTTP 502): The
   * co-host tick failed on every configured model." — for the chip's tooltip
   * or a secondary line. Null while listening, off, or when the engine paused
   * itself locally (signed out, Basic, consent).
   */
  detail: string | null
}

/** `state.detail` is optional on the wire (older backend); absent means null. */
export function cohostErrorDetail(state: CohostState | null): CohostErrorDetail | null {
  return state?.detail ?? null
}

function withoutTrailingPeriod(text: string): string {
  return text.trim().replace(/\.+$/, '')
}

/**
 * One line a streamer can paste into a bug report: the server's envelope code,
 * the HTTP status when there was a response, and the server's own sentence.
 */
export function cohostErrorDetailText(detail: CohostErrorDetail | null | undefined): string | null {
  if (!detail) return null
  const code = detail.code.trim()
  if (!code) return null
  const head = detail.status !== null ? `${code} (HTTP ${detail.status})` : code
  const message = detail.message.trim()
  return message ? `${head}: ${message}` : head
}

const REASON_LABELS: Record<CohostReason, string> = {
  'premium-required': 'Premium',
  'consent-required': 'consent',
  'session-expired': 'session expired',
  'signed-out': 'signed out',
  'quota-exhausted': 'quota',
  'server-unconfigured': 'unavailable',
  network: 'offline',
  'gateway-error': 'AI error'
}

export function cohostReasonLabel(reason: CohostReason | null): string | null {
  return reason ? REASON_LABELS[reason] : null
}

/** Short, honest chip copy for the destination strip. */
export function cohostChipView(state: CohostState | null): CohostChipView | null {
  if (!state) return null
  const reason = cohostReasonLabel(state.reason)
  // The engine only sets `detail` on a failed tick, and clears it the moment
  // it listens again; a stale detail on a listening/off state is never shown.
  const detail =
    state.status === 'error' || state.status === 'paused'
      ? cohostErrorDetailText(cohostErrorDetail(state))
      : null
  switch (state.status) {
    case 'off':
      return { label: 'Co-host: off', tone: 'muted', detail: null }
    case 'listening': {
      const count = state.questions.length
      return {
        label: count > 0 ? `Co-host: listening · ${count} q` : 'Co-host: listening',
        tone: 'live',
        detail: null
      }
    }
    case 'paused':
      return {
        label: reason ? `Co-host: paused · ${reason}` : 'Co-host: paused',
        tone: 'muted',
        detail
      }
    case 'error':
      return {
        label: reason ? `Co-host: error · ${reason}` : 'Co-host: error',
        tone: 'muted',
        detail
      }
  }
}

// --- Pane mode -------------------------------------------------------------

export type CohostPaneMode =
  | { kind: 'upsell'; reason: string; upgradeUrl?: string }
  | { kind: 'consent'; reason: string }
  | { kind: 'disabled'; reason: string }
  | { kind: 'live' }

/**
 * Which single-line explanation (if any) replaces the pane. Premium is checked
 * first so a Basic user never sees a consent prompt for a feature they cannot
 * run; consent is renderer-owned, so it is checked before the engine's own
 * status.
 */
export function cohostPaneMode({
  gate,
  consented,
  enabled
}: {
  gate: EntitlementUiGate
  consented: boolean
  enabled: boolean
}): CohostPaneMode {
  if (!gate.allowed) {
    return {
      kind: 'upsell',
      reason: gate.reason,
      ...(gate.upgradeUrl ? { upgradeUrl: gate.upgradeUrl } : {})
    }
  }
  if (!consented) {
    return {
      kind: 'consent',
      reason: 'Co-host reads live chat with Videorc cloud AI. Turn on cloud AI to use it.'
    }
  }
  if (!enabled) {
    return { kind: 'disabled', reason: 'Co-host is off. Turn it on in Settings.' }
  }
  return { kind: 'live' }
}

// --- Keyboard selection ----------------------------------------------------

export interface CohostRow {
  /** Stable key across ticks; also the pane's `aria-activedescendant` suffix. */
  key: string
  kind: 'question' | 'flag'
  /** Question id, or the flagged message id. */
  id: string
}

export function cohostQuestionRowKey(questionId: string): string {
  return `q:${questionId}`
}

export function cohostFlagRowKey(messageId: string): string {
  return `f:${messageId}`
}

/** One flat, ordered list — questions then flags — so ↑/↓ walks the whole pane. */
export function cohostRows(state: CohostState | null): CohostRow[] {
  if (!state) return []
  return [
    ...sortedCohostQuestions(state.questions).map((question) => ({
      key: cohostQuestionRowKey(question.id),
      kind: 'question' as const,
      id: question.id
    })),
    ...sortedCohostFlags(state.flags).map((flag) => ({
      key: cohostFlagRowKey(flag.messageId),
      kind: 'flag' as const,
      id: flag.messageId
    }))
  ]
}

/** Keeps the selection on the same row across ticks; falls back to the top row
 * when the selected one was answered, dismissed or resolved away. */
export function resolveCohostSelection(
  rows: readonly CohostRow[],
  selectedKey: string | null
): string | null {
  if (rows.length === 0) return null
  if (selectedKey && rows.some((row) => row.key === selectedKey)) return selectedKey
  return rows[0].key
}

/** ↑/↓ movement. Clamped, not wrapping: a dense producer list should not jump
 * from the last flag back to the first question under a held key. */
export function moveCohostSelection(
  rows: readonly CohostRow[],
  selectedKey: string | null,
  delta: number
): string | null {
  if (rows.length === 0) return null
  const current = rows.findIndex((row) => row.key === resolveCohostSelection(rows, selectedKey))
  const next = Math.min(rows.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta))
  return rows[next].key
}

export function cohostRowAt(
  rows: readonly CohostRow[],
  selectedKey: string | null
): CohostRow | null {
  const key = resolveCohostSelection(rows, selectedKey)
  return rows.find((row) => row.key === key) ?? null
}

// --- Reply drafts ----------------------------------------------------------

/** Trim to a hard character cap without cutting a word in half when a clean
 * break is close to the end. The streamer still edits before sending. */
export function trimDraftToCap(text: string, cap: number): string {
  const trimmed = text.trim()
  if (cap <= 0) return ''
  if (trimmed.length <= cap) return trimmed
  const sliced = trimmed.slice(0, cap)
  const lastSpace = sliced.lastIndexOf(' ')
  const wordSafe = lastSpace > cap * 0.6 ? sliced.slice(0, lastSpace) : sliced
  return wordSafe.trimEnd()
}

/** The editable draft that prefills the composer for a Reply action. */
export function draftForQuestion(
  question: Pick<CohostQuestion, 'suggestedReply'>,
  targets: readonly StreamPlatform[]
): string {
  return trimDraftToCap(question.suggestedReply, chatDraftMaxChars(targets))
}

// --- Row copy --------------------------------------------------------------

/** "Ada +3" — who is asking, without a wall of names. */
export function cohostAskersLabel(askers: readonly string[]): string {
  if (askers.length === 0) return ''
  const [first, ...rest] = askers
  return rest.length > 0 ? `${first} +${rest.length}` : first
}

/** Compact age for a dense row: "now", "4m", "2h", "1d". */
export function cohostAgeLabel(iso: string, nowMs: number = Date.now()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export const COHOST_FLAG_KIND_LABELS: Record<CohostFlag['kind'], string> = {
  toxicity: 'Toxicity',
  spam: 'Spam',
  'self-promo': 'Self-promo',
  'personal-info': 'Personal info'
}

export const COHOST_PRIORITY_LABELS: Record<CohostPriority, string> = {
  high: 'High',
  normal: 'Normal',
  low: 'Low'
}

export const COHOST_MOOD_LABELS: Record<NonNullable<CohostState['mood']>, string> = {
  hype: 'Chat is hyped',
  calm: 'Chat is calm',
  tense: 'Chat is tense',
  mixed: 'Chat is mixed'
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
  'premium-required': 'Co-host stopped: Videorc Premium is required.',
  'consent-required': 'Co-host stopped: cloud AI consent is off.',
  'session-expired': 'Co-host stopped: your Videorc sign-in expired.',
  'signed-out': 'Co-host stopped: sign in to Videorc to use it.',
  'quota-exhausted': 'Co-host paused: daily AI quota is used up.',
  'server-unconfigured': 'Co-host stopped: Videorc AI is unavailable right now.',
  network: 'Co-host stopped: no connection to Videorc AI.',
  'gateway-error': 'Co-host stopped: Videorc AI returned an error.'
}

/**
 * Toast copy with the server's words attached:
 * "Co-host stopped: Videorc AI returned an error (ai-gateway-error: The
 * co-host tick failed on every configured model)." The HTTP status stays in
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
